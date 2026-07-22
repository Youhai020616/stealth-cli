import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireStateLocks,
  ownsStateLock,
  retryStateLockCleanup,
  withStateLock,
} from '../../src/utils/state-lock.js';
import { getStateLocksDir, getStealthHome } from '../../src/utils/storage-paths.js';

const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-state-lock-'));
const EXTRA_TEST_HOMES = new Set();
const SPAWNED_CHILDREN = new Set();
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);
const STATE_LOCK_CHILD = path.join(FIXTURES_DIR, 'state-lock-holder-child.js');
process.env.STEALTH_HOME = TEST_STEALTH_HOME;

function stateLockPath(kind, name, root = getStealthHome()) {
  const digest = crypto.createHash('sha256').update(`${kind}:${name.toLowerCase()}`).digest('hex');
  return path.join(root, 'locks', `${digest}.lock`);
}

function journalRemovalHint(journalPath) {
  return `After confirming no stealth process is using this state, remove this exact lock journal file: ${journalPath}`;
}

function journalMaintenanceHint(journalPath) {
  return `After confirming no stealth process is using this state, archive or remove this exact lock journal file before retrying: ${journalPath}`;
}

function currentUserId() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function canonicalStateRoot(root = getStealthHome()) {
  return fs.realpathSync.native(path.resolve(root));
}

function statsWithUid(stats, uid) {
  return new Proxy(stats, {
    get(current, property) {
      if (property === 'uid') return uid;
      const value = Reflect.get(current, property);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
}

function claimRecord(kind, name, opts = {}) {
  const root = canonicalStateRoot(opts.root || getStealthHome());
  return {
    op: 'claim',
    token: opts.token || crypto.randomUUID(),
    root,
    kind,
    name: name.toLowerCase(),
    pid: opts.pid ?? process.pid,
    hostname: opts.hostname || os.hostname(),
    createdAt: opts.createdAt || new Date().toISOString(),
    ...opts.overrides,
  };
}

function releaseRecord(token, opts = {}) {
  return {
    op: 'release',
    token,
    releasedAt: opts.releasedAt || new Date().toISOString(),
    ...opts.overrides,
  };
}

function serializeRecords(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

function writeJournal(kind, name, records, opts = {}) {
  const root = path.resolve(opts.root || getStealthHome());
  const journalPath = stateLockPath(kind, name, root);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    journalPath,
    opts.contents ?? serializeRecords(records),
    { mode: opts.mode ?? 0o600 },
  );
  return journalPath;
}

function readJournalRecords(journalPath) {
  const contents = fs.readFileSync(journalPath, 'utf8');
  if (contents === '') return [];
  expect(contents.endsWith('\n')).toBe(true);
  return contents.slice(0, -1).split('\n').map((line) => JSON.parse(line));
}

function activeClaims(records) {
  const active = new Map();
  for (const record of records) {
    if (record.op === 'claim') active.set(record.token, record);
    else if (record.op === 'release') active.delete(record.token);
  }
  return [...active.values()];
}

function temporaryStealthHome(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `stealth-state-lock-${label}-`));
  EXTRA_TEST_HOMES.add(root);
  return root;
}

function spawnStateLockContender(kind, name) {
  const child = spawn(process.execPath, [STATE_LOCK_CHILD, kind, name], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    env: { ...process.env, STEALTH_HOME: getStealthHome() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  SPAWNED_CHILDREN.add(child);

  let stdout = '';
  let stderr = '';
  let locked = false;
  let settleOutcome;
  let rejectOutcome;
  const outcome = new Promise((resolve, reject) => {
    settleOutcome = resolve;
    rejectOutcome = reject;
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      SPAWNED_CHILDREN.delete(child);
      resolve({ code, signal, stderr });
      if (!locked) settleOutcome({ status: 'exited', child, code, signal, stderr });
    });
  });
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    rejectOutcome(new Error(`Timed out waiting for ${kind} ${name} contender`));
  }, 10_000);

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!locked && stdout.includes('locked')) {
      locked = true;
      clearTimeout(timeout);
      settleOutcome({ status: 'locked', child });
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', (error) => {
    clearTimeout(timeout);
    SPAWNED_CHILDREN.delete(child);
    rejectOutcome(error);
  });
  child.once('exit', () => clearTimeout(timeout));

  return { child, outcome, exited };
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.STEALTH_HOME = TEST_STEALTH_HOME;
  fs.rmSync(getStateLocksDir(), { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const child of SPAWNED_CHILDREN) child.kill('SIGKILL');
  if (ORIGINAL_STEALTH_HOME === undefined) delete process.env.STEALTH_HOME;
  else process.env.STEALTH_HOME = ORIGINAL_STEALTH_HOME;
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
  for (const root of EXTRA_TEST_HOMES) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('state lock journals', () => {
  it('appends claim/release history and reuses the same regular file without deleting it', () => {
    const unlink = vi.spyOn(fs, 'unlinkSync');
    const rmdir = vi.spyOn(fs, 'rmdirSync');
    const journalPath = stateLockPath('profile', 'work');

    const first = acquireStateLocks({ profile: 'Work' });
    const initialStats = fs.statSync(journalPath);
    expect(initialStats.isFile()).toBe(true);
    expect(first.owns('profile', 'work')).toBe(true);
    expect(readJournalRecords(journalPath)).toEqual([
      expect.objectContaining({
        op: 'claim',
        root: canonicalStateRoot(),
        kind: 'profile',
        name: 'work',
        pid: process.pid,
        hostname: os.hostname(),
      }),
    ]);

    first();
    first();
    expect(fs.existsSync(journalPath)).toBe(true);
    expect(fs.statSync(journalPath).ino).toBe(initialStats.ino);
    expect(readJournalRecords(journalPath).map(({ op }) => op)).toEqual(['claim', 'release']);

    const second = acquireStateLocks({ profile: 'work' });
    expect(fs.statSync(journalPath).ino).toBe(initialStats.ino);
    second();

    const records = readJournalRecords(journalPath);
    expect(records.map(({ op }) => op)).toEqual(['claim', 'release', 'claim', 'release']);
    expect(activeClaims(records)).toEqual([]);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();

    if (process.platform !== 'win32') {
      expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(journalPath).uid).toBe(currentUserId());
    }
  });

  it('uses one canonical journal identity for case aliases and reports branded ownership', () => {
    const lease = acquireStateLocks({ profile: 'Work' });

    expect(lease.owns('profile', 'work')).toBe(true);
    expect(lease.owns('profile', 'WORK')).toBe(true);
    expect(lease.owns('session', 'work')).toBe(false);
    expect(ownsStateLock(lease, 'profile', 'WORK')).toBe(true);
    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('already in use');

    lease();
    expect(lease.owns('profile', 'work')).toBe(false);
    expect(ownsStateLock(lease, 'profile', 'work')).toBe(false);
  });

  it('does not create or validate lock storage when no state target is requested', () => {
    const parent = temporaryStealthHome('empty-lease');
    const absentRoot = path.join(parent, 'not-created');
    const mkdirSync = vi.spyOn(fs, 'mkdirSync');
    process.env.STEALTH_HOME = absentRoot;

    try {
      const lease = acquireStateLocks();
      expect(lease.owns('profile', 'work')).toBe(false);
      expect(() => lease()).not.toThrow();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(fs.existsSync(absentRoot)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      process.env.STEALTH_HOME = TEST_STEALTH_HOME;
    }
  });

  (process.platform === 'win32' ? it.skip : it)(
    'uses one physical lock identity through a trusted ancestor alias',
    () => {
      const targetParent = temporaryStealthHome('canonical-target');
      const targetRoot = path.join(targetParent, 'state');
      fs.mkdirSync(targetRoot, { mode: 0o700 });
      const linksParent = temporaryStealthHome('canonical-alias');
      const systemAlias = path.join(linksParent, 'system-alias');
      fs.symlinkSync(targetParent, systemAlias);
      const aliasRoot = path.join(systemAlias, 'state');
      const lstatSync = fs.lstatSync.bind(fs);
      vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
        const stats = lstatSync(target, ...args);
        return target === systemAlias ? statsWithUid(stats, 0) : stats;
      });

      let lease;
      try {
        process.env.STEALTH_HOME = aliasRoot;
        lease = acquireStateLocks({ profile: 'work' });
        const canonicalRoot = canonicalStateRoot(targetRoot);
        const journalPath = stateLockPath('profile', 'work', canonicalRoot);
        expect(readJournalRecords(journalPath)[0]).toMatchObject({
          op: 'claim',
          root: canonicalRoot,
          kind: 'profile',
          name: 'work',
        });

        process.env.STEALTH_HOME = canonicalRoot;
        expect(ownsStateLock(lease, 'profile', 'work')).toBe(true);
        expect(() => acquireStateLocks({ profile: 'work' })).toThrow('already in use');
        expect(fs.readdirSync(path.join(canonicalRoot, 'locks'))).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
        if (lease) lease();
        process.env.STEALTH_HOME = TEST_STEALTH_HOME;
      }
    },
  );

  it('publishes one owner-only journal per target with immutable claim bindings', () => {
    const release = acquireStateLocks({ profile: 'work', session: 'login' });
    const entries = fs.readdirSync(getStateLocksDir(), { withFileTypes: true });

    expect(entries).toHaveLength(2);
    const targets = [];
    for (const entry of entries) {
      expect(entry.isFile()).toBe(true);
      const journalPath = path.join(getStateLocksDir(), entry.name);
      const [claim] = readJournalRecords(journalPath);
      expect(Object.keys(claim)).toEqual([
        'op',
        'token',
        'root',
        'kind',
        'name',
        'pid',
        'hostname',
        'createdAt',
      ]);
      expect(claim).toMatchObject({
        op: 'claim',
        root: canonicalStateRoot(),
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: expect.any(String),
      });
      expect(claim.token).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      targets.push(`${claim.kind}:${claim.name}`);
    }
    expect(targets.sort()).toEqual(['profile:work', 'session:login']);

    release();
    expect(fs.readdirSync(getStateLocksDir())).toHaveLength(2);
  });

  it('orders simultaneous contenders so only the earliest active claim succeeds', async () => {
    const contenders = [
      spawnStateLockContender('profile', 'simultaneous'),
      spawnStateLockContender('profile', 'simultaneous'),
    ];

    try {
      const outcomes = await Promise.all(contenders.map(({ outcome }) => outcome));
      const winners = outcomes.filter(({ status }) => status === 'locked');
      const losers = outcomes.filter(({ status }) => status === 'exited');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].code).not.toBe(0);

      const journalPath = stateLockPath('profile', 'simultaneous');
      const records = readJournalRecords(journalPath);
      const claims = records.filter(({ op }) => op === 'claim');
      const active = activeClaims(records);
      expect(claims).toHaveLength(2);
      expect(records.filter(({ op }) => op === 'release')).toHaveLength(1);
      expect(active).toHaveLength(1);
      expect(active[0].token).toBe(claims[0].token);
      expect(active[0].pid).toBe(winners[0].child.pid);

      winners[0].child.kill('SIGTERM');
      const winnerProcess = contenders.find(({ child }) => child.pid === winners[0].child.pid);
      await expect(winnerProcess.exited).resolves.toMatchObject({
        code: 0,
        signal: null,
        stderr: '',
      });

      expect(activeClaims(readJournalRecords(journalPath))).toEqual([]);
      const reuse = acquireStateLocks({ profile: 'simultaneous' });
      reuse();
    } finally {
      for (const { child } of contenders) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await Promise.all(contenders.map(({ exited }) => exited));
    }
  }, 15_000);

  it('releases earlier deterministic targets when a later target conflicts', () => {
    const session = acquireStateLocks({ session: 'login' });

    expect(() => acquireStateLocks({ profile: 'work', session: 'login' }))
      .toThrow('already in use');

    const profileRecords = readJournalRecords(stateLockPath('profile', 'work'));
    expect(profileRecords.map(({ op }) => op)).toEqual(['claim', 'release']);
    expect(activeClaims(profileRecords)).toEqual([]);

    const profile = acquireStateLocks({ profile: 'work' });
    profile();
    session();
  });

  it('preserves acquisition errors and retains private rollback recovery across retries', () => {
    const session = acquireStateLocks({ session: 'login' });
    const tokenKinds = new Map();
    const writeSync = fs.writeSync.bind(fs);
    let rejectedProfileReleases = 0;

    vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, buffer, ...args) => {
      const record = JSON.parse(buffer.toString('utf8').trim());
      if (record.op === 'claim') tokenKinds.set(record.token, record.kind);
      if (
        record.op === 'release'
        && tokenKinds.get(record.token) === 'profile'
        && rejectedProfileReleases < 2
      ) {
        rejectedProfileReleases += 1;
        const error = new Error(`profile release busy ${rejectedProfileReleases}`);
        error.code = 'EBUSY';
        throw error;
      }
      return writeSync(descriptor, buffer, ...args);
    });

    let error;
    try {
      acquireStateLocks({ profile: 'work', session: 'login' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('already in use');
    expect(error?.cleanupFailures).toEqual([
      expect.objectContaining({ target: 'profile:work' }),
    ]);
    expect(Object.getOwnPropertyDescriptor(error, 'cleanupFailures')?.enumerable).toBe(false);
    expect(Object.keys(error)).not.toContain('cleanupFailures');
    expect(activeClaims(readJournalRecords(stateLockPath('profile', 'work')))).toHaveLength(1);

    let retryError;
    try {
      retryStateLockCleanup(error);
    } catch (cause) {
      retryError = cause;
    }
    expect(retryError?.message).toContain('profile release busy 2');
    expect(activeClaims(readJournalRecords(stateLockPath('profile', 'work')))).toHaveLength(1);

    vi.restoreAllMocks();
    expect(() => retryStateLockCleanup(error)).not.toThrow();
    expect(activeClaims(readJournalRecords(stateLockPath('profile', 'work')))).toEqual([]);
    expect(() => retryStateLockCleanup(error)).toThrow(
      'No pending state-lock cleanup is available for this error',
    );
    expect(() => retryStateLockCleanup(retryError)).toThrow(
      'No pending state-lock cleanup is available for this error',
    );
    session();
  });

  it('rejects arbitrary, cloned, and serialized cleanup-recovery errors', () => {
    const arbitrary = new Error('unrelated');
    const clone = Object.assign(new Error(arbitrary.message), arbitrary);
    const serialized = JSON.parse(JSON.stringify(arbitrary));

    for (const error of [arbitrary, clone, serialized]) {
      expect(() => retryStateLockCleanup(error)).toThrow(
        'No pending state-lock cleanup is available for this error',
      );
    }
  });

  it('detects path replacement during failed-acquisition release publication', () => {
    const stale = claimRecord('profile', 'rollback-window', {
      pid: 2_147_483_647,
      createdAt: new Date(0).toISOString(),
    });
    const journalPath = writeJournal('profile', 'rollback-window', [stale]);
    const displacedPath = `${journalPath}.displaced`;
    const replacementPath = `${journalPath}.replacement`;
    const writeSync = fs.writeSync.bind(fs);
    let contenderToken;
    let swapped = false;

    vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, buffer, ...args) => {
      const record = JSON.parse(buffer.toString('utf8').trim());
      if (record.op === 'claim' && record.token !== stale.token) contenderToken = record.token;
      if (record.op === 'release' && record.token === contenderToken && !swapped) {
        swapped = true;
        fs.copyFileSync(journalPath, replacementPath);
        fs.renameSync(journalPath, displacedPath);
        fs.renameSync(replacementPath, journalPath);
      }
      return writeSync(descriptor, buffer, ...args);
    });

    let failure;
    try {
      acquireStateLocks({ profile: 'rollback-window' });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toContain('stale lock claim');
    expect(failure?.cleanupFailures).toEqual([
      expect.objectContaining({
        target: 'profile:rollback-window',
        error: expect.objectContaining({
          hint: journalRemovalHint(journalPath),
        }),
      }),
    ]);
    expect(activeClaims(readJournalRecords(journalPath)).map(({ token }) => token))
      .toEqual([stale.token, contenderToken]);
    expect(readJournalRecords(displacedPath).map(({ op }) => op))
      .toEqual(['claim', 'claim', 'release']);
  });

  it('fails closed on a dead local claim and appends release for its failed contender claim', () => {
    const stalePid = 2_147_483_647;
    const stale = claimRecord('profile', 'work', {
      pid: stalePid,
      createdAt: new Date(0).toISOString(),
    });
    const journalPath = writeJournal('profile', 'work', [stale]);

    let error;
    try {
      acquireStateLocks({ profile: 'work' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('stale lock claim');
    expect(error?.hint).toBe(journalRemovalHint(journalPath));
    const records = readJournalRecords(journalPath);
    expect(records.map(({ op }) => op)).toEqual(['claim', 'claim', 'release']);
    expect(activeClaims(records)).toEqual([stale]);
  });

  it('fails closed on a remote claim with the exact journal path', () => {
    const remote = claimRecord('session', 'login', {
      hostname: 'remote-host.example',
      pid: 4242,
    });
    const journalPath = writeJournal('session', 'login', [remote]);

    let error;
    try {
      acquireStateLocks({ session: 'login' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('remote-host.example');
    expect(error?.hint).toBe(journalRemovalHint(journalPath));
    expect(activeClaims(readJournalRecords(journalPath))).toEqual([remote]);
  });

  it.each([
    ['malformed JSON', 'not-json\n'],
    ['truncated final record', '{"op":"claim"'],
    ['empty interior record', '\n'],
  ])('fails closed on a %s journal without modifying it', (_label, contents) => {
    const journalPath = writeJournal('profile', 'broken', [], { contents });

    let error;
    try {
      acquireStateLocks({ profile: 'broken' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('invalid lock journal');
    expect(error?.hint).toBe(journalRemovalHint(journalPath));
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(contents);
  });

  it('rejects an orphan release token without modifying the journal', () => {
    const orphan = releaseRecord(crypto.randomUUID());
    const journalPath = writeJournal('session', 'orphan-release', [orphan]);
    const contents = fs.readFileSync(journalPath, 'utf8');

    let error;
    try {
      acquireStateLocks({ session: 'orphan-release' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('invalid lock journal');
    expect(error?.hint).toBe(journalRemovalHint(journalPath));
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(contents);
  });

  it('accepts duplicate releases when their claim appeared earlier', () => {
    const claim = claimRecord('profile', 'duplicate-release');
    const journalPath = writeJournal('profile', 'duplicate-release', [
      claim,
      releaseRecord(claim.token),
      releaseRecord(claim.token),
    ]);

    const lease = acquireStateLocks({ profile: 'duplicate-release' });
    expect(lease.owns('profile', 'duplicate-release')).toBe(true);
    lease();

    const records = readJournalRecords(journalPath);
    expect(records.filter(({ token }) => token === claim.token)).toHaveLength(3);
    expect(activeClaims(records)).toEqual([]);
  });

  it('rejects claim history bound to a different root, kind, or canonical name', () => {
    const cases = [
      claimRecord('profile', 'bound', { root: temporaryStealthHome('wrong-binding') }),
      claimRecord('session', 'bound'),
      claimRecord('profile', 'other'),
    ];

    for (const [index, claim] of cases.entries()) {
      const name = `bound-${index}`;
      const journalPath = writeJournal('profile', name, [{
        ...claim,
        name: index === 2 ? 'other' : name,
      }]);
      expect(() => acquireStateLocks({ profile: name })).toThrow('invalid lock journal');
      expect(readJournalRecords(journalPath)).toEqual([expect.objectContaining({ token: claim.token })]);
    }
  });

  it('keeps ownership active and retries after a transient release append failure', () => {
    const lease = acquireStateLocks({ profile: 'work' });
    const journalPath = stateLockPath('profile', 'work');
    const writeSync = fs.writeSync.bind(fs);
    let failed = false;

    vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, buffer, ...args) => {
      const record = JSON.parse(buffer.toString('utf8').trim());
      if (record.op === 'release' && !failed) {
        failed = true;
        const error = new Error('transient append failure');
        error.code = 'EIO';
        throw error;
      }
      return writeSync(descriptor, buffer, ...args);
    });

    expect(() => lease()).toThrow('transient append failure');
    expect(lease.owns('profile', 'work')).toBe(true);
    expect(activeClaims(readJournalRecords(journalPath))).toHaveLength(1);

    vi.restoreAllMocks();
    lease();
    expect(lease.owns('profile', 'work')).toBe(false);
    expect(readJournalRecords(journalPath).map(({ op }) => op)).toEqual(['claim', 'release']);
  });

  it('retries cleanup after a transient lstat verification failure', () => {
    const lease = acquireStateLocks({ profile: 'lstat-retry' });
    const journalPath = stateLockPath('profile', 'lstat-retry');
    const lstatSync = fs.lstatSync.bind(fs);
    let failed = false;

    vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (!failed && target === journalPath) {
        failed = true;
        const error = new Error('transient lstat failure');
        error.code = 'EIO';
        throw error;
      }
      return lstatSync(target, ...args);
    });

    expect(() => lease()).toThrow('ownership could not be verified');
    expect(lease.owns('profile', 'lstat-retry')).toBe(false);
    expect(activeClaims(readJournalRecords(journalPath))).toHaveLength(1);

    vi.restoreAllMocks();
    lease();
    expect(activeClaims(readJournalRecords(journalPath))).toEqual([]);
    expect(readJournalRecords(journalPath).map(({ op }) => op)).toEqual(['claim', 'release']);
  });

  it('retries cleanup after a transient ownership-read failure revokes authorization', () => {
    const lease = acquireStateLocks({ session: 'read-retry' });
    const journalPath = stateLockPath('session', 'read-retry');
    vi.spyOn(fs, 'readSync').mockImplementationOnce(() => {
      const error = new Error('transient read failure');
      error.code = 'EIO';
      throw error;
    });

    expect(lease.owns('session', 'read-retry')).toBe(false);
    expect(activeClaims(readJournalRecords(journalPath))).toHaveLength(1);

    vi.restoreAllMocks();
    lease();
    expect(activeClaims(readJournalRecords(journalPath))).toEqual([]);
    expect(readJournalRecords(journalPath).map(({ op }) => op)).toEqual(['claim', 'release']);
  });

  it('revokes ownership on release publication and retries only fsync before close', () => {
    const oldLease = acquireStateLocks({ session: 'login' });
    const journalPath = stateLockPath('session', 'login');
    const oldToken = readJournalRecords(journalPath)[0].token;
    const fsyncSync = fs.fsyncSync.bind(fs);
    let failed = false;

    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (!failed) {
        failed = true;
        const error = new Error('transient fsync failure');
        error.code = 'EIO';
        throw error;
      }
      return fsyncSync(descriptor);
    });

    expect(() => oldLease()).toThrow('transient fsync failure');
    expect(oldLease.owns('session', 'login')).toBe(false);
    expect(activeClaims(readJournalRecords(journalPath))).toEqual([]);
    expect(
      readJournalRecords(journalPath)
        .filter((record) => record.op === 'release' && record.token === oldToken),
    ).toHaveLength(1);

    vi.restoreAllMocks();
    const successor = acquireStateLocks({ session: 'login' });
    const successorClaim = activeClaims(readJournalRecords(journalPath))[0];
    expect(successorClaim.token).not.toBe(oldToken);
    expect(successor.owns('session', 'login')).toBe(true);
    const contentsBeforeRetry = fs.readFileSync(journalPath, 'utf8');
    const retryWrite = vi.spyOn(fs, 'writeSync');
    const retryFsync = vi.spyOn(fs, 'fsyncSync');

    oldLease();
    oldLease();

    expect(retryWrite).not.toHaveBeenCalled();
    expect(retryFsync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(contentsBeforeRetry);
    expect(oldLease.owns('session', 'login')).toBe(false);
    expect(successor.owns('session', 'login')).toBe(true);
    expect(activeClaims(readJournalRecords(journalPath))).toEqual([successorClaim]);
    expect(
      readJournalRecords(journalPath)
        .filter((record) => record.op === 'release' && record.token === oldToken),
    ).toHaveLength(1);

    vi.restoreAllMocks();
    successor();
  });

  it('detects a copied active claim when the path changes during release append', () => {
    const lease = acquireStateLocks({ profile: 'write-window' });
    const journalPath = stateLockPath('profile', 'write-window');
    const displacedPath = `${journalPath}.displaced`;
    const replacementPath = `${journalPath}.replacement`;
    const claimContents = fs.readFileSync(journalPath, 'utf8');
    fs.writeFileSync(replacementPath, claimContents, { mode: 0o600 });
    const writeSync = fs.writeSync.bind(fs);
    let swapped = false;

    vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, buffer, ...args) => {
      const record = JSON.parse(buffer.toString('utf8').trim());
      if (record.op === 'release' && !swapped) {
        swapped = true;
        fs.renameSync(journalPath, displacedPath);
        fs.renameSync(replacementPath, journalPath);
      }
      return writeSync(descriptor, buffer, ...args);
    });

    let failure;
    try {
      lease();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'ProfileError',
      hint: journalRemovalHint(journalPath),
    });
    expect(failure.message).toContain('still contains this process\'s active claim');
    expect(lease.owns('profile', 'write-window')).toBe(false);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(claimContents);
    expect(readJournalRecords(displacedPath).map(({ op }) => op)).toEqual(['claim', 'release']);

    vi.restoreAllMocks();
    fs.rmSync(journalPath);
    expect(() => lease()).not.toThrow();
  });

  it('abandons an ambiguously closed inspection descriptor before fd reuse', () => {
    const oldLease = acquireStateLocks({ profile: 'inspection-close' });
    const journalPath = stateLockPath('profile', 'inspection-close');
    const displacedPath = `${journalPath}.displaced`;
    fs.renameSync(journalPath, displacedPath);
    const successor = acquireStateLocks({ profile: 'inspection-close' });
    const successorContents = fs.readFileSync(journalPath, 'utf8');
    const unrelatedPath = `${journalPath}.unrelated`;
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let ambiguousDescriptor;
    let inspectionOpenCount = 0;
    let ambiguousCloseInjected = false;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (target === journalPath) {
        if (ambiguousDescriptor === undefined) ambiguousDescriptor = descriptor;
        inspectionOpenCount += 1;
      }
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === ambiguousDescriptor && !ambiguousCloseInjected) {
        ambiguousCloseInjected = true;
        closeSync(descriptor);
        const error = new Error('replacement inspection close failed after release');
        error.code = 'EIO';
        throw error;
      }
      return closeSync(descriptor);
    });

    expect(() => oldLease()).toThrow('could not be inspected safely');
    expect(inspectionOpenCount).toBe(1);
    const unrelatedDescriptor = fs.openSync(unrelatedPath, 'w+', 0o600);
    expect(unrelatedDescriptor).toBe(ambiguousDescriptor);

    expect(() => oldLease()).not.toThrow();
    expect(inspectionOpenCount).toBeGreaterThanOrEqual(2);
    expect(closeSpy.mock.calls.filter(([descriptor]) => (
      descriptor === ambiguousDescriptor
    ))).toHaveLength(1);
    expect(fs.fstatSync(unrelatedDescriptor).isFile()).toBe(true);
    expect(oldLease.owns('profile', 'inspection-close')).toBe(false);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(successorContents);

    vi.restoreAllMocks();
    fs.closeSync(unrelatedDescriptor);
    expect(successor.owns('profile', 'inspection-close')).toBe(true);
    successor();
  });

  it('abandons an ambiguously closed pre-validation descriptor before fd reuse', () => {
    const lease = acquireStateLocks({ profile: 'inspection-validation-close' });
    const journalPath = stateLockPath('profile', 'inspection-validation-close');
    const displacedPath = `${journalPath}.displaced`;
    const claimContents = fs.readFileSync(journalPath, 'utf8');
    fs.renameSync(journalPath, displacedPath);
    fs.writeFileSync(journalPath, claimContents, { mode: 0o644 });
    const unrelatedPath = `${journalPath}.unrelated`;
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let ambiguousDescriptor;
    let inspectionOpenCount = 0;
    let ambiguousCloseInjected = false;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (target === journalPath) {
        if (ambiguousDescriptor === undefined) ambiguousDescriptor = descriptor;
        inspectionOpenCount += 1;
      }
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === ambiguousDescriptor && !ambiguousCloseInjected) {
        ambiguousCloseInjected = true;
        closeSync(descriptor);
        const error = new Error('pre-validation close failed after release');
        error.code = 'EIO';
        throw error;
      }
      return closeSync(descriptor);
    });

    expect(() => lease()).toThrow('could not be inspected safely');
    expect(inspectionOpenCount).toBe(1);
    const unrelatedDescriptor = fs.openSync(unrelatedPath, 'w+', 0o600);
    expect(unrelatedDescriptor).toBe(ambiguousDescriptor);

    expect(() => lease()).toThrow('could not be inspected safely');
    expect(inspectionOpenCount).toBeGreaterThanOrEqual(2);
    expect(closeSpy.mock.calls.filter(([descriptor]) => (
      descriptor === ambiguousDescriptor
    ))).toHaveLength(1);
    expect(fs.fstatSync(unrelatedDescriptor).isFile()).toBe(true);
    expect(lease.owns('profile', 'inspection-validation-close')).toBe(false);

    vi.restoreAllMocks();
    fs.closeSync(unrelatedDescriptor);
    fs.rmSync(journalPath);
    expect(() => lease()).not.toThrow();
  });

  it('fails cleanup when a replacement journal retains the current active claim', () => {
    const lease = acquireStateLocks({ profile: 'copied' });
    const journalPath = stateLockPath('profile', 'copied');
    const displacedPath = `${journalPath}.displaced`;
    fs.renameSync(journalPath, displacedPath);
    const copiedContents = fs.readFileSync(displacedPath, 'utf8');
    fs.writeFileSync(journalPath, copiedContents, { mode: 0o600 });
    const retryWrite = vi.spyOn(fs, 'writeSync');

    expect(lease.owns('profile', 'copied')).toBe(false);
    let failure;
    try {
      lease();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'ProfileError',
      hint: journalRemovalHint(journalPath),
    });
    expect(failure.message).toContain('still contains this process\'s active claim');
    expect(lease.owns('profile', 'copied')).toBe(false);
    expect(retryWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(copiedContents);
    expect(fs.readFileSync(displacedPath, 'utf8')).toBe(copiedContents);

    vi.restoreAllMocks();
    fs.rmSync(journalPath);
    expect(() => lease()).not.toThrow();
  });

  it('fails closed when a replacement journal cannot be inspected safely', () => {
    const lease = acquireStateLocks({ profile: 'malformed-copy' });
    const journalPath = stateLockPath('profile', 'malformed-copy');
    const displacedPath = `${journalPath}.displaced`;
    fs.renameSync(journalPath, displacedPath);
    fs.writeFileSync(journalPath, '{"op":"claim"}\n', { mode: 0o600 });
    const replacementContents = fs.readFileSync(journalPath, 'utf8');

    let failure;
    try {
      lease();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'ProfileError',
      hint: journalRemovalHint(journalPath),
    });
    expect(failure.message).toContain('could not be inspected safely');
    expect(lease.owns('profile', 'malformed-copy')).toBe(false);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(replacementContents);

    fs.rmSync(journalPath);
    expect(() => lease()).not.toThrow();
  });

  it('fails a published-release retry when a replacement restores the old active claim', () => {
    const lease = acquireStateLocks({ session: 'published-copy' });
    const journalPath = stateLockPath('session', 'published-copy');
    const fsyncSync = fs.fsyncSync.bind(fs);
    let failed = false;

    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (!failed) {
        failed = true;
        const error = new Error('transient fsync failure');
        error.code = 'EIO';
        throw error;
      }
      return fsyncSync(descriptor);
    });

    expect(() => lease()).toThrow('transient fsync failure');
    const releasedRecords = readJournalRecords(journalPath);
    const oldClaim = releasedRecords.find(({ op }) => op === 'claim');
    expect(activeClaims(releasedRecords)).toEqual([]);
    vi.restoreAllMocks();

    const displacedPath = `${journalPath}.displaced`;
    fs.renameSync(journalPath, displacedPath);
    writeJournal('session', 'published-copy', [oldClaim]);
    const replacementContents = fs.readFileSync(journalPath, 'utf8');
    const displacedContents = fs.readFileSync(displacedPath, 'utf8');
    const retryWrite = vi.spyOn(fs, 'writeSync');
    const retryFsync = vi.spyOn(fs, 'fsyncSync');

    let failure;
    try {
      lease();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'ProfileError',
      hint: journalRemovalHint(journalPath),
    });
    expect(failure.message).toContain('still contains this process\'s active claim');
    expect(lease.owns('session', 'published-copy')).toBe(false);
    expect(retryWrite).not.toHaveBeenCalled();
    expect(retryFsync).not.toHaveBeenCalled();
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(replacementContents);
    expect(fs.readFileSync(displacedPath, 'utf8')).toBe(displacedContents);

    vi.restoreAllMocks();
    fs.rmSync(journalPath);
    expect(() => lease()).not.toThrow();
  });

  it('clears an old lease without modifying an externally replaced successor journal', () => {
    const oldLease = acquireStateLocks({ profile: 'work' });
    const journalPath = stateLockPath('profile', 'work');
    const displacedPath = `${journalPath}.displaced`;
    fs.renameSync(journalPath, displacedPath);

    const successor = acquireStateLocks({ profile: 'work' });
    const successorContents = fs.readFileSync(journalPath, 'utf8');
    const displacedContents = fs.readFileSync(displacedPath, 'utf8');
    const oldReleaseWrite = vi.spyOn(fs, 'writeSync');

    expect(() => oldLease()).not.toThrow();
    expect(oldReleaseWrite).not.toHaveBeenCalled();
    expect(oldLease.owns('profile', 'work')).toBe(false);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(successorContents);
    expect(fs.readFileSync(displacedPath, 'utf8')).toBe(displacedContents);
    expect(successor.owns('profile', 'work')).toBe(true);

    vi.restoreAllMocks();
    successor();
  });

  it('binds leases and release descriptors to the resolved STEALTH_HOME root', () => {
    const originalRoot = getStealthHome();
    const oldLease = acquireStateLocks({ profile: 'work' });
    const originalJournal = stateLockPath('profile', 'work', originalRoot);
    const newRoot = temporaryStealthHome('root-switch');
    process.env.STEALTH_HOME = newRoot;

    try {
      expect(oldLease.owns('profile', 'work')).toBe(false);
      expect(ownsStateLock(oldLease, 'profile', 'work')).toBe(false);

      const callbackResult = withStateLock('profile', 'work', oldLease, (activeLease) => {
        expect(activeLease).not.toBe(oldLease);
        expect(activeLease.owns('profile', 'work')).toBe(true);
        return 'new-root';
      });
      expect(callbackResult).toBe('new-root');
      const newJournal = stateLockPath('profile', 'work', newRoot);
      expect(readJournalRecords(newJournal).map(({ op }) => op)).toEqual(['claim', 'release']);

      const successor = acquireStateLocks({ profile: 'work' });
      oldLease();
      expect(readJournalRecords(originalJournal).map(({ op }) => op)).toEqual(['claim', 'release']);
      expect(successor.owns('profile', 'work')).toBe(true);
      successor();
    } finally {
      process.env.STEALTH_HOME = TEST_STEALTH_HOME;
    }
  });

  it('does not trust forged lease predicates', () => {
    const owner = acquireStateLocks({ profile: 'work' });
    const fakeLease = { owns: () => true };

    try {
      expect(ownsStateLock(fakeLease, 'profile', 'work')).toBe(false);
      expect(() => withStateLock('profile', 'work', fakeLease, () => 'forged'))
        .toThrow('already in use');
    } finally {
      owner();
    }

    const result = withStateLock('profile', 'work', fakeLease, (activeLease) => {
      expect(activeLease).not.toBe(fakeLease);
      expect(ownsStateLock(activeLease, 'profile', 'work')).toBe(true);
      return 'real-lock';
    });
    expect(result).toBe('real-lock');
  });

  it('merges nested temporary-lease recovery without replacing the primary error', () => {
    const primaryError = new Error('state operation failed');
    const tokenKinds = new Map();
    const rejectedKinds = new Set();
    const writeSync = fs.writeSync.bind(fs);
    vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, buffer, ...args) => {
      const record = JSON.parse(buffer.toString('utf8').trim());
      if (record.op === 'claim') tokenKinds.set(record.token, record.kind);
      if (record.op === 'release') {
        const kind = tokenKinds.get(record.token);
        if (!rejectedKinds.has(kind)) {
          rejectedKinds.add(kind);
          const error = new Error(`${kind} temporary lock release failed`);
          error.code = 'EIO';
          throw error;
        }
      }
      return writeSync(descriptor, buffer, ...args);
    });

    let failure;
    try {
      withStateLock('profile', 'outer-cleanup', null, () => (
        withStateLock('session', 'inner-cleanup', null, () => {
          throw primaryError;
        })
      ));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(primaryError);
    expect(failure.cleanupFailures).toEqual([
      expect.objectContaining({ target: 'session:inner-cleanup' }),
      expect.objectContaining({ target: 'profile:outer-cleanup' }),
    ]);
    expect(Object.getOwnPropertyDescriptor(failure, 'cleanupFailures')?.enumerable).toBe(false);
    const innerJournal = stateLockPath('session', 'inner-cleanup');
    const outerJournal = stateLockPath('profile', 'outer-cleanup');
    expect(activeClaims(readJournalRecords(innerJournal))).toHaveLength(1);
    expect(activeClaims(readJournalRecords(outerJournal))).toHaveLength(1);

    vi.restoreAllMocks();
    expect(() => retryStateLockCleanup(failure)).not.toThrow();
    expect(activeClaims(readJournalRecords(innerJournal))).toEqual([]);
    expect(activeClaims(readJournalRecords(outerJournal))).toEqual([]);
  });

  it('wraps a primitive async rejection when temporary-lease cleanup also fails', async () => {
    const writeSync = fs.writeSync.bind(fs);
    let rejectedRelease = false;
    vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, buffer, ...args) => {
      const record = JSON.parse(buffer.toString('utf8').trim());
      if (record.op === 'release' && !rejectedRelease) {
        rejectedRelease = true;
        const error = new Error('async temporary lock release failed');
        error.code = 'EIO';
        throw error;
      }
      return writeSync(descriptor, buffer, ...args);
    });

    let failure;
    try {
      await withStateLock(
        'session',
        'async-cleanup',
        null,
        () => Promise.reject('primitive operation rejection'),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'ProfileError',
      message: 'State operation failed and state-lock cleanup is incomplete',
      cause: 'primitive operation rejection',
      cleanupFailures: [expect.objectContaining({ target: 'session:async-cleanup' })],
    });
    const journalPath = stateLockPath('session', 'async-cleanup');
    expect(activeClaims(readJournalRecords(journalPath))).toHaveLength(1);

    vi.restoreAllMocks();
    expect(() => retryStateLockCleanup(failure)).not.toThrow();
    expect(activeClaims(readJournalRecords(journalPath))).toEqual([]);
  });

  it('releases a temporary lease when reading a returned thenable throws', () => {
    const getterError = new Error('then getter failed');
    const result = {};
    Object.defineProperty(result, 'then', {
      get() {
        throw getterError;
      },
    });

    expect(() => withStateLock('profile', 'thenable-getter', null, () => result))
      .toThrow(getterError);
    const records = readJournalRecords(stateLockPath('profile', 'thenable-getter'));
    expect(records.map(({ op }) => op)).toEqual(['claim', 'release']);
    expect(activeClaims(records)).toEqual([]);
  });

  it('reuses an owning lease and releases short-lived sync and async leases', async () => {
    const lease = acquireStateLocks({ profile: 'Work' });
    const reused = withStateLock('profile', 'work', lease, (activeLease) => {
      expect(activeLease).toBe(lease);
      return 'reused';
    });

    expect(reused).toBe('reused');
    expect(lease.owns('profile', 'work')).toBe(true);
    lease();

    expect(withStateLock('session', 'Login', null, () => 'sync')).toBe('sync');
    await expect(withStateLock('session', 'Login', null, async () => 'async'))
      .resolves.toBe('async');
    expect(activeClaims(readJournalRecords(stateLockPath('session', 'login')))).toEqual([]);
  });

  it('rejects oversized journals with an actionable maintenance hint', () => {
    const journalPath = writeJournal('profile', 'large', [], {
      contents: Buffer.alloc(MAX_JOURNAL_BYTES + 1, 0x20),
    });
    const originalSize = fs.statSync(journalPath).size;

    let error;
    try {
      acquireStateLocks({ profile: 'large' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('exceeds the 4 MiB safety limit');
    expect(error?.hint).toBe(journalMaintenanceHint(journalPath));
    expect(fs.statSync(journalPath).size).toBe(originalSize);
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('rejects insecure journal permissions without hardening or deleting the file', () => {
    const journalPath = writeJournal('profile', 'mode', [], { mode: 0o644 });

    let error;
    try {
      acquireStateLocks({ profile: 'mode' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('lock journal is unsafe');
    expect(error?.hint).toBe(journalRemovalHint(journalPath));
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o644);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  posixIt('rejects a symbolic-link journal without following or modifying its target', () => {
    const outside = path.join(TEST_STEALTH_HOME, 'outside-lock-journal');
    fs.writeFileSync(outside, 'outside\n', { mode: 0o600 });
    const journalPath = stateLockPath('session', 'symlink');
    fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, journalPath);

    let error;
    try {
      acquireStateLocks({ session: 'symlink' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('lock journal is unsafe');
    expect(error?.hint).toBe(journalRemovalHint(journalPath));
    expect(fs.lstatSync(journalPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n');
  });

  it('rejects a directory at the deterministic journal path without deleting it', () => {
    const journalPath = stateLockPath('profile', 'directory');
    fs.mkdirSync(journalPath, { recursive: true, mode: 0o700 });

    expect(() => acquireStateLocks({ profile: 'directory' })).toThrow('lock journal is unsafe');
    expect(fs.statSync(journalPath).isDirectory()).toBe(true);
  });

  it('rejects unsafe and Windows-reserved names before touching lock storage', () => {
    expect(() => acquireStateLocks({ profile: '../work' })).toThrow('only letters');
    expect(() => acquireStateLocks({ session: 'login.json' })).toThrow('only letters');
    expect(() => acquireStateLocks({ profile: 'CON' })).toThrow('reserved Windows');
    expect(() => acquireStateLocks({ session: 'lPt9' })).toThrow('reserved Windows');
    expect(fs.existsSync(getStateLocksDir())).toBe(false);
  });
});

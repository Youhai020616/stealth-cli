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
  withStateLock,
} from '../../src/utils/state-lock.js';
import { getStateLocksDir, getStealthHome } from '../../src/utils/storage-paths.js';

const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-state-lock-'));
const EXTRA_TEST_HOMES = new Set();
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

function staleLockRemovalHint(directoryPath) {
  return `After confirming no stealth process is using this state, remove this exact lock directory: ${directoryPath}`;
}

function currentUserId() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function onlyOwnerPath(directoryPath) {
  const entries = fs.readdirSync(directoryPath);
  expect(entries).toHaveLength(1);
  return path.join(directoryPath, entries[0]);
}

function readOwner(directoryPath) {
  const ownerPath = onlyOwnerPath(directoryPath);
  return {
    ownerPath,
    contents: fs.readFileSync(ownerPath, 'utf8'),
    metadata: JSON.parse(fs.readFileSync(ownerPath, 'utf8')),
  };
}

function createLockGeneration(kind, name, opts = {}) {
  const root = opts.root || getStealthHome();
  const directoryPath = stateLockPath(kind, name, root);
  const token = opts.token || crypto.randomUUID();
  const ownerPath = path.join(directoryPath, `${token}.owner.json`);
  const metadata = {
    token,
    root,
    kind,
    name: name.toLowerCase(),
    uid: currentUserId(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    ...opts.metadata,
  };

  fs.mkdirSync(path.dirname(directoryPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directoryPath, { mode: opts.directoryMode ?? 0o700 });
  if (opts.ownerType === 'directory') {
    fs.mkdirSync(ownerPath, { mode: 0o700 });
  } else if (opts.ownerType === 'symlink') {
    fs.symlinkSync(opts.symlinkTarget, ownerPath);
  } else {
    fs.writeFileSync(
      ownerPath,
      opts.contents ?? `${JSON.stringify(metadata)}\n`,
      { mode: opts.ownerMode ?? 0o600 },
    );
  }

  return { directoryPath, ownerPath, metadata, token };
}

function temporaryStealthHome(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `stealth-state-lock-${label}-`));
  EXTRA_TEST_HOMES.add(root);
  return root;
}

function startStateLockHolder(kind, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATE_LOCK_CHILD, kind, name], {
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
      env: { ...process.env, STEALTH_HOME: getStealthHome() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const exited = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal, stderr }));
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${kind} ${name} lock`));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!ready && stdout.includes('locked')) {
        ready = true;
        clearTimeout(timeout);
        resolve({ child, exited });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`Lock holder exited before ready (${code ?? signal}): ${stderr}`));
      }
    });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.STEALTH_HOME = TEST_STEALTH_HOME;
  fs.rmSync(getStateLocksDir(), { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_STEALTH_HOME === undefined) delete process.env.STEALTH_HOME;
  else process.env.STEALTH_HOME = ORIGINAL_STEALTH_HOME;
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
  for (const root of EXTRA_TEST_HOMES) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('state locks', () => {
  it('rejects a second writer and allows reuse after an idempotent release', () => {
    const releaseFirst = acquireStateLocks({ profile: 'work' });

    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('already in use');

    releaseFirst();
    releaseFirst();
    const releaseSecond = acquireStateLocks({ profile: 'work' });
    releaseSecond();
  });

  it('uses one canonical lock identity for case aliases and reports ownership', () => {
    const lease = acquireStateLocks({ profile: 'Work' });

    expect(lease.owns('profile', 'work')).toBe(true);
    expect(lease.owns('profile', 'WORK')).toBe(true);
    expect(lease.owns('session', 'work')).toBe(false);
    expect(ownsStateLock(lease, 'profile', 'WORK')).toBe(true);
    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('already in use');
    expect(fs.statSync(stateLockPath('profile', 'work')).isDirectory()).toBe(true);

    lease();
    expect(lease.owns('profile', 'work')).toBe(false);
    expect(ownsStateLock(lease, 'profile', 'work')).toBe(false);
  });

  it('releases earlier deterministic locks when a later target conflicts', () => {
    const releaseSession = acquireStateLocks({ session: 'login' });

    expect(() => acquireStateLocks({ profile: 'work', session: 'login' }))
      .toThrow('already in use');

    const releaseProfile = acquireStateLocks({ profile: 'work' });
    releaseProfile();
    releaseSession();
  });

  it('preserves acquisition errors and attaches rollback failures non-enumerably', () => {
    const releaseSession = acquireStateLocks({ session: 'login' });
    const profileDirectory = stateLockPath('profile', 'work');
    const unlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (typeof target === 'string' && path.dirname(target) === profileDirectory) {
        const error = new Error('profile lock busy');
        error.code = 'EBUSY';
        throw error;
      }
      return unlinkSync(target);
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
    expect(fs.existsSync(profileDirectory)).toBe(true);

    vi.restoreAllMocks();
    fs.rmSync(profileDirectory, { recursive: true, force: true });
    releaseSession();
  });

  it('fails closed without removing a generation owned by a dead local process', () => {
    const stalePid = 2_147_483_647;
    const { directoryPath, ownerPath, metadata } = createLockGeneration('profile', 'work', {
      metadata: {
        pid: stalePid,
        createdAt: new Date(0).toISOString(),
      },
    });

    let error;
    try {
      acquireStateLocks({ profile: 'work' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('stale lock');
    expect(error?.hint).toBe(staleLockRemovalHint(directoryPath));
    expect(JSON.parse(fs.readFileSync(ownerPath, 'utf8'))).toEqual(metadata);
    expect(fs.statSync(directoryPath).isDirectory()).toBe(true);
  });

  it('fails closed without removing empty or invalid lock directories', () => {
    const emptyDirectory = stateLockPath('profile', 'empty');
    fs.mkdirSync(emptyDirectory, { recursive: true, mode: 0o700 });

    let emptyError;
    try {
      acquireStateLocks({ profile: 'empty' });
    } catch (cause) {
      emptyError = cause;
    }
    expect(emptyError?.message).toContain('invalid stale lock');
    expect(emptyError?.hint).toBe(staleLockRemovalHint(emptyDirectory));
    expect(fs.readdirSync(emptyDirectory)).toEqual([]);

    const invalid = createLockGeneration('session', 'login', { contents: 'not-json' });
    let metadataError;
    try {
      acquireStateLocks({ session: 'login' });
    } catch (cause) {
      metadataError = cause;
    }
    expect(metadataError?.message).toContain('invalid stale lock');
    expect(metadataError?.hint).toBe(staleLockRemovalHint(invalid.directoryPath));
    expect(fs.readFileSync(invalid.ownerPath, 'utf8')).toBe('not-json');
  });

  it('rejects legacy files and unsafe owner child types without deleting them', () => {
    const locksDir = getStateLocksDir();
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const legacyPath = stateLockPath('profile', 'legacy');
    fs.writeFileSync(legacyPath, 'legacy-lock', { mode: 0o600 });

    let legacyError;
    try {
      acquireStateLocks({ profile: 'legacy' });
    } catch (cause) {
      legacyError = cause;
    }
    expect(legacyError?.message).toContain('lock directory is unsafe');
    expect(legacyError?.hint).toBe(staleLockRemovalHint(legacyPath));
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('legacy-lock');

    const invalidOwner = createLockGeneration('session', 'owner-dir', {
      ownerType: 'directory',
    });
    let ownerError;
    try {
      acquireStateLocks({ session: 'owner-dir' });
    } catch (cause) {
      ownerError = cause;
    }
    expect(ownerError?.message).toContain('owner metadata is unsafe');
    expect(ownerError?.hint).toBe(staleLockRemovalHint(invalidOwner.directoryPath));
    expect(fs.statSync(invalidOwner.ownerPath).isDirectory()).toBe(true);
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('validates lock directory and owner permissions without hardening contenders', () => {
    const unsafeDirectory = createLockGeneration('profile', 'directory-mode');
    fs.chmodSync(unsafeDirectory.directoryPath, 0o755);

    expect(() => acquireStateLocks({ profile: 'directory-mode' }))
      .toThrow('lock directory is unsafe');
    expect(fs.statSync(unsafeDirectory.directoryPath).mode & 0o777).toBe(0o755);

    const unsafeOwner = createLockGeneration('session', 'owner-mode');
    fs.chmodSync(unsafeOwner.ownerPath, 0o644);

    expect(() => acquireStateLocks({ session: 'owner-mode' }))
      .toThrow('owner metadata is unsafe');
    expect(fs.statSync(unsafeOwner.ownerPath).mode & 0o777).toBe(0o644);
  });

  it('rejects owner metadata bound to another root or user', () => {
    const wrongRoot = createLockGeneration('profile', 'wrong-root', {
      metadata: { root: temporaryStealthHome('metadata-root') },
    });
    expect(() => acquireStateLocks({ profile: 'wrong-root' }))
      .toThrow('invalid stale lock');
    expect(fs.existsSync(wrongRoot.ownerPath)).toBe(true);

    const wrongUid = createLockGeneration('session', 'wrong-user', {
      metadata: { uid: currentUserId() === null ? 1 : currentUserId() + 1 },
    });
    expect(() => acquireStateLocks({ session: 'wrong-user' }))
      .toThrow('invalid stale lock');
    expect(fs.existsSync(wrongUid.ownerPath)).toBe(true);
  });

  it('publishes owner-only lock directories with one UUID-specific metadata child', () => {
    const hardLink = vi.spyOn(fs, 'linkSync');
    const release = acquireStateLocks({ profile: 'work', session: 'login' });
    const locksDir = getStateLocksDir();
    const entries = fs.readdirSync(locksDir, { withFileTypes: true });

    expect(hardLink).not.toHaveBeenCalled();
    expect(entries).toHaveLength(2);
    const targets = [];
    for (const entry of entries) {
      expect(entry.isDirectory()).toBe(true);
      const directoryPath = path.join(locksDir, entry.name);
      const ownerPath = onlyOwnerPath(directoryPath);
      expect(path.basename(ownerPath)).toMatch(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.owner\.json$/,
      );
      const metadata = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      expect(metadata).toMatchObject({
        token: path.basename(ownerPath, '.owner.json'),
        root: getStealthHome(),
        uid: currentUserId(),
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: expect.any(String),
      });
      targets.push(`${metadata.kind}:${metadata.name}`);

      if (process.platform !== 'win32') {
        expect(fs.statSync(directoryPath).mode & 0o777).toBe(0o700);
        expect(fs.statSync(ownerPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(directoryPath).uid).toBe(currentUserId());
        expect(fs.statSync(ownerPath).uid).toBe(currentUserId());
      }
    }
    expect(targets.sort()).toEqual(['profile:work', 'session:login']);

    release();
    expect(fs.readdirSync(locksDir)).toEqual([]);
  });

  it('removes its partial generation when writing owner metadata fails', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    });

    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('Failed to acquire');
    expect(fs.readdirSync(getStateLocksDir())).toEqual([]);
  });

  it('keeps release and ownership retryable after a transient owner unlink failure', () => {
    const release = acquireStateLocks({ profile: 'work' });
    const directoryPath = stateLockPath('profile', 'work');
    const ownerPath = onlyOwnerPath(directoryPath);
    const unlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync')
      .mockImplementationOnce(() => {
        const error = new Error('busy');
        error.code = 'EBUSY';
        throw error;
      })
      .mockImplementation((target) => unlinkSync(target));

    expect(() => release()).toThrow('busy');
    expect(release.owns('profile', 'work')).toBe(true);
    expect(fs.existsSync(ownerPath)).toBe(true);
    release();
    expect(release.owns('profile', 'work')).toBe(false);
    expect(fs.existsSync(directoryPath)).toBe(false);
  });

  it('retries directory removal after owner unlink succeeded transiently', () => {
    const release = acquireStateLocks({ profile: 'work' });
    const directoryPath = stateLockPath('profile', 'work');
    const rmdirSync = fs.rmdirSync.bind(fs);
    vi.spyOn(fs, 'rmdirSync')
      .mockImplementationOnce(() => {
        const error = new Error('directory busy');
        error.code = 'EBUSY';
        throw error;
      })
      .mockImplementation((target) => rmdirSync(target));

    expect(() => release()).toThrow('directory busy');
    expect(release.owns('profile', 'work')).toBe(false);
    expect(fs.readdirSync(directoryPath)).toEqual([]);

    release();
    expect(fs.existsSync(directoryPath)).toBe(false);
    expect(() => release()).not.toThrow();
  });

  it('does not remove a successor that replaces the lock generation before old release', () => {
    const oldLease = acquireStateLocks({ profile: 'work' });
    const directoryPath = stateLockPath('profile', 'work');
    fs.rmSync(directoryPath, { recursive: true, force: true });

    const successor = acquireStateLocks({ profile: 'work' });
    const successorOwner = readOwner(directoryPath);

    expect(() => oldLease()).not.toThrow();
    expect(oldLease.owns('profile', 'work')).toBe(false);
    expect(fs.existsSync(directoryPath)).toBe(true);
    expect(fs.readFileSync(successorOwner.ownerPath, 'utf8')).toBe(successorOwner.contents);
    expect(successor.owns('profile', 'work')).toBe(true);

    successor();
  });

  it('does not remove a successor while retrying an old generation rmdir', () => {
    const oldLease = acquireStateLocks({ session: 'login' });
    const directoryPath = stateLockPath('session', 'login');
    vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => {
      const error = new Error('directory busy');
      error.code = 'EBUSY';
      throw error;
    });

    expect(() => oldLease()).toThrow('directory busy');
    expect(fs.readdirSync(directoryPath)).toEqual([]);

    vi.restoreAllMocks();
    fs.rmdirSync(directoryPath);
    const successor = acquireStateLocks({ session: 'login' });
    const successorOwner = readOwner(directoryPath);

    expect(() => oldLease()).not.toThrow();
    expect(fs.readFileSync(successorOwner.ownerPath, 'utf8')).toBe(successorOwner.contents);
    expect(successor.owns('session', 'login')).toBe(true);

    successor();
  });

  it('binds leases and cleanup paths to the resolved STEALTH_HOME root', () => {
    const originalRoot = getStealthHome();
    const oldLease = acquireStateLocks({ profile: 'work' });
    const originalDirectory = stateLockPath('profile', 'work', originalRoot);
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
      expect(fs.existsSync(stateLockPath('profile', 'work', newRoot))).toBe(false);

      const successor = acquireStateLocks({ profile: 'work' });
      const successorDirectory = stateLockPath('profile', 'work', newRoot);
      oldLease();
      expect(fs.existsSync(originalDirectory)).toBe(false);
      expect(fs.existsSync(successorDirectory)).toBe(true);
      expect(successor.owns('profile', 'work')).toBe(true);
      successor();
    } finally {
      process.env.STEALTH_HOME = TEST_STEALTH_HOME;
      fs.rmSync(originalDirectory, { recursive: true, force: true });
    }
  });

  it('revokes write authorization when owner metadata cannot be verified', () => {
    const release = acquireStateLocks({ profile: 'work' });
    const directoryPath = stateLockPath('profile', 'work');
    const ownerPath = onlyOwnerPath(directoryPath);
    fs.writeFileSync(ownerPath, 'invalid-metadata');

    expect(() => release()).toThrow('ownership could not be verified');
    expect(release.owns('profile', 'work')).toBe(false);
    expect(fs.existsSync(directoryPath)).toBe(true);

    fs.rmSync(directoryPath, { recursive: true, force: true });
    expect(() => release()).not.toThrow();
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
    expect(fs.existsSync(stateLockPath('session', 'login'))).toBe(false);

    await expect(withStateLock('session', 'Login', null, async () => 'async'))
      .resolves.toBe('async');
    expect(fs.existsSync(stateLockPath('session', 'login'))).toBe(false);
  });

  it('preserves callback errors with non-enumerable release diagnostics', () => {
    const primary = new Error('callback failed');
    const directoryPath = stateLockPath('profile', 'callback');
    vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => {
      const error = new Error('cleanup busy');
      error.code = 'EBUSY';
      throw error;
    });

    let thrown;
    try {
      withStateLock('profile', 'callback', null, () => {
        throw primary;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
    expect(thrown.cleanupFailures).toEqual([
      expect.objectContaining({ target: 'profile:callback' }),
    ]);
    expect(Object.getOwnPropertyDescriptor(thrown, 'cleanupFailures')?.enumerable).toBe(false);
    expect(Object.keys(thrown)).not.toContain('cleanupFailures');

    vi.restoreAllMocks();
    fs.rmdirSync(directoryPath);
  });

  it('does not replace a non-extensible primary error when release also fails', () => {
    const primary = Object.freeze(new Error('frozen callback failure'));
    const directoryPath = stateLockPath('session', 'frozen-callback');
    vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => {
      const error = new Error('cleanup busy');
      error.code = 'EBUSY';
      throw error;
    });

    let thrown;
    try {
      withStateLock('session', 'frozen-callback', null, () => {
        throw primary;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
    expect(Object.hasOwn(thrown, 'cleanupFailures')).toBe(false);

    vi.restoreAllMocks();
    fs.rmdirSync(directoryPath);
  });

  const symlinkIt = process.platform === 'win32' ? it.skip : it;
  symlinkIt('rejects a symbolic-link lock directory without deleting it', () => {
    const locksDir = getStateLocksDir();
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const outside = path.join(TEST_STEALTH_HOME, 'outside-lock-directory');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { mode: 0o700 });
    const directoryPath = stateLockPath('profile', 'work');
    fs.symlinkSync(outside, directoryPath);

    let error;
    try {
      acquireStateLocks({ profile: 'work' });
    } catch (cause) {
      error = cause;
    }
    expect(error?.message).toContain('lock directory is unsafe');
    expect(error?.hint).toBe(staleLockRemovalHint(directoryPath));
    expect(fs.lstatSync(directoryPath).isSymbolicLink()).toBe(true);
    expect(fs.statSync(outside).isDirectory()).toBe(true);
  });

  symlinkIt('rejects a symbolic-link owner child without following or deleting it', () => {
    const outside = path.join(TEST_STEALTH_HOME, 'outside-lock-owner');
    fs.writeFileSync(outside, 'outside', { mode: 0o600 });
    const generation = createLockGeneration('session', 'login', {
      ownerType: 'symlink',
      symlinkTarget: outside,
    });

    let error;
    try {
      acquireStateLocks({ session: 'login' });
    } catch (cause) {
      error = cause;
    }
    expect(error?.message).toContain('owner metadata is unsafe');
    expect(error?.hint).toBe(staleLockRemovalHint(generation.directoryPath));
    expect(fs.lstatSync(generation.ownerPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('rejects unsafe and Windows-reserved names before touching a lock path', () => {
    expect(() => acquireStateLocks({ profile: '../work' })).toThrow('only letters');
    expect(() => acquireStateLocks({ session: 'login.json' })).toThrow('only letters');
    expect(() => acquireStateLocks({ profile: 'CON' })).toThrow('reserved Windows');
    expect(() => acquireStateLocks({ session: 'lPt9' })).toThrow('reserved Windows');
    expect(fs.existsSync(getStateLocksDir())).toBe(false);
  });

  it('remains compatible with cross-process lock holders', async () => {
    const { child, exited } = await startStateLockHolder('profile', 'shared-profile');

    try {
      expect(() => acquireStateLocks({ profile: 'shared-profile' }))
        .toThrow('already in use');
    } finally {
      child.kill('SIGTERM');
    }

    const childResult = await exited;
    expect(childResult).toMatchObject({ code: 0, signal: null, stderr: '' });

    const release = acquireStateLocks({ profile: 'shared-profile' });
    release();
  }, 15_000);
});

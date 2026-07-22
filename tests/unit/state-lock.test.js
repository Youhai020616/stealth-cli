import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireStateLocks,
  ownsStateLock,
  withStateLock,
} from '../../src/utils/state-lock.js';
import { getStateLocksDir } from '../../src/utils/storage-paths.js';

const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-state-lock-'));
process.env.STEALTH_HOME = TEST_STEALTH_HOME;

function stateLockPath(kind, name) {
  const digest = crypto.createHash('sha256').update(`${kind}:${name.toLowerCase()}`).digest('hex');
  return path.join(getStateLocksDir(), `${digest}.lock`);
}

function staleLockRemovalHint(filePath) {
  return `After confirming no stealth process is using this state, remove this exact lock file: ${filePath}`;
}

beforeEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(getStateLocksDir(), { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_STEALTH_HOME === undefined) delete process.env.STEALTH_HOME;
  else process.env.STEALTH_HOME = ORIGINAL_STEALTH_HOME;
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
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
    expect(fs.existsSync(stateLockPath('profile', 'work'))).toBe(true);

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

  it('preserves the acquisition error and reports partial rollback failures', () => {
    const releaseSession = acquireStateLocks({ session: 'login' });
    const profilePath = stateLockPath('profile', 'work');
    const unlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === profilePath) {
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
    expect(fs.existsSync(profilePath)).toBe(true);

    vi.restoreAllMocks();
    fs.unlinkSync(profilePath);
    releaseSession();
  });

  it('fails closed without unlinking a lock owned by a dead local process', () => {
    const locksDir = getStateLocksDir();
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const filePath = stateLockPath('profile', 'work');
    const staleMetadata = {
      token: 'stale-token',
      kind: 'profile',
      name: 'work',
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: new Date(0).toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(staleMetadata), { mode: 0o600 });

    let error;
    try {
      acquireStateLocks({ profile: 'work' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('stale lock');
    expect(error?.hint).toBe(staleLockRemovalHint(filePath));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(staleMetadata);
  });

  it('fails closed without unlinking invalid lock metadata', () => {
    const locksDir = getStateLocksDir();
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const filePath = stateLockPath('session', 'login');
    fs.writeFileSync(filePath, 'not-json', { mode: 0o600 });

    let error;
    try {
      acquireStateLocks({ session: 'login' });
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('invalid stale lock');
    expect(error?.hint).toBe(staleLockRemovalHint(filePath));
    expect(fs.readFileSync(filePath, 'utf8')).toBe('not-json');
  });

  it('atomically publishes complete owner-only lock metadata', () => {
    const link = vi.spyOn(fs, 'linkSync');
    const release = acquireStateLocks({ profile: 'work', session: 'login' });
    const locksDir = getStateLocksDir();
    const files = fs.readdirSync(locksDir);

    expect(link).toHaveBeenCalledTimes(2);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const metadata = JSON.parse(fs.readFileSync(path.join(locksDir, file), 'utf8'));
      expect(metadata).toMatchObject({
        token: expect.any(String),
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: expect.any(String),
      });
    }
    if (process.platform !== 'win32') {
      expect(fs.statSync(locksDir).mode & 0o777).toBe(0o700);
      for (const file of files) {
        expect(fs.statSync(path.join(locksDir, file)).mode & 0o777).toBe(0o600);
      }
    }

    release();
  });

  it('removes a partially created lock when writing metadata fails', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    });

    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('Failed to acquire');
    expect(fs.readdirSync(getStateLocksDir())).toEqual([]);
  });

  it('falls back to exclusive publication and fails closed while metadata is incomplete', () => {
    const writeFileSync = fs.writeFileSync.bind(fs);
    let writeCount = 0;
    let contenderError;
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      const error = new Error('hard links unsupported');
      error.code = 'ENOTSUP';
      throw error;
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      writeCount += 1;
      if (writeCount === 2) {
        try {
          acquireStateLocks({ profile: 'work' });
        } catch (error) {
          contenderError = error;
        }
      }
      return writeFileSync(...args);
    });

    const release = acquireStateLocks({ profile: 'work' });
    const filePath = stateLockPath('profile', 'work');

    expect(contenderError?.message).toContain('invalid stale lock');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toMatchObject({
      kind: 'profile',
      name: 'work',
      pid: process.pid,
    });
    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('already in use');

    release();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('owner-verifies and removes a partial exclusive-publication lock after write failure', () => {
    const writeFileSync = fs.writeFileSync.bind(fs);
    let writeCount = 0;
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      const error = new Error('cross-device link');
      error.code = 'EXDEV';
      throw error;
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      writeCount += 1;
      if (writeCount === 2) {
        const error = new Error('disk full');
        error.code = 'ENOSPC';
        throw error;
      }
      return writeFileSync(...args);
    });

    expect(() => acquireStateLocks({ session: 'login' })).toThrow('Failed to acquire');
    expect(fs.readdirSync(getStateLocksDir())).toEqual([]);
  });

  it('keeps release and ownership retryable after a transient unlink failure', () => {
    const release = acquireStateLocks({ profile: 'work' });
    const filePath = stateLockPath('profile', 'work');
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
    expect(fs.existsSync(filePath)).toBe(true);
    release();
    expect(release.owns('profile', 'work')).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('revokes write ownership when release cannot verify metadata and remains retryable', () => {
    const release = acquireStateLocks({ profile: 'work' });
    const filePath = stateLockPath('profile', 'work');
    fs.writeFileSync(filePath, 'invalid-metadata', { mode: 0o600 });

    expect(() => release()).toThrow('ownership could not be verified');
    expect(release.owns('profile', 'work')).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);

    fs.unlinkSync(filePath);
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

  const symlinkIt = process.platform === 'win32' ? it.skip : it;
  symlinkIt('rejects a symbolic-link lock target without deleting it', () => {
    const locksDir = getStateLocksDir();
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const outside = path.join(TEST_STEALTH_HOME, 'outside-lock');
    fs.writeFileSync(outside, 'outside', { mode: 0o600 });
    const filePath = stateLockPath('profile', 'work');
    fs.symlinkSync(outside, filePath);

    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('lock path is unsafe');
    expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('rejects unsafe and Windows-reserved names before touching a lock path', () => {
    expect(() => acquireStateLocks({ profile: '../work' })).toThrow('only letters');
    expect(() => acquireStateLocks({ session: 'login.json' })).toThrow('only letters');
    expect(() => acquireStateLocks({ profile: 'CON' })).toThrow('reserved Windows');
    expect(() => acquireStateLocks({ session: 'lPt9' })).toThrow('reserved Windows');
    expect(fs.existsSync(getStateLocksDir())).toBe(false);
  });
});

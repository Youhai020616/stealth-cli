import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireStateLocks } from '../../src/utils/state-lock.js';
import { getStateLocksDir } from '../../src/utils/storage-paths.js';

const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-state-lock-'));
process.env.STEALTH_HOME = TEST_STEALTH_HOME;

function stateLockPath(kind, name) {
  const digest = crypto.createHash('sha256').update(`${kind}:${name}`).digest('hex');
  return path.join(getStateLocksDir(), `${digest}.lock`);
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
  it('rejects a second writer and allows reuse after release', () => {
    const releaseFirst = acquireStateLocks({ profile: 'work' });

    expect(() => acquireStateLocks({ profile: 'work' })).toThrow('already in use');

    releaseFirst();
    const releaseSecond = acquireStateLocks({ profile: 'work' });
    releaseSecond();
  });

  it('releases earlier deterministic locks when a later target conflicts', () => {
    const releaseSession = acquireStateLocks({ session: 'login' });

    expect(() => acquireStateLocks({ profile: 'work', session: 'login' }))
      .toThrow('already in use');

    const releaseProfile = acquireStateLocks({ profile: 'work' });
    releaseProfile();
    releaseSession();
  });

  it('recovers a lock owned by a dead local process', () => {
    const locksDir = getStateLocksDir();
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const filePath = stateLockPath('profile', 'work');
    fs.writeFileSync(filePath, JSON.stringify({
      token: 'stale-token',
      kind: 'profile',
      name: 'work',
      pid: 2_147_483_647,
      hostname: os.hostname(),
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });

    const release = acquireStateLocks({ profile: 'work' });
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(current.pid).toBe(process.pid);
    expect(current.token).not.toBe('stale-token');
    release();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('creates owner-only lock directories and files', () => {
    const release = acquireStateLocks({ profile: 'work', session: 'login' });
    const locksDir = getStateLocksDir();
    const files = fs.readdirSync(locksDir);

    expect(files).toHaveLength(2);
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

  it('keeps release retryable after a transient unlink failure', () => {
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
    expect(fs.existsSync(filePath)).toBe(true);
    release();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects unsafe profile and session names before touching a lock path', () => {
    expect(() => acquireStateLocks({ profile: '../work' })).toThrow('only letters');
    expect(() => acquireStateLocks({ session: 'login.json' })).toThrow('only letters');
    expect(fs.existsSync(getStateLocksDir())).toBe(false);
  });
});

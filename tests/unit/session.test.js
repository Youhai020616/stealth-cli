import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  getSession, saveSession, listSessions, deleteSession,
  captureSession, restoreSession, saveSessionSnapshot,
} from '../../src/session.js';
import { acquireStateLocks } from '../../src/utils/state-lock.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-sessions-'));
const SESSIONS_DIR = path.join(TEST_STEALTH_HOME, 'sessions');
process.env.STEALTH_HOME = TEST_STEALTH_HOME;

beforeEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(TEST_STEALTH_HOME, 'locks'), { recursive: true, force: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
});

afterAll(() => {
  if (ORIGINAL_STEALTH_HOME === undefined) delete process.env.STEALTH_HOME;
  else process.env.STEALTH_HOME = ORIGINAL_STEALTH_HOME;
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
});

function sessionFixture(overrides = {}) {
  return {
    name: 'fixture',
    profile: null,
    cookies: [],
    history: [],
    lastUrl: null,
    createdAt: new Date(0).toISOString(),
    lastAccess: null,
    ...overrides,
  };
}

function writeSessionFixture(fileName, session) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(SESSIONS_DIR, fileName),
    `${JSON.stringify(session)}\n`,
    { mode: 0o600 },
  );
}

function writeMainSerializedSession(name, overrides = {}) {
  const legacyBasename = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(SESSIONS_DIR, `${legacyBasename}.json`);
  const session = sessionFixture({ name, ...overrides });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });
  return filePath;
}

function supportsCaseSensitiveNames(directory) {
  const upper = path.join(directory, '__CaseProbe');
  const lower = path.join(directory, '__caseprobe');
  fs.writeFileSync(upper, 'upper');
  try {
    fs.writeFileSync(lower, 'lower', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(upper, { force: true });
    fs.rmSync(lower, { force: true });
  }
}

describe('session', () => {
  it('should create a new session with defaults', () => {
    const session = getSession('__test_new');
    expect(session.name).toBe('__test_new');
    expect(session.cookies).toEqual([]);
    expect(session.history).toEqual([]);
    expect(session.lastUrl).toBeNull();
    expect(session.profile).toBeNull();
  });

  it('should save and reload a session', () => {
    const session = getSession('__test_save');
    session.lastUrl = 'https://example.com';
    session.cookies = [{ name: 'sid', value: '123', domain: '.example.com', path: '/' }];
    session.history = ['https://example.com', 'https://example.com/about'];
    saveSession('__test_save', session);

    const reloaded = getSession('__test_save');
    expect(reloaded.lastUrl).toBe('https://example.com');
    expect(reloaded.cookies).toHaveLength(1);
    expect(reloaded.cookies[0].name).toBe('sid');
    expect(reloaded.history).toHaveLength(2);
    expect(reloaded.lastAccess).not.toBeNull();
    if (process.platform !== 'win32') {
      expect(fs.statSync(SESSIONS_DIR).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(SESSIONS_DIR, '__test_save.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('accepts fully validated URL-scoped session cookies', () => {
    const name = '__test_url_cookie';
    const cookie = {
      name: 'sid',
      value: '',
      url: 'https://example.com/account',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    };

    saveSession(name, sessionFixture({ name, cookies: [cookie] }));

    expect(getSession(name).cookies).toEqual([cookie]);
  });

  it('should accept safe session names and reject path-like names', () => {
    const session = getSession('__test_a_b_c_d');
    saveSession('__test_a_b_c_d', session);
    const reloaded = getSession('__test_a_b_c_d');
    expect(reloaded.name).toBe('__test_a_b_c_d');

    expect(() => getSession('../outside')).toThrow('only letters');
    expect(() => saveSession('session.json', session)).toThrow('only letters');
    expect(() => getSession('NUL')).toThrow('reserved Windows');
    expect(() => getSession('Lpt1')).toThrow('reserved Windows');
  });

  it('canonicalizes case aliases to one session file and identity', () => {
    const session = getSession('MixedCase');
    expect(session.name).toBe('mixedcase');
    saveSession('MIXEDCASE', session);

    expect(fs.existsSync(path.join(SESSIONS_DIR, 'mixedcase.json'))).toBe(true);
    expect(getSession('mixedcase').name).toBe('mixedcase');
    expect(getSession('MixedCase').lastAccess).not.toBeNull();
  });

  it('resolves mixed-case legacy filenames and normalizes embedded profile links', () => {
    writeSessionFixture('LegacyLogin.JSON', sessionFixture({
      name: 'LEGACYLOGIN',
      profile: 'Work',
      lastUrl: 'https://example.com',
    }));

    const loaded = getSession('legacylogin');
    expect(loaded.name).toBe('legacylogin');
    expect(loaded.profile).toBe('work');
    expect(listSessions()).toContainEqual(expect.objectContaining({
      name: 'legacylogin',
      profile: 'work',
    }));
  });

  it('migrates the exact session metadata shape serialized by main\'s old sanitizer', () => {
    const filePath = writeMainSerializedSession('login.prod', {
      profile: 'work.prod',
      lastUrl: 'https://example.com',
      history: ['https://example.com'],
    });

    const loaded = getSession('login_prod');
    expect(loaded.name).toBe('login_prod');
    expect(loaded.profile).toBe('work_prod');

    // An otherwise unchanged snapshot save must still persist canonical metadata.
    saveSessionSnapshot('login_prod', {
      cookies: loaded.cookies,
      lastUrl: loaded.lastUrl,
    });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toMatchObject({
      name: 'login_prod',
      profile: 'work_prod',
    });
  });

  it('detects case-insensitive session filename collisions on case-sensitive filesystems', () => {
    if (!supportsCaseSensitiveNames(SESSIONS_DIR)) return;
    writeSessionFixture('Login.json', sessionFixture({ name: 'Login' }));
    writeSessionFixture('login.JSON', sessionFixture({ name: 'login' }));

    expect(() => getSession('login')).toThrow('filename collisions');
    expect(() => listSessions()).toThrow('filename collisions');
  });

  it('uses canonical basenames and rejects mismatched or path-like embedded metadata', () => {
    writeSessionFixture('CanonicalSession.json', sessionFixture({ name: 'CanonicalSession' }));
    writeSessionFixture('RenamedSession.json', sessionFixture({ name: 'OldName' }));
    writeSessionFixture('UnsafeLink.json', sessionFixture({ profile: '../outside' }));

    expect(getSession('canonicalsession').name).toBe('canonicalsession');
    expect(() => getSession('renamedsession')).toThrow('invalid format');
    let error;
    try {
      getSession('unsafelink');
    } catch (cause) {
      error = cause;
    }
    expect(error?.name).toBe('ProfileError');
    expect(error?.code).toBe(8);
    expect(error?.message).toContain('invalid format');
    expect(listSessions()).toContainEqual({ name: 'renamedsession', error: 'corrupted' });
    expect(listSessions()).toContainEqual({ name: 'unsafelink', error: 'corrupted' });
  });

  it('should harden legacy session file permissions when loading', () => {
    if (process.platform === 'win32') return;
    const session = getSession('__test_legacy_mode');
    saveSession('__test_legacy_mode', session);
    const filePath = path.join(SESSIONS_DIR, '__test_legacy_mode.json');
    fs.chmodSync(filePath, 0o644);

    getSession('__test_legacy_mode');

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('should delete a session', () => {
    const session = getSession('__test_delete');
    saveSession('__test_delete', session);

    deleteSession('__test_delete');
    // After deletion, getSession returns a fresh session
    const fresh = getSession('__test_delete');
    expect(fresh.lastAccess).toBeNull();
  });

  it('should list sessions', () => {
    saveSession('__test_list1', { ...getSession('__test_list1'), lastUrl: 'https://a.com' });
    saveSession('__test_list2', { ...getSession('__test_list2'), lastUrl: 'https://b.com' });

    const list = listSessions();
    const testSessions = list.filter(s => s.name.startsWith('__test_list'));
    expect(testSessions.length).toBeGreaterThanOrEqual(2);
  });

  it('should capture one supplied cookie snapshot without querying context again', async () => {
    const cookies = [{ name: 'sid', value: '123', domain: 'example.com', path: '/' }];
    const context = { cookies: vi.fn() };
    const page = { url: vi.fn(() => 'https://example.com/account') };

    const session = await captureSession('__test_capture', context, page, {
      cookies,
      profile: 'Work',
    });

    expect(context.cookies).not.toHaveBeenCalled();
    expect(session.cookies).toEqual(cookies);
    expect(session.lastUrl).toBe('https://example.com/account');
    expect(session.profile).toBe('work');
  });

  it('locks every session mutation and reuses an owning lifetime lease', async () => {
    const name = '__test_locked';
    const lease = acquireStateLocks({ session: name });
    const session = getSession(name);
    const cookies = [{ name: 'sid', value: '123', domain: 'example.com', path: '/' }];
    const context = { cookies: vi.fn().mockResolvedValue(cookies) };
    const page = { url: vi.fn(() => 'https://example.com/account') };

    try {
      expect(() => saveSession(name, session)).toThrow('already in use');
      saveSession(name, session, { lease });

      expect(() => saveSessionSnapshot(name, { cookies, lastUrl: 'https://example.com' }))
        .toThrow('already in use');
      saveSessionSnapshot(name, { cookies, lastUrl: 'https://example.com' }, { lease });

      await expect(captureSession(name, context, page)).rejects.toThrow('already in use');
      await expect(captureSession(name, context, page, { lease })).resolves.toMatchObject({
        cookies,
        lastUrl: 'https://example.com/account',
      });

      expect(() => deleteSession(name)).toThrow('already in use');
      deleteSession(name, { lease });
      expect(getSession(name).lastAccess).toBeNull();
    } finally {
      lease();
    }
  });

  it('should keep profile cookies canonical when restoring a linked session', async () => {
    saveSessionSnapshot('__test_linked', {
      cookies: [{ name: 'sid', value: 'stale', domain: 'example.com', path: '/' }],
      lastUrl: 'https://example.com',
    }, { profile: 'Work' });
    const context = { addCookies: vi.fn() };

    const restored = await restoreSession('__test_linked', context, {
      expectedProfile: 'WORK',
      restoreCookies: false,
    });

    expect(restored.cookiesRestored).toBe(0);
    expect(context.addCookies).not.toHaveBeenCalled();
  });

  it('should reject changing an existing session profile binding while saving', () => {
    saveSessionSnapshot('__test_write_mismatch', {
      cookies: [],
      lastUrl: 'https://example.com',
    }, { profile: 'profile-a' });

    expect(() => saveSessionSnapshot('__test_write_mismatch', {
      cookies: [],
      lastUrl: 'https://example.com/account',
    }, { profile: 'profile-b' })).toThrow('belongs to profile');
  });

  it('should reject a session linked to a different profile', async () => {
    saveSessionSnapshot('__test_mismatch', {
      cookies: [],
      lastUrl: 'https://example.com',
    }, { profile: 'profile-a' });

    await expect(restoreSession('__test_mismatch', { addCookies: vi.fn() }, {
      expectedProfile: 'profile-b',
    })).rejects.toThrow('belongs to profile');
  });

  it('should surface cookie capture and restore failures', async () => {
    const page = { url: vi.fn(() => 'https://example.com') };
    await expect(captureSession(
      '__test_capture_error',
      { cookies: vi.fn().mockRejectedValue(new Error('browser disconnected')) },
      page,
    )).rejects.toThrow('browser disconnected');

    saveSessionSnapshot('__test_restore_error', {
      cookies: [{ name: 'sid', value: '123', domain: 'example.com', path: '/' }],
      lastUrl: 'https://example.com',
    });
    await expect(restoreSession(
      '__test_restore_error',
      { addCookies: vi.fn().mockRejectedValue(new Error('invalid cookie')) },
    )).rejects.toThrow('invalid cookie');
  });

  it('rejects malformed loaded sessions with ProfileError before browser use', () => {
    const validCookie = {
      name: 'sid',
      value: '123',
      domain: '.example.com',
      path: '/',
    };
    const malformedSessions = [
      () => [],
      (session) => ({ ...session, cookies: {} }),
      (session) => ({ ...session, history: {} }),
      (session) => ({ ...session, cookies: [null] }),
      (session) => ({ ...session, history: [42] }),
      (session) => ({ ...session, profile: 42 }),
      (session) => ({ ...session, lastUrl: {} }),
      (session) => ({ ...session, name: 42 }),
      (session) => ({ ...session, cookies: [{ ...validCookie, name: '' }] }),
      (session) => ({ ...session, cookies: [{ ...validCookie, value: null }] }),
      (session) => ({ ...session, cookies: [{ name: 'sid', value: '123', url: '' }] }),
      (session) => ({ ...session, cookies: [{ name: 'sid', value: '123', path: '/' }] }),
      (session) => ({ ...session, cookies: [{ ...validCookie, expires: false }] }),
      (session) => ({ ...session, cookies: [{ ...validCookie, httpOnly: 1 }] }),
      (session) => ({ ...session, cookies: [{ ...validCookie, secure: 'false' }] }),
      (session) => ({ ...session, cookies: [{ ...validCookie, sameSite: 'invalid' }] }),
    ];

    malformedSessions.forEach((mutate, index) => {
      const name = `malformed_${index}`;
      writeSessionFixture(
        `${name}.json`,
        mutate(sessionFixture({ name })),
      );
      let error;
      try {
        getSession(name);
      } catch (cause) {
        error = cause;
      }
      expect(error?.name).toBe('ProfileError');
      expect(error?.code).toBe(8);
      expect(error?.message).toContain('invalid format');
      expect(error).not.toBeInstanceOf(TypeError);
    });
  });

  it('rejects malformed session cookie snapshots before persisting them', () => {
    expect(() => saveSessionSnapshot('__test_bad_cookie', {
      cookies: [{ name: 'sid', value: '123', domain: '.example.com' }],
      lastUrl: null,
    })).toThrow('invalid cookie snapshot');
  });

  it('distinguishes unreadable session files from corrupted JSON', () => {
    const name = '__test_permission';
    saveSession(name, getSession(name));
    const filePath = path.join(SESSIONS_DIR, `${name}.json`);
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
      if (path.resolve(String(target)) === filePath) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return readFileSync(target, ...args);
    });

    let permissionError;
    try {
      getSession(name);
    } catch (cause) {
      permissionError = cause;
    }
    expect(permissionError?.code).toBe(8);
    expect(permissionError?.message).toContain('could not be read');
    expect(permissionError?.message).not.toContain('corrupted');

    vi.restoreAllMocks();
    fs.writeFileSync(filePath, '{bad-json', { mode: 0o600 });
    expect(() => getSession(name)).toThrow('corrupted');
  });

  const symlinkIt = process.platform === 'win32' ? it.skip : it;
  symlinkIt('rejects a symbolic-link session file without following it', () => {
    const outside = path.join(TEST_STEALTH_HOME, 'outside-session.json');
    fs.writeFileSync(outside, JSON.stringify(sessionFixture({ name: 'linked' })), {
      mode: 0o600,
    });
    fs.symlinkSync(outside, path.join(SESSIONS_DIR, 'linked.json'));

    expect(() => getSession('linked')).toThrow('cannot be accessed securely');
    expect(listSessions()).toContainEqual({ name: 'linked', error: 'unreadable' });
    expect(JSON.parse(fs.readFileSync(outside, 'utf8')).name).toBe('linked');
  });

  it('should preserve session data across saves', () => {
    const session = getSession('__test_persist');
    session.lastUrl = 'https://first.com';
    session.profile = 'us-desktop';
    saveSession('__test_persist', session);

    // Update and save again
    const loaded = getSession('__test_persist');
    loaded.lastUrl = 'https://second.com';
    loaded.history.push('https://first.com');
    saveSession('__test_persist', loaded);

    const final = getSession('__test_persist');
    expect(final.lastUrl).toBe('https://second.com');
    expect(final.profile).toBe('us-desktop');
    expect(final.history).toContain('https://first.com');
  });
});

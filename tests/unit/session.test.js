import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  getSession, saveSession, listSessions, deleteSession,
  captureSession, restoreSession, saveSessionSnapshot,
} from '../../src/session.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-sessions-'));
const SESSIONS_DIR = path.join(TEST_STEALTH_HOME, 'sessions');
process.env.STEALTH_HOME = TEST_STEALTH_HOME;

beforeEach(() => {
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
});

afterAll(() => {
  if (ORIGINAL_STEALTH_HOME === undefined) delete process.env.STEALTH_HOME;
  else process.env.STEALTH_HOME = ORIGINAL_STEALTH_HOME;
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
});

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
    session.cookies = [{ name: 'sid', value: '123', domain: '.example.com' }];
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

  it('should accept safe session names and reject path-like names', () => {
    const session = getSession('__test_a_b_c_d');
    saveSession('__test_a_b_c_d', session);
    const reloaded = getSession('__test_a_b_c_d');
    expect(reloaded.name).toBe('__test_a_b_c_d');

    expect(() => getSession('../outside')).toThrow('only letters');
    expect(() => saveSession('session.json', session)).toThrow('only letters');
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
      profile: 'work',
    });

    expect(context.cookies).not.toHaveBeenCalled();
    expect(session.cookies).toEqual(cookies);
    expect(session.lastUrl).toBe('https://example.com/account');
    expect(session.profile).toBe('work');
  });

  it('should keep profile cookies canonical when restoring a linked session', async () => {
    saveSessionSnapshot('__test_linked', {
      cookies: [{ name: 'sid', value: 'stale', domain: 'example.com', path: '/' }],
      lastUrl: 'https://example.com',
    }, { profile: 'work' });
    const context = { addCookies: vi.fn() };

    const restored = await restoreSession('__test_linked', context, {
      expectedProfile: 'work',
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

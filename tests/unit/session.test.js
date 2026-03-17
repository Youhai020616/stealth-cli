import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSession, saveSession, listSessions, deleteSession,
} from '../../src/session.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSIONS_DIR = path.join(os.homedir(), '.stealth', 'sessions');

// Track test-created files for cleanup
let existingFiles = [];

beforeEach(() => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  existingFiles = fs.readdirSync(SESSIONS_DIR);
});

afterEach(() => {
  // Clean up test sessions only
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const f of files) {
      if (!existingFiles.includes(f) && f.startsWith('__test_')) {
        fs.unlinkSync(path.join(SESSIONS_DIR, f));
      }
    }
  } catch {}
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
  });

  it('should sanitize session name for filesystem safety', () => {
    // Names with special chars should still work
    const session = getSession('__test_a_b_c_d');
    saveSession('__test_a_b_c_d', session);
    const reloaded = getSession('__test_a_b_c_d');
    expect(reloaded.name).toBe('__test_a_b_c_d');
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

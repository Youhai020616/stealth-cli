import { inspect } from 'node:util';
import { describe, it, expect } from 'vitest';
import {
  StealthError,
  BrowserLaunchError,
  BrowserCleanupError,
  NavigationError,
  ExtractionError,
  TimeoutError,
  ProxyError,
  ProfileError,
  PersistenceError,
  BlockedError,
  attachCleanupFailures,
  handleError,
  safeUrlForDisplay,
} from '../../src/errors.js';

describe('error classes', () => {
  it('StealthError should have code, hint, format(), and a non-enumerable cause', () => {
    const cause = new Error('raw cause');
    const err = new StealthError('test error', { code: 5, hint: 'try this', cause });
    expect(err.message).toBe('test error');
    expect(err.code).toBe(5);
    expect(err.hint).toBe('try this');
    expect(err.format()).toContain('test error');
    expect(err.format()).toContain('try this');
    expect(err.cause).toBe(cause);
    expect(Object.prototype.propertyIsEnumerable.call(err, 'cause')).toBe(false);
    expect(err instanceof Error).toBe(true);
  });

  it('StealthError defaults to code 1 and no hint', () => {
    const err = new StealthError('basic');
    expect(err.code).toBe(1);
    expect(err.hint).toBeNull();
    expect(err.format()).toBe('basic');
  });

  it('BrowserLaunchError should have code 3 and default hint', () => {
    const err = new BrowserLaunchError('browser failed');
    expect(err.code).toBe(3);
    expect(err.hint).toContain('camoufox-js fetch');
    expect(err.name).toBe('BrowserLaunchError');
  });

  it('BrowserCleanupError should use a cleanup-specific hint and retain failures', () => {
    const failure = { target: 'browser', error: new Error('busy') };
    const err = new BrowserCleanupError('cleanup failed', { failures: [failure] });

    expect(err.code).toBe(1);
    expect(err.hint).toContain('Retry closing');
    expect(err.hint).not.toContain('camoufox-js fetch');
    expect(err.failures).toEqual([failure]);
  });

  it('NavigationError should detect timeout cause', () => {
    const cause = new Error('page.goto: Timeout 30000ms exceeded');
    const err = new NavigationError('https://example.com', cause);
    expect(err.code).toBe(4);
    expect(err.hint).toContain('timed out');
    expect(err.url).toBe('https://example.com');
  });

  it('NavigationError should retain the raw URL only in url while redacting display text', () => {
    const rawUrl = 'https://user:password@example.com/callback?code=secret#token';
    const err = new NavigationError(rawUrl, new Error(`failed for ${rawUrl}`));

    expect(err.url).toBe(rawUrl);
    expect(Object.prototype.propertyIsEnumerable.call(err, 'url')).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(err, 'cause')).toBe(false);
    expect(err.message).toBe('Failed to navigate to https://example.com');
    expect(err.format()).not.toContain('password');
    expect(err.format()).not.toContain('callback');
    expect(err.format()).not.toContain('secret');
    expect(err.format()).not.toContain('token');

    const serialized = JSON.stringify(err);
    const consoleShape = inspect(err);
    const enumerableShape = JSON.stringify({ ...err });
    for (const shape of [serialized, consoleShape, enumerableShape]) {
      expect(shape).not.toContain('password');
      expect(shape).not.toContain('callback');
      expect(shape).not.toContain('secret');
      expect(shape).not.toContain('token');
    }
    expect(JSON.parse(serialized)).toEqual({
      message: 'Failed to navigate to https://example.com',
      code: 4,
      hint: 'Check the URL and your network connection',
    });
  });

  it('should use a generic safe label for malformed secret-bearing URLs', () => {
    const rawUrl = 'not-a-url?token=super-secret';
    const err = new NavigationError(rawUrl, new Error('failed'));

    expect(safeUrlForDisplay(rawUrl)).toBe('requested URL');
    expect(err.message).toBe('Failed to navigate to requested URL');
    expect(err.format()).not.toContain('super-secret');
  });

  it('NavigationError should detect network cause', () => {
    const cause = new Error('net::ERR_CONNECTION_REFUSED');
    const err = new NavigationError('https://example.com', cause);
    expect(err.hint).toContain('Network error');
  });

  it('NavigationError should have generic hint for unknown cause', () => {
    const err = new NavigationError('https://example.com', new Error('unknown'));
    expect(err.hint).toContain('Check the URL');
  });

  it('ExtractionError should have code 5', () => {
    const err = new ExtractionError('no results found');
    expect(err.code).toBe(5);
    expect(err.hint).toContain('snapshot');
  });

  it('TimeoutError should include operation and duration', () => {
    const err = new TimeoutError('screenshot', 5000);
    expect(err.message).toContain('screenshot');
    expect(err.message).toContain('5000ms');
    expect(err.code).toBe(6);
  });

  it('ProxyError should have code 7', () => {
    const err = new ProxyError('http://proxy:8080', new Error('refused'));
    expect(err.code).toBe(7);
    expect(err.hint).toContain('proxy test');
  });

  it('ProfileError should have code 8', () => {
    const err = new ProfileError('profile not found');
    expect(err.code).toBe(8);
    expect(err.hint).toContain('profile list');
  });

  it('PersistenceError should preserve partial target results without serializing internals', () => {
    const err = new PersistenceError('save failed', {
      cause: new Error('write failed for https://example.com/callback?token=cause-secret'),
      results: { profile: null, session: { name: 'login' } },
      failures: [{ target: 'profile', name: 'work' }],
      snapshot: { cookies: [{ name: 'sid', value: 'super-secret' }] },
      snapshotMetadata: { cookieCount: 1 },
    });
    expect(err.code).toBe(8);
    expect(err.results.session.name).toBe('login');
    expect(err.failures).toHaveLength(1);
    expect(JSON.stringify(err)).toBe(JSON.stringify({
      message: 'save failed',
      code: 8,
      hint: 'Authentication state was not fully saved; keep the browser open and retry',
    }));
    expect(inspect(err)).not.toContain('cause-secret');
    expect(JSON.stringify({ ...err })).not.toContain('super-secret');
  });

  it('should serialize and format only sanitized cleanup summaries', () => {
    const exactHint = 'After confirming no stealth process is using this state, remove this exact lock file: /tmp/locks/abc.lock';
    const lockError = new ProfileError('release failed', {
      hint: exactHint,
      cause: new Error('https://example.com/callback?token=nested-secret'),
    });
    const wrappedCleanupError = new BrowserCleanupError('cleanup failed', {
      cause: lockError,
    });
    const err = attachCleanupFailures(
      new NavigationError(
        'https://example.com/callback?token=primary-secret',
        new Error('https://example.com/callback?token=cause-secret'),
      ),
      [{ target: 'state-lock', error: wrappedCleanupError }],
    );

    const serialized = JSON.stringify(err);
    expect(JSON.parse(serialized).cleanupFailures).toEqual([
      { target: 'state-lock', hint: exactHint },
    ]);
    expect(err.format()).toContain('Cleanup incomplete: state-lock');
    expect(err.format()).toContain(exactHint);
    expect(inspect(err)).toContain(exactHint);
    for (const secret of ['primary-secret', 'cause-secret', 'nested-secret', 'callback']) {
      expect(serialized).not.toContain(secret);
      expect(inspect(err)).not.toContain(secret);
    }
  });

  it('BlockedError should include engine name', () => {
    const err = new BlockedError('google', 'https://google.com/sorry');
    expect(err.message).toContain('google');
    expect(err.hint).toContain('--proxy');
    expect(err.url).toBe('https://google.com/sorry');
  });
});

describe('handleError', () => {
  it('should return correct exit code for StealthError (no exit)', () => {
    const messages = [];
    const mockLog = {
      error: (msg) => messages.push({ level: 'error', msg }),
      dim: (msg) => messages.push({ level: 'dim', msg }),
    };

    const err = new NavigationError('https://example.com', new Error('timeout'));
    const code = handleError(err, { log: mockLog, exit: false });

    expect(code).toBe(4);
    expect(messages.some(m => m.level === 'error' && m.msg.includes('navigate'))).toBe(true);
    expect(messages.some(m => m.level === 'dim' && m.msg.includes('Hint'))).toBe(true);
  });

  it('should report cleanup targets and exact nested hints without raw causes', () => {
    const messages = [];
    const mockLog = {
      error: (msg) => messages.push({ level: 'error', msg }),
      dim: (msg) => messages.push({ level: 'dim', msg }),
    };
    const exactHint = 'After confirming ownership, remove this exact lock file: /tmp/locks/abc.lock';
    const err = attachCleanupFailures(
      new NavigationError('https://example.com/callback?token=primary-secret', new Error('timeout')),
      [{
        target: 'state-lock',
        error: new ProfileError('lock failed', {
          hint: exactHint,
          cause: new Error('https://example.com/callback?token=cleanup-secret'),
        }),
      }],
    );

    expect(handleError(err, { log: mockLog, exit: false })).toBe(4);
    const output = messages.map(({ msg }) => msg).join('\n');
    expect(output).toContain('Cleanup incomplete: state-lock');
    expect(output).toContain(exactHint);
    expect(output).not.toContain('primary-secret');
    expect(output).not.toContain('cleanup-secret');
    expect(output).not.toContain('callback');
  });

  it('should return 1 for unknown errors and detect ECONNREFUSED', () => {
    const messages = [];
    const mockLog = {
      error: (msg) => messages.push({ level: 'error', msg }),
      dim: (msg) => messages.push({ level: 'dim', msg }),
    };

    const code = handleError(new Error('ECONNREFUSED'), { log: mockLog, exit: false });

    expect(code).toBe(1);
    expect(messages.some(m => m.msg.includes('Connection refused'))).toBe(true);
  });

  it('should return 1 for unknown errors and detect ENOTFOUND', () => {
    const messages = [];
    const mockLog = {
      error: (msg) => messages.push({ level: 'error', msg }),
      dim: (msg) => messages.push({ level: 'dim', msg }),
    };

    const code = handleError(new Error('ENOTFOUND'), { log: mockLog, exit: false });
    expect(messages.some(m => m.msg.includes('DNS'))).toBe(true);
  });

  it('should return 1 for unknown errors and detect timeout', () => {
    const messages = [];
    const mockLog = {
      error: (msg) => messages.push({ level: 'error', msg }),
      dim: (msg) => messages.push({ level: 'dim', msg }),
    };

    const code = handleError(new Error('operation timeout'), { log: mockLog, exit: false });
    expect(messages.some(m => m.msg.includes('--retries'))).toBe(true);
  });

  it('should handle unknown error with no matching pattern', () => {
    const messages = [];
    const mockLog = {
      error: (msg) => messages.push({ level: 'error', msg }),
      dim: (msg) => messages.push({ level: 'dim', msg }),
    };

    const code = handleError(new Error('something weird'), { log: mockLog, exit: false });
    expect(code).toBe(1);
    expect(messages.length).toBe(1); // just the error, no hint
  });
});

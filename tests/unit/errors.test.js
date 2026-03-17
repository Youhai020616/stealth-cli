import { describe, it, expect } from 'vitest';
import {
  StealthError,
  BrowserLaunchError,
  NavigationError,
  ExtractionError,
  TimeoutError,
  ProxyError,
  ProfileError,
  BlockedError,
  handleError,
} from '../../src/errors.js';

describe('error classes', () => {
  it('StealthError should have code, hint, and format()', () => {
    const err = new StealthError('test error', { code: 5, hint: 'try this' });
    expect(err.message).toBe('test error');
    expect(err.code).toBe(5);
    expect(err.hint).toBe('try this');
    expect(err.format()).toContain('test error');
    expect(err.format()).toContain('try this');
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

  it('NavigationError should detect timeout cause', () => {
    const cause = new Error('page.goto: Timeout 30000ms exceeded');
    const err = new NavigationError('https://example.com', cause);
    expect(err.code).toBe(4);
    expect(err.hint).toContain('timed out');
    expect(err.url).toBe('https://example.com');
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

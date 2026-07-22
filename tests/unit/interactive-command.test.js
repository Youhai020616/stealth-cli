import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

class MockReadline extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  prompt() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

const spinner = { stop: vi.fn() };
spinner.start = vi.fn(() => spinner);

vi.mock('readline', () => ({
  createInterface: vi.fn(() => new MockReadline()),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => spinner),
}));

vi.mock('../../src/browser.js', () => ({
  launchBrowser: vi.fn(),
  closeBrowser: vi.fn(),
  navigate: vi.fn(),
  getSnapshot: vi.fn(),
  getA11ySnapshot: vi.fn(),
  getTextContent: vi.fn(),
  getUrl: vi.fn(),
  getTitle: vi.fn(),
  evaluate: vi.fn(),
  takeScreenshot: vi.fn(),
  waitForReady: vi.fn(),
  clickRef: vi.fn(),
  typeRef: vi.fn(),
}));

vi.mock('../../src/browser-lifecycle.js', () => ({
  createBrowserLifecycle: vi.fn(),
  createLaunchSignalGuard: vi.fn(() => ({
    transferTo: vi.fn((lifecycle) => lifecycle.start()),
    dispose: vi.fn(),
    pendingSignal: null,
    exitCode: 0,
  })),
}));

vi.mock('../../src/macros.js', () => ({
  expandMacro: vi.fn(),
  getSupportedEngines: vi.fn(() => ['google']),
}));

vi.mock('../../src/humanize.js', () => ({
  humanClick: vi.fn(),
  humanType: vi.fn(),
  humanScroll: vi.fn(),
  randomDelay: vi.fn(),
}));

vi.mock('../../src/utils/resolve-opts.js', () => ({
  resolveOpts: vi.fn((opts) => opts),
}));

vi.mock('../../src/output.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
  },
}));

import { launchBrowser, navigate } from '../../src/browser.js';
import { createBrowserLifecycle } from '../../src/browser-lifecycle.js';
import { registerInteractive } from '../../src/commands/interactive.js';
import { NavigationError, ProfileError } from '../../src/errors.js';
import { log } from '../../src/output.js';

describe('interactive command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    launchBrowser.mockResolvedValue({
      isDaemon: false,
      browser: {},
      context: {},
      page: {},
      _meta: { profileName: 'work', sessionName: 'login' },
    });
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue({
        reason: 'last-page-closed',
        signal: null,
        exitCode: 0,
        usedCheckpointFallback: false,
      }),
      requestExit: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('should accept and forward profile/session options', async () => {
    const program = new Command();
    program.exitOverride();
    registerInteractive(program);

    await program.parseAsync([
      'interactive',
      '--profile',
      'work',
      '--session',
      'login',
      '--no-headless',
    ], { from: 'user' });

    expect(launchBrowser).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'work',
      session: 'login',
      headless: false,
      handleSignals: false,
      restoreSessionUrl: true,
    }));
  });

  it('should skip a saved session URL when --url is explicit', async () => {
    const program = new Command();
    program.exitOverride();
    registerInteractive(program);

    await program.parseAsync([
      'interactive',
      '--url',
      'https://example.com',
      '--session',
      'login',
    ], { from: 'user' });

    expect(launchBrowser).toHaveBeenCalledWith(expect.objectContaining({
      restoreSessionUrl: false,
    }));
    expect(navigate).toHaveBeenCalledWith(expect.any(Object), 'https://example.com');
  });

  it('should preserve a signal result when navigation failure loses finalization arbitration', async () => {
    const signalResult = {
      reason: 'signal',
      signal: 'SIGINT',
      exitCode: 130,
      usedCheckpointFallback: false,
      cleanupErrors: [],
    };
    const requestExit = vi.fn().mockResolvedValue(signalResult);
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue(signalResult),
      requestExit,
    });
    navigate.mockRejectedValue(new Error('page closed during navigation'));
    const program = new Command();
    program.exitOverride();
    registerInteractive(program);

    await program.parseAsync([
      'interactive',
      '--url',
      'https://example.com',
      '--profile',
      'work',
    ], { from: 'user' });

    expect(requestExit).toHaveBeenCalledWith('command-error');
    expect(process.exitCode).toBe(130);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('should attach and report command-error cleanup failures without replacing the primary error', async () => {
    const rawUrl = 'https://example.com/callback?token=primary-secret';
    const primaryError = new NavigationError(rawUrl, new Error(`failed for ${rawUrl}`));
    const exactHint = 'After confirming no stealth process is using this state, remove this exact lock file: /tmp/locks/abc.lock';
    const cleanupError = new ProfileError('state lock release failed', {
      hint: exactHint,
      cause: new Error('https://example.com/callback?token=cleanup-secret'),
    });
    const requestExit = vi.fn().mockResolvedValue({
      reason: 'command-error',
      signal: null,
      exitCode: 1,
      usedCheckpointFallback: false,
      cleanupErrors: [{ target: 'state-lock', error: cleanupError }],
    });
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn(),
      requestExit,
    });
    navigate.mockRejectedValue(primaryError);
    const program = new Command();
    program.exitOverride();
    registerInteractive(program);

    await program.parseAsync([
      'interactive',
      '--url',
      rawUrl,
      '--profile',
      'work',
    ], { from: 'user' });

    expect(requestExit).toHaveBeenCalledWith('command-error');
    expect(primaryError.cleanupFailures).toEqual([
      { target: 'state-lock', error: cleanupError },
    ]);
    expect(process.exitCode).toBe(4);
    const output = log.dim.mock.calls.flat().join('\n');
    expect(output).toContain('Cleanup incomplete: state-lock');
    expect(output).toContain(exactHint);
    expect(output).not.toContain('primary-secret');
    expect(output).not.toContain('cleanup-secret');
    expect(output).not.toContain('callback');
  });

  it('should preserve a signal result when cookie loading fails during finalization', async () => {
    const signalResult = {
      reason: 'signal',
      signal: 'SIGTERM',
      exitCode: 143,
      usedCheckpointFallback: false,
      cleanupErrors: [],
    };
    const requestExit = vi.fn().mockResolvedValue(signalResult);
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue(signalResult),
      requestExit,
    });
    const program = new Command();
    program.exitOverride();
    registerInteractive(program);

    await program.parseAsync([
      'interactive',
      '--cookies',
      '/definitely/missing/stealth-cookies.txt',
      '--profile',
      'work',
    ], { from: 'user' });

    expect(requestExit).toHaveBeenCalledWith('command-error');
    expect(process.exitCode).toBe(143);
    expect(log.error).not.toHaveBeenCalled();
  });
});

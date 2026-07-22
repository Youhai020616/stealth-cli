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

vi.mock('../../src/browser-lifecycle.js', async (importOriginal) => ({
  ...await importOriginal(),
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
import {
  createBrowserLifecycle,
  createLaunchSignalGuard,
} from '../../src/browser-lifecycle.js';
import { registerInteractive } from '../../src/commands/interactive.js';
import {
  BrowserLaunchError,
  NavigationError,
  PersistenceError,
  ProfileError,
  attachCleanupFailures,
} from '../../src/errors.js';
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

  it('retains complete lifecycle evidence when command-error persistence is incomplete', async () => {
    const primaryError = new NavigationError(
      'https://example.com/callback?token=primary-secret',
      new Error('navigation failed'),
    );
    const finalCaptureError = new Error(
      'capture failed at https://example.com/callback?token=capture-secret',
    );
    const cleanupError = new Error(
      'cleanup failed at https://example.com/callback?token=cleanup-secret',
    );
    const result = {
      reason: 'command-error',
      signal: null,
      exitCode: 8,
      persistence: { profile: { name: 'work', cookies: 1 }, session: null },
      persistedAt: new Date().toISOString(),
      usedCheckpointFallback: true,
      persistenceIncomplete: true,
      finalCaptureError,
      cleanupErrors: [{ target: 'browser', error: cleanupError }],
      cleanup: {
        persistenceError: null,
        cleanupErrors: [{ target: 'browser', error: cleanupError }],
      },
    };
    const requestExit = vi.fn().mockResolvedValue(result);
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
      'https://example.com',
      '--profile',
      'work',
    ], { from: 'user' });

    expect(primaryError.cleanupFailures).toHaveLength(1);
    const persistenceFailure = primaryError.cleanupFailures[0];
    expect(persistenceFailure).toMatchObject({
      target: 'persistence',
      error: {
        name: 'PersistenceError',
        cause: finalCaptureError,
        cleanupFailures: [{ target: 'browser', error: cleanupError }],
      },
    });
    expect(persistenceFailure.error.lifecycleResult).toBe(result);
    expect(Object.getOwnPropertyDescriptor(
      persistenceFailure.error,
      'lifecycleResult',
    )?.enumerable).toBe(false);
    expect(process.exitCode).toBe(4);
    const output = log.dim.mock.calls.flat().join('\n');
    expect(output).toContain('Cleanup incomplete: persistence');
    expect(output).toContain('Cleanup incomplete: browser');
    expect(output).not.toContain('primary-secret');
    expect(output).not.toContain('capture-secret');
    expect(output).not.toContain('cleanup-secret');
  });

  it('retains a thrown lifecycle PersistenceError as one whole cleanup failure', async () => {
    const primaryError = new NavigationError('https://example.com', new Error('navigation failed'));
    const cleanupError = new Error('browser still connected');
    const lifecycleError = new PersistenceError('final persistence failed', {
      cause: new Error('capture unavailable'),
      cleanupFailures: [{ target: 'browser', error: cleanupError }],
      failures: [{ target: 'profile', name: 'work' }],
    });
    const requestExit = vi.fn().mockRejectedValue(lifecycleError);
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
      'https://example.com',
      '--profile',
      'work',
    ], { from: 'user' });

    expect(primaryError.cleanupFailures).toEqual([
      { target: 'persistence', error: lifecycleError },
    ]);
    expect(primaryError.cleanupFailures[0].error).toBe(lifecycleError);
    expect(lifecycleError.cleanupFailures).toEqual([
      { target: 'browser', error: cleanupError },
    ]);
    expect(process.exitCode).toBe(4);
  });

  it('reports inherited launch cleanup failures when a pending signal replaces the error', async () => {
    const exactHint = 'After confirming no stealth process is using this state, remove this exact lock file: /tmp/locks/abc.lock';
    const cleanupError = new ProfileError('state lock release failed', {
      hint: exactHint,
      cause: new Error('https://example.com/callback?token=cleanup-secret'),
    });
    const launchError = attachCleanupFailures(
      new BrowserLaunchError('browser launch failed', {
        cause: new Error('https://example.com/callback?token=launch-secret'),
      }),
      [{ target: 'state-lock', error: cleanupError }],
    );
    createLaunchSignalGuard.mockReturnValueOnce({
      transferTo: vi.fn(),
      dispose: vi.fn(),
      pendingSignal: 'SIGTERM',
      exitCode: 143,
    });
    launchBrowser.mockRejectedValueOnce(launchError);
    const program = new Command();
    program.exitOverride();
    registerInteractive(program);

    await program.parseAsync(['interactive'], { from: 'user' });

    expect(process.exitCode).toBe(143);
    expect(log.error).toHaveBeenCalledWith('Interrupted by SIGTERM');
    const output = log.dim.mock.calls.flat().join('\n');
    expect(output).toContain('Cleanup incomplete: state-lock');
    expect(output).toContain(exactHint);
    expect(output).not.toContain('launch-secret');
    expect(output).not.toContain('cleanup-secret');
    expect(output).not.toContain('callback');
    expect(launchError.cleanupFailures).toEqual([
      { target: 'state-lock', error: cleanupError },
    ]);
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

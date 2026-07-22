import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const spinner = {
  text: '',
  start: vi.fn(() => spinner),
  stop: vi.fn(),
};

vi.mock('ora', () => ({
  default: vi.fn(() => spinner),
}));

vi.mock('../../src/browser.js', () => ({
  launchBrowser: vi.fn(),
  closeBrowser: vi.fn(),
  navigate: vi.fn(),
  waitForReady: vi.fn(),
}));

vi.mock('../../src/browser-lifecycle.js', async (importOriginal) => ({
  ...await importOriginal(),
  DEFAULT_CHECKPOINT_INTERVAL: 1000,
  createBrowserLifecycle: vi.fn(),
  createLaunchSignalGuard: vi.fn(() => ({
    transferTo: vi.fn((lifecycle) => lifecycle.start()),
    dispose: vi.fn(),
    pendingSignal: null,
    exitCode: 0,
  })),
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

import {
  launchBrowser,
  navigate,
  waitForReady,
} from '../../src/browser.js';
import {
  createBrowserLifecycle,
  createLaunchSignalGuard,
} from '../../src/browser-lifecycle.js';
import {
  BrowserLaunchError,
  NavigationError,
  PersistenceError,
  ProfileError,
  attachCleanupFailures,
  attachJsonCleanupDetails,
} from '../../src/errors.js';
import { log } from '../../src/output.js';
import {
  parseCheckpointInterval,
  registerOpen,
  runOpen,
} from '../../src/commands/open.js';

function lifecycleResult(overrides = {}) {
  return {
    reason: 'last-page-closed',
    signal: null,
    exitCode: 0,
    persistence: {
      profile: { name: 'work', cookies: 1 },
      session: { name: 'login', cookies: 1 },
    },
    persistedAt: new Date().toISOString(),
    usedCheckpointFallback: false,
    persistenceIncomplete: false,
    finalCaptureError: null,
    cleanup: { persistenceError: null, cleanupErrors: [] },
    cleanupErrors: [],
    ...overrides,
  };
}

describe('open command', () => {
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
    navigate.mockResolvedValue('https://example.com/');
    waitForReady.mockResolvedValue(undefined);
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue(lifecycleResult()),
      requestExit: vi.fn().mockResolvedValue(lifecycleResult()),
    });
  });

  it('should always launch a headed direct browser with application-owned signals', async () => {
    await runOpen('https://example.com', {
      profile: 'work',
      session: 'login',
      proxy: 'http://proxy:8080',
      locale: 'en-US',
      checkpointInterval: 1000,
    });

    expect(launchBrowser).toHaveBeenCalledWith({
      headless: false,
      forceDirect: true,
      handleSignals: false,
      proxy: 'http://proxy:8080',
      profile: 'work',
      session: 'login',
      locale: 'en-US',
      restoreSessionUrl: false,
    });
    expect(createBrowserLifecycle).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ checkpointInterval: 1000 }),
    );
    expect(navigate).toHaveBeenCalledWith(expect.any(Object), 'https://example.com');
    expect(waitForReady).toHaveBeenCalledOnce();
  });

  it('should restore the saved session URL only when no explicit URL is supplied', async () => {
    await runOpen(undefined, {
      profile: 'work',
      session: 'login',
      checkpointInterval: 1000,
    });

    expect(launchBrowser).toHaveBeenCalledWith(expect.objectContaining({
      restoreSessionUrl: true,
    }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('should accept --url as an alternative and reject conflicting URLs', async () => {
    await runOpen(undefined, {
      url: 'https://example.com',
      checkpointInterval: 1000,
    });
    expect(navigate).toHaveBeenCalledWith(expect.any(Object), 'https://example.com');

    await expect(runOpen('https://a.example', {
      url: 'https://b.example',
      checkpointInterval: 1000,
    })).rejects.toMatchObject({ code: 2 });
  });

  it('should strictly validate checkpoint intervals', () => {
    expect(parseCheckpointInterval('250')).toBe(250);
    expect(parseCheckpointInterval('60000')).toBe(60000);
    expect(() => parseCheckpointInterval('abc')).toThrow('250 to 60000');
    expect(() => parseCheckpointInterval('249')).toThrow('250 to 60000');
    expect(() => parseCheckpointInterval('60001')).toThrow('250 to 60000');
    expect(() => parseCheckpointInterval('1000.5')).toThrow('250 to 60000');

    let failure;
    try {
      parseCheckpointInterval('not-a-number');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: 'InvalidArgumentError',
      exitCode: 2,
    });
  });

  it('should warn when no persistence target was provided', async () => {
    await runOpen('https://example.com', { checkpointInterval: 1000 });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('will not be saved'));
  });

  it('should not expose query strings or fragments in spinner status', async () => {
    await runOpen('https://example.com/callback?code=secret#token', {
      profile: 'work',
      checkpointInterval: 1000,
    });

    expect(spinner.text).toBe('Opening https://example.com...');
    expect(spinner.text).not.toContain('secret');
    expect(spinner.text).not.toContain('callback');
  });

  it('should preserve lifecycle signal results when setup errors race finalization', async () => {
    const signalResult = lifecycleResult({
      reason: 'signal',
      signal: 'SIGTERM',
      exitCode: 143,
    });
    const requestExit = vi.fn().mockResolvedValue(signalResult);
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue(signalResult),
      requestExit,
    });
    navigate.mockRejectedValue(new Error('page closed during navigation'));

    const result = await runOpen('https://example.com', {
      profile: 'work',
      checkpointInterval: 1000,
    });

    expect(requestExit).toHaveBeenCalledWith('command-error');
    expect(result.reason).toBe('signal');
    expect(process.exitCode).toBe(143);
  });

  it('should attach command-error cleanup failures to the primary error', async () => {
    const rawUrl = 'https://example.com/callback?token=primary-secret';
    const primaryError = new NavigationError(rawUrl, new Error(`failed for ${rawUrl}`));
    const exactHint = 'After confirming no stealth process is using this state, remove this exact lock file: /tmp/locks/abc.lock';
    const cleanupError = new ProfileError('state lock release failed', {
      hint: exactHint,
      cause: new Error('https://example.com/callback?token=cleanup-secret'),
    });
    const requestExit = vi.fn().mockResolvedValue(lifecycleResult({
      reason: 'command-error',
      cleanupErrors: [{ target: 'state-lock', error: cleanupError }],
    }));
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn(),
      requestExit,
    });
    navigate.mockRejectedValue(primaryError);

    await expect(runOpen(rawUrl, {
      profile: 'work',
      checkpointInterval: 1000,
    })).rejects.toBe(primaryError);

    expect(requestExit).toHaveBeenCalledWith('command-error');
    expect(primaryError.cleanupFailures).toEqual([
      { target: 'state-lock', error: cleanupError },
    ]);
    expect(primaryError.format()).toContain(exactHint);
    expect(primaryError.format()).not.toContain('primary-secret');
    expect(primaryError.format()).not.toContain('cleanup-secret');
  });

  it('attaches complete lifecycle evidence when command-error persistence is incomplete', async () => {
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
    const result = lifecycleResult({
      reason: 'command-error',
      exitCode: 8,
      persistenceIncomplete: true,
      finalCaptureError,
      cleanupErrors: [{ target: 'browser', error: cleanupError }],
      cleanup: {
        persistenceError: null,
        cleanupErrors: [{ target: 'browser', error: cleanupError }],
      },
    });
    const requestExit = vi.fn().mockResolvedValue(result);
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn(),
      requestExit,
    });
    navigate.mockRejectedValue(primaryError);

    await expect(runOpen('https://example.com', {
      profile: 'work',
      checkpointInterval: 1000,
    })).rejects.toBe(primaryError);

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
    const serialized = JSON.stringify(primaryError);
    expect(serialized).not.toContain('primary-secret');
    expect(serialized).not.toContain('capture-secret');
    expect(serialized).not.toContain('cleanup-secret');
  });

  it('attaches a lifecycle PersistenceError whole, including its cleanup evidence', async () => {
    const primaryError = new NavigationError('https://example.com', new Error('navigation failed'));
    const cleanupError = new Error('browser still connected');
    const lifecycleError = new PersistenceError('final persistence failed', {
      cause: new Error('capture unavailable'),
      cleanupFailures: [{ target: 'browser', error: cleanupError }],
      failures: [{ target: 'profile', name: 'work' }],
      results: { profile: null, session: null },
    });
    const requestExit = vi.fn().mockRejectedValue(lifecycleError);
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn(),
      requestExit,
    });
    navigate.mockRejectedValue(primaryError);

    await expect(runOpen('https://example.com', {
      profile: 'work',
      checkpointInterval: 1000,
    })).rejects.toBe(primaryError);

    expect(primaryError.cleanupFailures).toEqual([
      { target: 'persistence', error: lifecycleError },
    ]);
    expect(primaryError.cleanupFailures[0].error).toBe(lifecycleError);
    expect(lifecycleError.cleanupFailures).toEqual([
      { target: 'browser', error: cleanupError },
    ]);
  });

  it('preserves launch cleanup failures when a pending signal replaces the launch error', async () => {
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
      pendingSignal: 'SIGINT',
      exitCode: 130,
    });
    launchBrowser.mockRejectedValueOnce(launchError);

    let failure;
    try {
      await runOpen(undefined, { checkpointInterval: 1000 });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'StealthError',
      message: 'Interrupted by SIGINT',
      code: 130,
      cause: launchError,
      cleanupFailures: [{ target: 'state-lock', error: cleanupError }],
    });
    expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(failure, 'cleanupFailures')?.enumerable).toBe(false);
    expect(failure.format()).toContain(exactHint);
    const serialized = JSON.stringify(failure);
    expect(serialized).toContain(exactHint);
    expect(serialized).not.toContain('launch-secret');
    expect(serialized).not.toContain('cleanup-secret');
    expect(serialized).not.toContain('callback');
  });

  it('should warn when a hard disconnect uses a durable checkpoint', async () => {
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue(lifecycleResult({
        reason: 'disconnected',
        usedCheckpointFallback: true,
      })),
      requestExit: vi.fn(),
    });

    await runOpen(undefined, {
      profile: 'work',
      checkpointInterval: 1000,
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('latest durable checkpoint'));
  });

  it('reports an exact profile artifact when final persistence uses a checkpoint fallback', async () => {
    const artifactPath = '/tmp/stealth/profiles/.work.json.999.claim';
    const rawCleanupError = attachJsonCleanupDetails(
      new Error('artifact-content-secret'),
      {
        status: 'pending',
        artifacts: [{ operation: 'inspect', path: artifactPath }],
      },
    );
    const finalCaptureError = new PersistenceError('Profile checkpoint failed', {
      cause: rawCleanupError,
    });
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue(lifecycleResult({
        exitCode: 8,
        usedCheckpointFallback: true,
        persistenceIncomplete: true,
        finalCaptureError,
      })),
      requestExit: vi.fn(),
    });

    await runOpen(undefined, {
      profile: 'work',
      checkpointInterval: 1000,
    });

    const output = log.warn.mock.calls.flat().join('\n');
    expect(process.exitCode).toBe(8);
    expect(output).toContain('latest durable checkpoint');
    expect(output).toContain(JSON.stringify(artifactPath));
    expect(output).toContain('remove only that exact path');
    expect(output).not.toContain('artifact-content-secret');
  });

  it('should report cleanup failures with a non-zero exit status', async () => {
    createBrowserLifecycle.mockReturnValue({
      phase: 'running',
      start: vi.fn(),
      wait: vi.fn().mockResolvedValue(lifecycleResult({
        exitCode: 1,
        cleanupErrors: [{ target: 'browser', error: new Error('still connected') }],
      })),
      requestExit: vi.fn(),
    });

    await runOpen(undefined, { checkpointInterval: 1000 });

    expect(process.exitCode).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cleanup was incomplete'));
  });

  it('should make Commander exit with code 2 for an invalid checkpoint interval', async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: vi.fn() });
    registerOpen(program);

    await expect(program.parseAsync([
      'open',
      '--checkpoint-interval',
      '249',
    ], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.invalidArgument',
      exitCode: 2,
    });
  });

  it('should register profile, session, URL and checkpoint options', () => {
    const program = new Command();
    registerOpen(program);
    const command = program.commands.find((candidate) => candidate.name() === 'open');
    const optionNames = command.options.map((option) => option.attributeName());

    expect(optionNames).toEqual(expect.arrayContaining([
      'url',
      'profile',
      'session',
      'proxy',
      'cookies',
      'checkpointInterval',
    ]));
  });
});

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

vi.mock('../../src/browser-lifecycle.js', () => ({
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
import { createBrowserLifecycle } from '../../src/browser-lifecycle.js';
import { NavigationError, ProfileError } from '../../src/errors.js';
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
    cleanup: { cleanupErrors: [] },
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

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('latest checkpoint'));
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

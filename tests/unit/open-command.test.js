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
import { log } from '../../src/output.js';
import { registerOpen, runOpen } from '../../src/commands/open.js';

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
    });
    expect(createBrowserLifecycle).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ checkpointInterval: 1000 }),
    );
    expect(navigate).toHaveBeenCalledWith(expect.any(Object), 'https://example.com');
    expect(waitForReady).toHaveBeenCalledOnce();
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

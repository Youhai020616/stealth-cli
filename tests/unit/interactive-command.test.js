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

vi.mock('../../src/output.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
  },
}));

import { launchBrowser } from '../../src/browser.js';
import { createBrowserLifecycle } from '../../src/browser-lifecycle.js';
import { registerInteractive } from '../../src/commands/interactive.js';

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
    }));
  });
});

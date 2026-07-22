import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/browser.js', () => ({
  closeBrowser: vi.fn(),
}));

import { closeBrowser } from '../../src/browser.js';
import { closeBrowserForCli } from '../../src/utils/close-browser-cli.js';

const ORIGINAL_EXIT_CODE = process.exitCode;
const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  closeBrowser.mockResolvedValue({
    persistence: null,
    persistenceError: null,
    cleanupErrors: [],
  });
});

afterAll(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
});

describe('closeBrowserForCli', () => {
  it('reports persistence failures and sets exit code 8', async () => {
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: Object.assign(new Error('disk full'), { code: 8 }),
      cleanupErrors: [],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    expect(process.exitCode).toBe(8);
    expect(logger.warn).toHaveBeenCalledWith('Browser state was not fully saved: disk full');
  });

  it('sets a general failure and reports incomplete cleanup', async () => {
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: null,
      cleanupErrors: [{ target: 'browser', error: new Error('busy') }],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    expect(process.exitCode).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith('Browser cleanup was incomplete (browser)');
  });

  it('keeps the persistence exit code when persistence and cleanup both fail', async () => {
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: Object.assign(new Error('disk full'), { code: 8 }),
      cleanupErrors: [{ target: 'state-lock', error: new Error('busy') }],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    expect(process.exitCode).toBe(8);
  });

  it('does not overwrite an earlier command failure', async () => {
    process.exitCode = 4;
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: Object.assign(new Error('disk full'), { code: 8 }),
      cleanupErrors: [],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    expect(process.exitCode).toBe(4);
  });
});

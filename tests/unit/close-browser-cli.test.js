import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/browser.js', () => ({
  closeBrowser: vi.fn(),
}));

import { closeBrowser } from '../../src/browser.js';
import { ProfileError } from '../../src/errors.js';
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

  it('falls back to exit code 8 when a persistence error reports success', async () => {
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: Object.assign(new Error('disk full'), { code: 0 }),
      cleanupErrors: [],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    expect(process.exitCode).toBe(8);
  });

  it('redacts URLs and escapes terminal controls from raw persistence errors', async () => {
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: Object.assign(
        new Error('failed at https://example.com/callback?token=secret\nINJECTED\r\u001b[31mRED'),
        { code: 'EIO' },
      ),
      cleanupErrors: [],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    const output = logger.warn.mock.calls.flat().join('\n');
    expect(process.exitCode).toBe(8);
    expect(output).toContain('failed at https://example.com');
    expect(output).toContain('\\u000aINJECTED\\u000d\\u001b[31mRED');
    expect(output).not.toContain('token=secret');
    expect(output).not.toContain('\nINJECTED');
    expect(output).not.toContain('\r');
    expect(output).not.toContain('\u001b');
  });

  it('sets a general failure and reports incomplete cleanup', async () => {
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: null,
      cleanupErrors: [{ target: 'browser', error: new Error('busy') }],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    expect(process.exitCode).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      'Browser cleanup was incomplete (browser)',
    ));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      'Ensure the browser process has exited',
    ));
  });

  it('keeps the persistence exit code and reports an exact state-lock hint', async () => {
    const exactHint = 'After confirming no stealth process is using this state, remove this exact lock file: /tmp/locks/abc.lock';
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: Object.assign(new Error('disk full'), { code: 8 }),
      cleanupErrors: [{
        target: 'state-lock',
        error: new ProfileError('lock release failed', {
          hint: exactHint,
          cause: new Error('raw cleanup cause'),
        }),
      }],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    expect(process.exitCode).toBe(8);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(exactHint));
    expect(logger.warn.mock.calls.flat().join('\n')).not.toContain('raw cleanup cause');
  });

  it('escapes terminal controls in cleanup hints before logging', async () => {
    const exactHint = 'Remove exact lock: /tmp/locks/abc.lock\nINJECTED\r\u001b[31mRED';
    closeBrowser.mockResolvedValue({
      persistence: null,
      persistenceError: null,
      cleanupErrors: [{
        target: 'state-lock',
        error: new ProfileError('lock release failed', { hint: exactHint }),
      }],
    });

    await closeBrowserForCli({ isDaemon: false }, { log: logger });

    const output = logger.warn.mock.calls.flat().join('\n');
    expect(output).toContain('/tmp/locks/abc.lock\\u000aINJECTED');
    expect(output).toContain('\\u000d\\u001b[31mRED');
    expect(output).not.toContain('\nINJECTED');
    expect(output).not.toContain('\r');
    expect(output).not.toContain('\u001b');
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

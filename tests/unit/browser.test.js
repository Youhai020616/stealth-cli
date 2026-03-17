/**
 * Tests for browser.js core module
 *
 * Strategy: Test the logic (mode dispatch, option merging, error handling)
 * without launching real browsers. We use vitest mocks to intercept
 * the heavy dependencies (createBrowser, isDaemonRunning, etc.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy modules BEFORE importing browser.js
vi.mock('../../src/utils/browser-factory.js', () => ({
  getHostOS: () => 'macos',
  createBrowser: vi.fn(),
  TEXT_EXTRACT_SCRIPT: '(() => "mocked text")()',
}));

vi.mock('../../src/daemon.js', () => ({
  isDaemonRunning: vi.fn(() => false),
  SOCKET_PATH: '/tmp/test.sock',
  PID_PATH: '/tmp/test.pid',
  STEALTH_DIR: '/tmp/.stealth',
}));

vi.mock('../../src/client.js', () => ({
  daemonNavigate: vi.fn(),
  daemonText: vi.fn(),
  daemonScreenshot: vi.fn(),
  daemonRequest: vi.fn(),
}));

vi.mock('../../src/profiles.js', () => ({
  loadProfile: vi.fn(),
  touchProfile: vi.fn(),
  saveCookiesToProfile: vi.fn(),
  loadCookiesFromProfile: vi.fn(),
}));

vi.mock('../../src/session.js', () => ({
  restoreSession: vi.fn(),
  captureSession: vi.fn(),
}));

vi.mock('../../src/proxy-pool.js', () => ({
  getNextProxy: vi.fn(),
  getRandomProxy: vi.fn(),
  reportProxy: vi.fn(),
}));

// Now import the module under test
import { launchBrowser, closeBrowser, navigate, getTextContent, getSnapshot, waitForReady } from '../../src/browser.js';
import { isDaemonRunning } from '../../src/daemon.js';
import { createBrowser } from '../../src/utils/browser-factory.js';
import { loadProfile, touchProfile } from '../../src/profiles.js';
import { restoreSession } from '../../src/session.js';
import { getNextProxy } from '../../src/proxy-pool.js';
import { daemonNavigate, daemonRequest } from '../../src/client.js';

describe('launchBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return daemon handle when daemon is running and no profile/proxy/session', async () => {
    isDaemonRunning.mockReturnValue(true);

    const handle = await launchBrowser();

    expect(handle.isDaemon).toBe(true);
    expect(handle.browser).toBeNull();
    expect(handle.page).toBeNull();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('should launch direct browser when daemon is NOT running', async () => {
    isDaemonRunning.mockReturnValue(false);

    // Mock createBrowser to return a fake browser
    const mockPage = { goto: vi.fn() };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn(),
    };
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    const handle = await launchBrowser();

    expect(handle.isDaemon).toBe(false);
    expect(handle.browser).toBe(mockBrowser);
    expect(handle.page).toBe(mockPage);
    expect(createBrowser).toHaveBeenCalledTimes(1);
  });

  it('should skip daemon when profile is specified (even if daemon running)', async () => {
    isDaemonRunning.mockReturnValue(true);
    loadProfile.mockReturnValue({
      fingerprint: { locale: 'ja-JP', timezone: 'Asia/Tokyo', viewport: { width: 1920, height: 1080 }, os: 'windows' },
      proxy: null,
    });

    const mockPage = { goto: vi.fn() };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn(),
    };
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    const handle = await launchBrowser({ profile: 'jp-desktop' });

    expect(handle.isDaemon).toBe(false);
    expect(loadProfile).toHaveBeenCalledWith('jp-desktop');
    expect(touchProfile).toHaveBeenCalledWith('jp-desktop');
    // Should use profile's OS
    expect(createBrowser).toHaveBeenCalledWith(expect.objectContaining({ os: 'windows' }));
  });

  it('should skip daemon when proxy is specified', async () => {
    isDaemonRunning.mockReturnValue(true);

    const mockPage = { goto: vi.fn() };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn(),
    };
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    const handle = await launchBrowser({ proxy: 'http://proxy:8080' });

    expect(handle.isDaemon).toBe(false);
    expect(createBrowser).toHaveBeenCalled();
  });

  it('should skip daemon when session is specified', async () => {
    isDaemonRunning.mockReturnValue(true);
    restoreSession.mockResolvedValue({ lastUrl: null, history: [] });

    const mockPage = { goto: vi.fn() };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn(),
    };
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    const handle = await launchBrowser({ session: 'my-session' });

    expect(handle.isDaemon).toBe(false);
    expect(restoreSession).toHaveBeenCalledWith('my-session', mockContext);
  });

  it('should use proxy pool rotation when proxyRotate is true', async () => {
    isDaemonRunning.mockReturnValue(false);
    getNextProxy.mockReturnValue('http://rotated-proxy:9090');

    const mockPage = { goto: vi.fn() };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn(),
    };
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    const handle = await launchBrowser({ proxyRotate: true });

    expect(getNextProxy).toHaveBeenCalled();
    expect(handle._meta.proxyUrl).toBe('http://rotated-proxy:9090');
  });

  it('should warn but not crash when profile load fails', async () => {
    isDaemonRunning.mockReturnValue(false);
    loadProfile.mockImplementation(() => { throw new Error('Profile not found'); });

    const mockPage = { goto: vi.fn() };
    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn(),
    };
    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    // Should not throw
    const handle = await launchBrowser({ profile: 'nonexistent' });
    expect(handle.isDaemon).toBe(false);
    expect(handle.page).toBe(mockPage);
  });
});

describe('closeBrowser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should be a no-op for daemon handles', async () => {
    const handle = { isDaemon: true, browser: null, context: null, page: null, _meta: {} };
    // Should not throw
    await closeBrowser(handle);
  });

  it('should close context and browser for direct handles', async () => {
    const mockContext = { close: vi.fn().mockResolvedValue(undefined), cookies: vi.fn() };
    const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
    const handle = {
      isDaemon: false,
      browser: mockBrowser,
      context: mockContext,
      page: { url: () => 'about:blank' },
      _meta: {},
    };

    await closeBrowser(handle);

    expect(mockContext.close).toHaveBeenCalled();
    expect(mockBrowser.close).toHaveBeenCalled();
  });
});

describe('navigate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should use daemon client when handle is daemon', async () => {
    daemonNavigate.mockResolvedValue({ ok: true, url: 'https://example.com/' });

    const handle = { isDaemon: true, page: null };
    const result = await navigate(handle, 'https://example.com');

    expect(daemonNavigate).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(result).toBe('https://example.com/');
  });

  it('should use page.goto when handle is direct mode', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://example.com/'),
    };
    const handle = { isDaemon: false, page: mockPage };

    const result = await navigate(handle, 'https://example.com');

    expect(mockPage.goto).toHaveBeenCalled();
  });
});

describe('getTextContent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should use daemon request when handle is daemon', async () => {
    daemonRequest.mockResolvedValue({ text: 'Hello from daemon' });

    const handle = { isDaemon: true, page: null };
    const text = await getTextContent(handle);

    expect(daemonRequest).toHaveBeenCalledWith('/text');
    expect(text).toBe('Hello from daemon');
  });

  it('should use page.evaluate when handle is direct', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue('Hello from page'),
    };
    const handle = { isDaemon: false, page: mockPage };

    const text = await getTextContent(handle);

    expect(mockPage.evaluate).toHaveBeenCalled();
    expect(text).toBe('Hello from page');
  });
});

describe('getSnapshot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should use daemon request when handle is daemon', async () => {
    daemonRequest.mockResolvedValue({ snapshot: '- heading "Hello"' });

    const handle = { isDaemon: true, page: null };
    const snap = await getSnapshot(handle);

    expect(daemonRequest).toHaveBeenCalledWith('/snapshot');
    expect(snap).toBe('- heading "Hello"');
  });
});

describe('waitForReady', () => {
  it('should be a no-op when page is null (daemon mode)', async () => {
    // Should not throw
    await waitForReady(null);
  });

  it('should wait for networkidle by default', async () => {
    const mockPage = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    };
    await waitForReady(mockPage);
    expect(mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle', expect.any(Object));
  });

  it('should wait for domcontentloaded when waitForNetwork is false', async () => {
    const mockPage = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    };
    await waitForReady(mockPage, { waitForNetwork: false });
    expect(mockPage.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', expect.any(Object));
  });
});

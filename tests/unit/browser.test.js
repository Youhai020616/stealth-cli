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
  extractPageText: () => 'mocked text',
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
  saveProfileCookies: vi.fn(),
  saveCookiesToProfile: vi.fn(),
  loadCookiesFromProfile: vi.fn(),
}));

vi.mock('../../src/session.js', () => ({
  getSession: vi.fn(() => ({ profile: null })),
  restoreSession: vi.fn(),
  captureSession: vi.fn(),
  saveSessionSnapshot: vi.fn(),
}));

vi.mock('../../src/proxy-pool.js', () => ({
  getNextProxy: vi.fn(),
  getRandomProxy: vi.fn(),
  reportProxy: vi.fn(),
}));

// Now import the module under test
import {
  launchBrowser,
  closeBrowser,
  captureBrowserState,
  writeBrowserStateSnapshot,
  persistBrowserState,
  navigate,
  getTextContent,
  getSnapshot,
  waitForReady,
} from '../../src/browser.js';
import { isDaemonRunning } from '../../src/daemon.js';
import { createBrowser } from '../../src/utils/browser-factory.js';
import { loadProfile, touchProfile, saveProfileCookies } from '../../src/profiles.js';
import { getSession, restoreSession, saveSessionSnapshot } from '../../src/session.js';
import { getNextProxy } from '../../src/proxy-pool.js';
import { daemonNavigate, daemonRequest } from '../../src/client.js';
import { log } from '../../src/output.js';

// Helper: create mock browser/context/page and wire up createBrowser
function setupMockBrowser() {
  const mockPage = {
    goto: vi.fn(),
    url: vi.fn(() => 'about:blank'),
    isClosed: vi.fn(() => false),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    cookies: vi.fn().mockResolvedValue([]),
    pages: vi.fn(() => [mockPage]),
    close: vi.fn(),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    isConnected: vi.fn(() => true),
    close: vi.fn(),
  };
  createBrowser.mockResolvedValue(mockBrowser);
  return { mockBrowser, mockContext, mockPage };
}

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

  it('should skip daemon for an explicitly headed browser', async () => {
    isDaemonRunning.mockReturnValue(true);
    setupMockBrowser();

    const handle = await launchBrowser({ headless: false });

    expect(handle.isDaemon).toBe(false);
    expect(createBrowser).toHaveBeenCalled();
  });

  it('should skip daemon when forceDirect is true', async () => {
    isDaemonRunning.mockReturnValue(true);
    setupMockBrowser();

    const handle = await launchBrowser({ forceDirect: true });

    expect(handle.isDaemon).toBe(false);
  });

  it('should forward lifecycle-managed signal handling to the browser factory', async () => {
    isDaemonRunning.mockReturnValue(false);
    setupMockBrowser();

    await launchBrowser({ handleSignals: false });

    expect(createBrowser).toHaveBeenCalledWith(expect.objectContaining({
      handleSignals: false,
    }));
  });

  it('should launch direct browser when daemon is NOT running', async () => {
    isDaemonRunning.mockReturnValue(false);
    const { mockBrowser, mockPage } = setupMockBrowser();

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
    setupMockBrowser();

    const handle = await launchBrowser({ profile: 'jp-desktop' });

    expect(handle.isDaemon).toBe(false);
    expect(loadProfile).toHaveBeenCalledWith('jp-desktop');
    expect(touchProfile).toHaveBeenCalledWith('jp-desktop');
    expect(createBrowser).toHaveBeenCalledWith(expect.objectContaining({ os: 'windows' }));
  });

  it('should skip daemon when proxy is specified', async () => {
    isDaemonRunning.mockReturnValue(true);
    setupMockBrowser();

    const handle = await launchBrowser({ proxy: 'http://proxy:8080' });

    expect(handle.isDaemon).toBe(false);
    expect(createBrowser).toHaveBeenCalled();
  });

  it('should skip daemon when session is specified', async () => {
    isDaemonRunning.mockReturnValue(true);
    restoreSession.mockResolvedValue({ lastUrl: null, history: [] });
    const { mockContext } = setupMockBrowser();

    const handle = await launchBrowser({ session: 'my-session' });

    expect(handle.isDaemon).toBe(false);
    expect(restoreSession).toHaveBeenCalledWith('my-session', mockContext, {
      expectedProfile: undefined,
      restoreCookies: true,
    });
  });

  it('should redact query parameters when session URL restoration fails', async () => {
    isDaemonRunning.mockReturnValue(false);
    restoreSession.mockResolvedValue({
      lastUrl: 'https://example.com/callback?code=secret#token',
      history: [],
    });
    const { mockPage } = setupMockBrowser();
    mockPage.goto.mockRejectedValue(new Error(
      'page.goto failed for https://example.com/callback?code=secret#token',
    ));
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await launchBrowser({ session: 'login' });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('https://example.com'));
    expect(warning.mock.calls[0][0]).not.toContain('secret');
    expect(warning.mock.calls[0][0]).not.toContain('callback');
    warning.mockRestore();
  });

  it('should reject a session linked to a different profile before launch', async () => {
    isDaemonRunning.mockReturnValue(false);
    loadProfile.mockReturnValue({
      fingerprint: { locale: 'en-US', timezone: 'UTC', viewport: { width: 1280, height: 720 }, os: 'macos' },
      proxy: null,
    });
    getSession.mockReturnValue({ profile: 'profile-a' });

    await expect(launchBrowser({
      profile: 'profile-b',
      session: 'login',
    })).rejects.toThrow('belongs to profile');
    expect(touchProfile).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('should use profile cookies as canonical when profile and session are combined', async () => {
    isDaemonRunning.mockReturnValue(false);
    loadProfile.mockReturnValue({
      fingerprint: { locale: 'en-US', timezone: 'UTC', viewport: { width: 1280, height: 720 }, os: 'macos' },
      proxy: null,
    });
    getSession.mockReturnValue({ profile: 'work' });
    restoreSession.mockResolvedValue({ lastUrl: null, history: [] });
    const { mockContext } = setupMockBrowser();

    await launchBrowser({ profile: 'work', session: 'login' });

    expect(restoreSession).toHaveBeenCalledWith('login', mockContext, {
      expectedProfile: 'work',
      restoreCookies: false,
    });
  });

  it('should use proxy pool rotation when proxyRotate is true', async () => {
    isDaemonRunning.mockReturnValue(false);
    getNextProxy.mockReturnValue('http://rotated-proxy:9090');
    setupMockBrowser();

    const handle = await launchBrowser({ proxyRotate: true });

    expect(getNextProxy).toHaveBeenCalled();
    expect(handle._meta.proxyUrl).toBe('http://rotated-proxy:9090');
  });

  it('should fail before browser launch when an explicit profile cannot load', async () => {
    isDaemonRunning.mockReturnValue(false);
    loadProfile.mockImplementation(() => { throw new Error('Profile not found'); });

    await expect(launchBrowser({ profile: 'nonexistent' })).rejects.toThrow('Profile not found');
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('should clean up a partially initialized browser', async () => {
    isDaemonRunning.mockReturnValue(false);
    const mockBrowser = {
      newContext: vi.fn().mockRejectedValue(new Error('context failed')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    await expect(launchBrowser()).rejects.toThrow('Browser initialization failed');
    expect(mockBrowser.close).toHaveBeenCalledOnce();
  });
});

describe('browser state persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveProfileCookies.mockReset().mockReturnValue(1);
    saveSessionSnapshot.mockReset().mockReturnValue({
      cookies: [{ name: 'sid', value: '123' }],
      lastUrl: 'https://example.com',
    });
  });

  it('should capture cookies once and share one snapshot across profile and session', async () => {
    const cookies = [{ name: 'sid', value: '123' }];
    const page = {
      url: vi.fn(() => 'https://example.com'),
      isClosed: vi.fn(() => false),
    };
    const context = {
      cookies: vi.fn().mockResolvedValue(cookies),
      pages: vi.fn(() => [page]),
    };
    const handle = {
      isDaemon: false,
      browser: { isConnected: vi.fn(() => true) },
      context,
      page,
      _meta: { profileName: 'work', sessionName: 'login' },
    };

    const result = await persistBrowserState(handle);

    expect(context.cookies).toHaveBeenCalledOnce();
    expect(saveProfileCookies).toHaveBeenCalledWith('work', cookies);
    expect(saveSessionSnapshot).toHaveBeenCalledWith(
      'login',
      expect.objectContaining({ cookies, lastUrl: 'https://example.com' }),
      { profile: 'work' },
    );
    expect(result.results.profile.cookies).toBe(1);
  });

  it('should treat an empty cookie snapshot as a successful capture', async () => {
    const handle = {
      isDaemon: false,
      browser: { isConnected: vi.fn(() => true) },
      context: { cookies: vi.fn().mockResolvedValue([]), pages: vi.fn(() => []) },
      page: null,
      _meta: { profileName: 'work' },
    };
    saveProfileCookies.mockReturnValue(0);

    const snapshot = await captureBrowserState(handle);
    const result = await writeBrowserStateSnapshot(handle, snapshot);

    expect(snapshot.cookies).toEqual([]);
    expect(result.results.profile.cookies).toBe(0);
  });

  it('should attempt session persistence when profile persistence fails', async () => {
    const snapshot = {
      cookies: [{ name: 'sid', value: '123' }],
      lastUrl: 'https://example.com',
      capturedAt: new Date().toISOString(),
    };
    const handle = {
      isDaemon: false,
      _meta: { profileName: 'work', sessionName: 'login' },
    };
    saveProfileCookies.mockImplementation(() => { throw new Error('disk full'); });

    let persistenceError;
    try {
      await writeBrowserStateSnapshot(handle, snapshot);
    } catch (error) {
      persistenceError = error;
    }

    expect(persistenceError).toMatchObject({
      name: 'PersistenceError',
      results: expect.objectContaining({
        session: expect.objectContaining({ name: 'login' }),
      }),
      snapshotMetadata: { cookieCount: 1 },
    });
    expect(JSON.stringify(persistenceError)).not.toContain('123');
    expect(saveSessionSnapshot).toHaveBeenCalledOnce();
  });
});

describe('closeBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveProfileCookies.mockReset().mockReturnValue(1);
    saveSessionSnapshot.mockReset().mockReturnValue({ cookies: [], lastUrl: null });
  });

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

  it('should make concurrent close calls idempotent', async () => {
    const mockContext = {
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue([]),
      pages: vi.fn(() => []),
    };
    const mockBrowser = {
      isConnected: vi.fn(() => true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const handle = {
      isDaemon: false,
      browser: mockBrowser,
      context: mockContext,
      page: null,
      _meta: { profileName: 'work' },
    };

    await Promise.all([closeBrowser(handle), closeBrowser(handle)]);

    expect(mockContext.cookies).toHaveBeenCalledOnce();
    expect(mockContext.close).toHaveBeenCalledOnce();
    expect(mockBrowser.close).toHaveBeenCalledOnce();
  });

  it('should clean up even when persistence fails', async () => {
    const mockContext = {
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockRejectedValue(new Error('context closed')),
      pages: vi.fn(() => []),
    };
    const mockBrowser = {
      isConnected: vi.fn(() => true),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const handle = {
      isDaemon: false,
      browser: mockBrowser,
      context: mockContext,
      page: null,
      _meta: { profileName: 'work' },
    };

    const result = await closeBrowser(handle);

    expect(result.persistenceError?.name).toBe('PersistenceError');
    expect(mockContext.close).toHaveBeenCalledOnce();
    expect(mockBrowser.close).toHaveBeenCalledOnce();
  });

  it('should skip persistence when requested by a lifecycle coordinator', async () => {
    const mockContext = {
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn(),
    };
    const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
    const handle = {
      isDaemon: false,
      browser: mockBrowser,
      context: mockContext,
      page: null,
      _meta: { profileName: 'work' },
    };

    await closeBrowser(handle, { persist: false });

    expect(mockContext.cookies).not.toHaveBeenCalled();
    expect(mockContext.close).toHaveBeenCalledOnce();
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

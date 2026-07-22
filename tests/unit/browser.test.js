/**
 * Tests for browser.js core module
 *
 * Strategy: Test the logic (mode dispatch, option merging, error handling)
 * without launching real browsers. We use vitest mocks to intercept
 * the heavy dependencies (createBrowser, isDaemonRunning, etc.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const brandedStateLeases = vi.hoisted(() => new WeakSet());

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

vi.mock('../../src/profiles.js', async (importOriginal) => ({
  ...await importOriginal(),
  loadProfile: vi.fn(),
  touchProfile: vi.fn(),
  saveProfileCookies: vi.fn(),
  saveCookiesToProfile: vi.fn(),
  loadCookiesFromProfile: vi.fn(),
}));

vi.mock('../../src/session.js', async (importOriginal) => ({
  ...await importOriginal(),
  getSession: vi.fn((name = 'login') => ({
    name,
    profile: null,
    cookies: [],
    history: [],
    lastUrl: null,
  })),
  restoreSession: vi.fn(),
  captureSession: vi.fn(),
  saveSessionSnapshot: vi.fn(),
}));

vi.mock('../../src/proxy-pool.js', () => ({
  getNextProxy: vi.fn(),
  getRandomProxy: vi.fn(),
  reportProxy: vi.fn(),
}));

vi.mock('../../src/utils/state-lock.js', () => ({
  acquireStateLocks: vi.fn(),
  ownsStateLock: vi.fn((lease, kind, name) => (
    brandedStateLeases.has(lease) && lease.owns(kind, name)
  )),
  withStateLock: vi.fn((_kind, _name, lease, operation) => operation(lease)),
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
import { ProfileError } from '../../src/errors.js';
import { isDaemonRunning } from '../../src/daemon.js';
import { createBrowser } from '../../src/utils/browser-factory.js';
import { loadProfile, touchProfile, saveProfileCookies } from '../../src/profiles.js';
import { getSession, restoreSession, saveSessionSnapshot } from '../../src/session.js';
import { getNextProxy } from '../../src/proxy-pool.js';
import { daemonNavigate, daemonRequest } from '../../src/client.js';
import { log } from '../../src/output.js';
import { acquireStateLocks } from '../../src/utils/state-lock.js';

function createStateLease({ profile, session } = {}) {
  const owned = new Set();
  if (profile) owned.add(`profile:${profile}`);
  if (session) owned.add(`session:${session}`);

  const lease = vi.fn(() => owned.clear());
  lease.owns = vi.fn((kind, name) => owned.has(`${kind}:${name}`));
  brandedStateLeases.add(lease);
  return lease;
}

const DEFAULT_PROFILE = {
  fingerprint: {
    locale: 'en-US',
    timezone: 'UTC',
    viewport: { width: 1280, height: 720 },
    os: 'macos',
  },
  proxy: null,
  cookies: [],
};

function sessionFixture(name = 'login', overrides = {}) {
  return {
    name,
    profile: null,
    cookies: [],
    history: [],
    lastUrl: null,
    ...overrides,
  };
}

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

async function launchStatefulBrowser(opts, mocks = setupMockBrowser(), stateLease) {
  const profile = opts.profile?.toLowerCase();
  const session = opts.session?.toLowerCase();
  const lease = stateLease || createStateLease({ profile, session });
  acquireStateLocks.mockReturnValueOnce(lease);
  if (profile) loadProfile.mockReturnValue(DEFAULT_PROFILE);
  if (session) {
    getSession.mockReturnValue(sessionFixture(session, { profile: profile || null }));
    restoreSession.mockResolvedValue({ lastUrl: null, history: [], profile: profile || null });
  }

  const handle = await launchBrowser({ ...opts, restoreSessionUrl: false });
  return { handle, stateLease: lease, ...mocks };
}

describe('launchBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDaemonRunning.mockReturnValue(false);
    getSession.mockReset().mockImplementation((name) => sessionFixture(name));
    restoreSession.mockReset().mockResolvedValue({
      lastUrl: null,
      history: [],
      profile: null,
    });
    acquireStateLocks.mockReset().mockImplementation((opts) => createStateLease(opts));
  });

  it('should return a daemon handle without retaining state locks', async () => {
    const stateLease = createStateLease();
    acquireStateLocks.mockReturnValue(stateLease);
    isDaemonRunning.mockReturnValue(true);

    const handle = await launchBrowser();

    expect(handle.isDaemon).toBe(true);
    expect(handle.browser).toBeNull();
    expect(handle.page).toBeNull();
    expect(createBrowser).not.toHaveBeenCalled();
    expect(stateLease).toHaveBeenCalledOnce();
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
      cookies: [],
    });
    const stateLease = createStateLease({ profile: 'jp-desktop' });
    acquireStateLocks.mockReturnValue(stateLease);
    setupMockBrowser();

    const handle = await launchBrowser({ profile: 'jp-desktop' });

    expect(handle.isDaemon).toBe(false);
    expect(loadProfile).toHaveBeenCalledWith('jp-desktop');
    expect(touchProfile).toHaveBeenCalledWith('jp-desktop', {
      lease: stateLease,
    });
    expect(stateLease.owns('profile', 'jp-desktop')).toBe(true);
    expect(handle._meta).not.toHaveProperty('stateLease');
    expect(createBrowser).toHaveBeenCalledWith(expect.objectContaining({ os: 'windows' }));
  });

  it('should skip daemon when proxy is specified', async () => {
    isDaemonRunning.mockReturnValue(true);
    setupMockBrowser();

    const handle = await launchBrowser({ proxy: 'http://proxy:8080' });

    expect(handle.isDaemon).toBe(false);
    expect(createBrowser).toHaveBeenCalled();
  });

  it('should normalize an uppercase persisted proxy scheme consistently', async () => {
    loadProfile.mockReturnValue({
      ...DEFAULT_PROFILE,
      proxy: 'HTTP://proxy.example:8080',
    });
    setupMockBrowser();

    await launchBrowser({ profile: 'work' });

    expect(createBrowser).toHaveBeenCalledWith(expect.objectContaining({
      proxy: {
        server: 'http://proxy.example:8080',
        username: undefined,
        password: undefined,
      },
    }));
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

  it('should infer and restore the linked profile for a session-only launch', async () => {
    getSession.mockReturnValue(sessionFixture('login', { profile: 'work' }));
    loadProfile.mockReturnValue({
      fingerprint: { locale: 'en-US', timezone: 'UTC', viewport: { width: 1280, height: 720 }, os: 'macos' },
      proxy: null,
      cookies: [],
    });
    const { mockContext } = setupMockBrowser();

    const handle = await launchBrowser({ session: 'login', restoreSessionUrl: false });

    expect(acquireStateLocks).toHaveBeenCalledWith({ profile: 'work', session: 'login' });
    expect(loadProfile).toHaveBeenCalledWith('work');
    expect(restoreSession).toHaveBeenCalledWith('login', mockContext, {
      expectedProfile: 'work',
      restoreCookies: false,
    });
    expect(handle._meta.profileName).toBe('work');
  });

  it.each([
    ['null', null],
    ['another profile', 'other'],
  ])('rejects an inferred session profile changing from work to %s after locking', async (_label, linkedProfile) => {
    getSession
      .mockReturnValueOnce(sessionFixture('login', { profile: 'work' }))
      .mockReturnValueOnce(sessionFixture('login', { profile: linkedProfile }));

    await expect(launchBrowser({
      session: 'login',
      restoreSessionUrl: false,
    })).rejects.toThrow('profile link changed while the browser was starting');

    expect(acquireStateLocks).toHaveBeenCalledWith({ profile: 'work', session: 'login' });
    expect(loadProfile).not.toHaveBeenCalled();
    expect(touchProfile).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('allows an explicit profile to bind a session that is null after locking', async () => {
    getSession
      .mockReturnValueOnce(sessionFixture('login', { profile: 'work' }))
      .mockReturnValueOnce(sessionFixture('login'));
    loadProfile.mockReturnValue(DEFAULT_PROFILE);
    setupMockBrowser();

    await expect(launchBrowser({
      profile: 'work',
      session: 'login',
      restoreSessionUrl: false,
    })).resolves.toMatchObject({
      _meta: { profileName: 'work', sessionName: 'login' },
    });

    expect(loadProfile).toHaveBeenCalledWith('work');
    expect(createBrowser).toHaveBeenCalledOnce();
  });

  it('should preserve a saved session URL when an explicit target leaves the page blank', async () => {
    restoreSession.mockResolvedValue({
      lastUrl: 'https://saved.example/account',
      history: [],
      profile: null,
    });
    const { mockPage } = setupMockBrowser();

    const handle = await launchBrowser({ session: 'login', restoreSessionUrl: false });
    const snapshot = await captureBrowserState(handle);

    expect(mockPage.goto).not.toHaveBeenCalled();
    expect(handle._meta.lastKnownUrl).toBe('https://saved.example/account');
    expect(snapshot.lastUrl).toBe('https://saved.example/account');
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
      cookies: [],
    });
    getSession.mockReturnValue(sessionFixture('login', { profile: 'profile-a' }));

    await expect(launchBrowser({
      profile: 'profile-b',
      session: 'login',
    })).rejects.toThrow('belongs to profile');
    expect(touchProfile).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('should canonicalize profile and session case before comparing linked state', async () => {
    loadProfile.mockReturnValue({
      fingerprint: { locale: 'en-US', timezone: 'UTC', viewport: { width: 1280, height: 720 }, os: 'macos' },
      proxy: null,
      cookies: [],
    });
    getSession.mockReturnValue(sessionFixture('login', { profile: 'work' }));
    restoreSession.mockResolvedValue({ lastUrl: null, history: [], profile: 'work' });
    const { mockContext } = setupMockBrowser();

    const handle = await launchBrowser({ profile: 'Work', session: 'Login' });

    expect(acquireStateLocks).toHaveBeenCalledWith({ profile: 'work', session: 'login' });
    expect(loadProfile).toHaveBeenCalledWith('work');
    expect(restoreSession).toHaveBeenCalledWith('login', mockContext, {
      expectedProfile: 'work',
      restoreCookies: false,
    });
    expect(handle._meta).toMatchObject({ profileName: 'work', sessionName: 'login' });
  });

  it('should use profile cookies as canonical when profile and session are combined', async () => {
    isDaemonRunning.mockReturnValue(false);
    loadProfile.mockReturnValue({
      fingerprint: { locale: 'en-US', timezone: 'UTC', viewport: { width: 1280, height: 720 }, os: 'macos' },
      proxy: null,
      cookies: [],
    });
    getSession.mockReturnValue(sessionFixture('login', { profile: 'work' }));
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

  it('should fail before browser launch when an explicit profile is malformed', async () => {
    isDaemonRunning.mockReturnValue(false);
    loadProfile.mockImplementation(() => {
      throw new ProfileError('Profile "malformed" has an invalid format');
    });

    await expect(launchBrowser({ profile: 'malformed' })).rejects.toThrow('invalid format');
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it.each([
    ['locale', {
      ...DEFAULT_PROFILE,
      fingerprint: { ...DEFAULT_PROFILE.fingerprint, locale: 'en_US' },
    }],
    ['timezone', {
      ...DEFAULT_PROFILE,
      fingerprint: { ...DEFAULT_PROFILE.fingerprint, timezone: 'Mars/Olympus' },
    }],
    ['fractional viewport', {
      ...DEFAULT_PROFILE,
      fingerprint: {
        ...DEFAULT_PROFILE.fingerprint,
        viewport: { ...DEFAULT_PROFILE.fingerprint.viewport, width: 1280.5 },
      },
    }],
    ['oversized viewport', {
      ...DEFAULT_PROFILE,
      fingerprint: {
        ...DEFAULT_PROFILE.fingerprint,
        viewport: { ...DEFAULT_PROFILE.fingerprint.viewport, height: 16_385 },
      },
    }],
    ['negative geolocation accuracy', {
      ...DEFAULT_PROFILE,
      fingerprint: {
        ...DEFAULT_PROFILE.fingerprint,
        geo: { latitude: 0, longitude: 0, accuracy: -1 },
      },
    }],
    ['non-string cookie partition key', {
      ...DEFAULT_PROFILE,
      cookies: [{
        name: 'sid',
        value: '123',
        domain: 'example.com',
        path: '/',
        partitionKey: 42,
      }],
    }],
    ['inconsistent cookie address', {
      ...DEFAULT_PROFILE,
      cookies: [{
        name: 'sid',
        value: '123',
        url: 'https://example.com',
        domain: 'example.com',
        path: '/',
      }],
    }],
    ['invalid proxy URL', {
      ...DEFAULT_PROFILE,
      proxy: 'http://proxy.example:8080/path',
    }],
  ])('rejects malformed persisted profile %s before creating a browser', async (_label, profile) => {
    loadProfile.mockReturnValue(profile);

    await expect(launchBrowser({ profile: 'malformed' })).rejects.toMatchObject({
      name: 'ProfileError',
      code: 8,
    });

    expect(touchProfile).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('should fail before locks and browser launch when a session is malformed', async () => {
    getSession.mockImplementation(() => {
      throw new ProfileError('Session "malformed" has an invalid format');
    });

    await expect(launchBrowser({ session: 'malformed' })).rejects.toThrow('invalid format');
    expect(acquireStateLocks).not.toHaveBeenCalled();
    expect(loadProfile).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it.each([
    ['navigation URL', sessionFixture('malformed', { lastUrl: 'not a URL' })],
    ['cookie partition key', sessionFixture('malformed', {
      cookies: [{
        name: 'sid',
        value: '123',
        domain: 'example.com',
        path: '/',
        partitionKey: false,
      }],
    })],
    ['cookie address', sessionFixture('malformed', {
      cookies: [{
        name: 'sid',
        value: '123',
        url: 'https://example.com',
        domain: 'example.com',
        path: '/',
      }],
    })],
  ])('rejects malformed persisted session %s before creating a browser', async (_label, session) => {
    getSession.mockReturnValue(session);

    await expect(launchBrowser({ session: 'malformed' })).rejects.toMatchObject({
      name: 'ProfileError',
      code: 8,
    });

    expect(acquireStateLocks).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it('should release state locks when a profile fails before browser launch', async () => {
    const stateLease = createStateLease({ profile: 'missing' });
    acquireStateLocks.mockReturnValue(stateLease);
    loadProfile.mockImplementation(() => { throw new Error('Profile not found'); });

    await expect(launchBrowser({ profile: 'missing' })).rejects.toThrow('Profile not found');

    expect(stateLease).toHaveBeenCalledOnce();
  });

  it('should release state locks when browser creation fails', async () => {
    const stateLease = createStateLease({ session: 'login' });
    acquireStateLocks.mockReturnValue(stateLease);
    createBrowser.mockRejectedValue(new Error('launch failed'));

    await expect(launchBrowser({ session: 'login' })).rejects.toThrow('launch failed');

    expect(stateLease).toHaveBeenCalledOnce();
  });

  it('should clean up a partially initialized browser and release state locks', async () => {
    const stateLease = createStateLease({ session: 'login' });
    acquireStateLocks.mockReturnValue(stateLease);
    const mockBrowser = {
      newContext: vi.fn().mockRejectedValue(new Error('context failed')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    await expect(launchBrowser({ session: 'login' })).rejects.toThrow('Browser initialization failed');
    expect(mockBrowser.close).toHaveBeenCalledOnce();
    expect(stateLease).toHaveBeenCalledOnce();
  });

  it('should preserve the launch failure and retain ownership when rollback cannot close a connected browser', async () => {
    const stateLease = createStateLease({ session: 'login' });
    acquireStateLocks.mockReturnValue(stateLease);
    const initializationError = new Error('context failed');
    const cleanupError = new Error('browser still connected');
    const mockBrowser = {
      newContext: vi.fn().mockRejectedValue(initializationError),
      close: vi.fn().mockRejectedValue(cleanupError),
      isConnected: vi.fn(() => true),
    };
    createBrowser.mockResolvedValue(mockBrowser);

    let failure;
    try {
      await launchBrowser({ session: 'login' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'BrowserLaunchError',
      cause: initializationError,
      cleanupFailures: [expect.objectContaining({ target: 'browser', error: cleanupError })],
      cleanupError: expect.objectContaining({ name: 'BrowserCleanupError' }),
    });
    expect(stateLease).not.toHaveBeenCalled();
    expect(stateLease.owns('session', 'login')).toBe(true);
  });

  it('should retry a transient state-lease release during launch rollback', async () => {
    const stateLease = createStateLease({ session: 'login' });
    stateLease.mockImplementationOnce(() => {
      throw new Error('lock directory busy');
    });
    acquireStateLocks.mockReturnValue(stateLease);
    createBrowser.mockRejectedValue(new Error('launch failed'));

    let failure;
    try {
      await launchBrowser({ session: 'login' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'BrowserLaunchError',
      cleanupFailures: [],
    });
    expect(stateLease).toHaveBeenCalledTimes(2);
    expect(stateLease.owns('session', 'login')).toBe(false);
  });
});

describe('browser state persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireStateLocks.mockReset().mockImplementation((opts) => createStateLease(opts));
    loadProfile.mockReset().mockReturnValue(DEFAULT_PROFILE);
    getSession.mockReset().mockImplementation((name) => sessionFixture(name));
    restoreSession.mockReset().mockResolvedValue({ lastUrl: null, history: [], profile: null });
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
    const mocks = setupMockBrowser();
    mocks.mockPage.url = page.url;
    mocks.mockPage.isClosed = page.isClosed;
    mocks.mockContext.cookies.mockResolvedValue(cookies);
    mocks.mockContext.pages.mockImplementation(() => [mocks.mockPage]);
    const stateLease = createStateLease({ profile: 'work', session: 'login' });
    const { handle } = await launchStatefulBrowser(
      { profile: 'work', session: 'login' },
      mocks,
      stateLease,
    );

    const result = await persistBrowserState(handle);

    expect(mocks.mockContext.cookies).toHaveBeenCalledOnce();
    expect(saveProfileCookies).toHaveBeenCalledWith('work', cookies, {
      lease: stateLease,
    });
    expect(saveSessionSnapshot).toHaveBeenCalledWith(
      'login',
      expect.objectContaining({ cookies, lastUrl: 'https://example.com' }),
      { profile: 'work', lease: stateLease },
    );
    expect(result.results.profile.cookies).toBe(1);
  });

  it('should treat an empty cookie snapshot as a successful capture', async () => {
    const mocks = setupMockBrowser();
    mocks.mockContext.cookies.mockResolvedValue([]);
    mocks.mockContext.pages.mockReturnValue([]);
    const { handle } = await launchStatefulBrowser({ profile: 'work' }, mocks);
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
    const { handle } = await launchStatefulBrowser({
      profile: 'work',
      session: 'login',
    });
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
    expect(persistenceError.results.session).not.toHaveProperty('lastUrl');
    expect(JSON.stringify(persistenceError)).not.toContain('123');
    expect(JSON.stringify(persistenceError)).not.toContain('https://example.com');
    expect(saveSessionSnapshot).toHaveBeenCalledOnce();
  });

  it('should reject all state writes before mutation when any configured lease is not owned', async () => {
    const snapshot = {
      cookies: [],
      lastUrl: 'https://example.com',
      capturedAt: new Date().toISOString(),
    };
    const stateLease = createStateLease({ profile: 'work' });
    const { handle } = await launchStatefulBrowser(
      { profile: 'work', session: 'login' },
      setupMockBrowser(),
      stateLease,
    );

    await expect(writeBrowserStateSnapshot(handle, snapshot)).rejects.toMatchObject({
      name: 'PersistenceError',
      message: expect.stringContaining('session "login"'),
    });
    expect(saveProfileCookies).not.toHaveBeenCalled();
    expect(saveSessionSnapshot).not.toHaveBeenCalled();
  });

  it('should ignore a forged public _meta lease and reject the state write', async () => {
    const snapshot = {
      cookies: [],
      lastUrl: 'https://example.com',
      capturedAt: new Date().toISOString(),
    };
    const handle = {
      isDaemon: false,
      _meta: {
        profileName: 'work',
        stateLease: { owns: () => true },
      },
    };

    await expect(writeBrowserStateSnapshot(handle, snapshot)).rejects.toMatchObject({
      name: 'PersistenceError',
      message: expect.stringContaining('profile "work"'),
    });
    expect(saveProfileCookies).not.toHaveBeenCalled();
  });

  it('should trust a lifecycle-tracked nonblank URL instead of popup ordering', async () => {
    const primary = {
      url: vi.fn(() => 'https://example.com/primary'),
      isClosed: vi.fn(() => false),
    };
    const popup = {
      url: vi.fn(() => 'https://example.com/popup'),
      isClosed: vi.fn(() => false),
    };
    const pages = vi.fn(() => [primary, popup]);
    const handle = {
      isDaemon: false,
      browser: { isConnected: vi.fn(() => true) },
      context: { cookies: vi.fn().mockResolvedValue([]), pages },
      page: primary,
      _meta: { lastKnownUrl: 'https://example.com/lifecycle' },
    };

    const snapshot = await captureBrowserState(handle);

    expect(snapshot.lastUrl).toBe('https://example.com/lifecycle');
    expect(pages).not.toHaveBeenCalled();
  });

  it('should scan the primary page before popups when no tracked URL exists', async () => {
    const primary = {
      url: vi.fn(() => 'https://example.com/primary'),
      isClosed: vi.fn(() => false),
    };
    const popup = {
      url: vi.fn(() => 'https://example.com/popup'),
      isClosed: vi.fn(() => false),
    };
    const handle = {
      isDaemon: false,
      browser: { isConnected: vi.fn(() => true) },
      context: {
        cookies: vi.fn().mockResolvedValue([]),
        pages: vi.fn(() => [primary, popup]),
      },
      page: primary,
      _meta: { lastKnownUrl: 'about:blank' },
    };

    const snapshot = await captureBrowserState(handle);

    expect(snapshot.lastUrl).toBe('https://example.com/primary');
  });
});

describe('closeBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireStateLocks.mockReset().mockImplementation((opts) => createStateLease(opts));
    loadProfile.mockReset().mockReturnValue(DEFAULT_PROFILE);
    getSession.mockReset().mockImplementation((name) => sessionFixture(name));
    restoreSession.mockReset().mockResolvedValue({ lastUrl: null, history: [], profile: null });
    saveProfileCookies.mockReset().mockReturnValue(1);
    saveSessionSnapshot.mockReset().mockReturnValue({ cookies: [], lastUrl: null });
  });

  it('should be a no-op for daemon handles', async () => {
    const handle = { isDaemon: true, browser: null, context: null, page: null, _meta: {} };
    // Should not throw
    await closeBrowser(handle);
  });

  it('should close direct handles and release their private state lease', async () => {
    const stateLease = createStateLease();
    const mocks = setupMockBrowser();
    acquireStateLocks.mockReturnValueOnce(stateLease);
    const handle = await launchBrowser({ forceDirect: true });

    expect(handle._meta).not.toHaveProperty('stateLease');
    await closeBrowser(handle);

    expect(mocks.mockContext.close).toHaveBeenCalled();
    expect(mocks.mockBrowser.close).toHaveBeenCalled();
    expect(stateLease).toHaveBeenCalledOnce();
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
    createBrowser.mockResolvedValue(mockBrowser);
    mockBrowser.newContext = vi.fn().mockResolvedValue(mockContext);
    mockContext.newPage = vi.fn().mockResolvedValue({
      url: vi.fn(() => 'about:blank'),
      isClosed: vi.fn(() => false),
    });
    const { handle } = await launchStatefulBrowser(
      { profile: 'work' },
      { mockBrowser, mockContext, mockPage: null },
    );

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
    createBrowser.mockResolvedValue(mockBrowser);
    mockBrowser.newContext = vi.fn().mockResolvedValue(mockContext);
    mockContext.newPage = vi.fn().mockResolvedValue({
      url: vi.fn(() => 'about:blank'),
      isClosed: vi.fn(() => false),
    });
    const { handle } = await launchStatefulBrowser(
      { profile: 'work' },
      { mockBrowser, mockContext, mockPage: null },
    );

    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = await closeBrowser(handle);

    expect(result.persistenceError?.name).toBe('PersistenceError');
    expect(mockContext.close).toHaveBeenCalledOnce();
    expect(mockBrowser.close).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('should skip persistence when requested by a lifecycle coordinator', async () => {
    const mockContext = {
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn(),
    };
    const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
    createBrowser.mockResolvedValue(mockBrowser);
    mockBrowser.newContext = vi.fn().mockResolvedValue(mockContext);
    mockContext.newPage = vi.fn().mockResolvedValue({
      url: vi.fn(() => 'about:blank'),
      isClosed: vi.fn(() => false),
    });
    const { handle } = await launchStatefulBrowser(
      { profile: 'work' },
      { mockBrowser, mockContext, mockPage: null },
    );

    await closeBrowser(handle, { persist: false });

    expect(mockContext.cookies).not.toHaveBeenCalled();
    expect(mockContext.close).toHaveBeenCalledOnce();
  });

  it('should retry incomplete context and browser cleanup after transient failures', async () => {
    let connected = true;
    const mocks = setupMockBrowser();
    mocks.mockContext.close
      .mockRejectedValueOnce(new Error('context busy'))
      .mockResolvedValue(undefined);
    mocks.mockBrowser.isConnected.mockImplementation(() => connected);
    mocks.mockBrowser.close
      .mockRejectedValueOnce(new Error('browser busy'))
      .mockImplementationOnce(async () => {
        connected = false;
      });
    const stateLease = createStateLease({ profile: 'work' });
    const { handle, mockContext, mockBrowser } = await launchStatefulBrowser(
      { profile: 'work' },
      mocks,
      stateLease,
    );

    const first = await closeBrowser(handle);
    expect(first.cleanupErrors.map(({ target }) => target)).toEqual(['context', 'browser']);
    expect(stateLease).not.toHaveBeenCalled();

    const second = await closeBrowser(handle);
    expect(second.cleanupErrors).toEqual([]);
    expect(mockContext.close).toHaveBeenCalledTimes(2);
    expect(mockBrowser.close).toHaveBeenCalledTimes(2);
    expect(mockContext.cookies).toHaveBeenCalledOnce();
    expect(saveProfileCookies).toHaveBeenCalledOnce();
    expect(stateLease).toHaveBeenCalledOnce();
  });

  it('should retry an incomplete browser close before releasing the state lease', async () => {
    let connected = true;
    const mocks = setupMockBrowser();
    mocks.mockBrowser.isConnected.mockImplementation(() => connected);
    mocks.mockBrowser.close
      .mockRejectedValueOnce(new Error('browser busy'))
      .mockImplementationOnce(async () => {
        connected = false;
      });
    const stateLease = createStateLease({ profile: 'work' });
    const { handle, mockContext, mockBrowser } = await launchStatefulBrowser(
      { profile: 'work' },
      mocks,
      stateLease,
    );

    const first = await closeBrowser(handle);
    expect(first.cleanupErrors.map(({ target }) => target)).toEqual(['browser']);
    expect(stateLease).not.toHaveBeenCalled();
    expect(stateLease.owns('profile', 'work')).toBe(true);

    const second = await closeBrowser(handle);
    expect(second.cleanupErrors).toEqual([]);
    expect(mockContext.close).toHaveBeenCalledOnce();
    expect(mockBrowser.close).toHaveBeenCalledTimes(2);
    expect(mockContext.cookies).toHaveBeenCalledOnce();
    expect(saveProfileCookies).toHaveBeenCalledOnce();
    expect(stateLease).toHaveBeenCalledOnce();
  });

  it('should treat confirmed browser disconnection as completed cleanup', async () => {
    const stateLease = createStateLease({ profile: 'work' });
    const mocks = setupMockBrowser();
    const { handle } = await launchStatefulBrowser(
      { profile: 'work' },
      mocks,
      stateLease,
    );
    mocks.mockBrowser.close.mockRejectedValue(new Error('already disconnected'));
    mocks.mockBrowser.isConnected.mockReturnValue(false);
    mocks.mockContext.close.mockRejectedValue(new Error('context already closed'));

    const result = await closeBrowser(handle, { persist: false });

    expect(result.cleanupErrors).toEqual([]);
    expect(stateLease).toHaveBeenCalledOnce();
  });

  it('should retry only a transient state-lease release failure', async () => {
    const mocks = setupMockBrowser();
    const stateLease = createStateLease({ profile: 'work' });
    stateLease.mockImplementationOnce(() => {
      throw new Error('lock directory busy');
    });
    const { handle, mockContext, mockBrowser } = await launchStatefulBrowser(
      { profile: 'work' },
      mocks,
      stateLease,
    );

    const first = await closeBrowser(handle);
    const second = await closeBrowser(handle);

    expect(first.cleanupErrors.map(({ target }) => target)).toEqual(['state-lock']);
    expect(second.cleanupErrors).toEqual([]);
    expect(mockContext.close).toHaveBeenCalledOnce();
    expect(mockBrowser.close).toHaveBeenCalledOnce();
    expect(mockContext.cookies).toHaveBeenCalledOnce();
    expect(saveProfileCookies).toHaveBeenCalledOnce();
    expect(stateLease).toHaveBeenCalledTimes(2);
  });

  it('should create separate strict errors for concurrent callers without mutating cached persistence', async () => {
    const cleanupError = new Error('browser busy');
    const mocks = setupMockBrowser();
    mocks.mockContext.cookies.mockRejectedValue(new Error('capture unavailable'));
    mocks.mockBrowser.close
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined);
    mocks.mockBrowser.isConnected.mockReturnValue(true);
    const { handle } = await launchStatefulBrowser({ profile: 'work' }, mocks);

    const settled = await Promise.allSettled([
      closeBrowser(handle, { strict: true }),
      closeBrowser(handle, { strict: true }),
    ]);
    const failures = settled.map((entry) => entry.reason);

    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
    expect(failures[0]).not.toBe(failures[1]);
    expect(failures[0]).toMatchObject({
      name: 'PersistenceError',
      cause: expect.objectContaining({ name: 'PersistenceError' }),
      cleanupFailures: [{ target: 'browser', error: cleanupError }],
    });
    expect(failures[1].cause).toBe(failures[0].cause);
    expect(failures[0].cause.cleanupFailures).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(failures[0], 'cause')?.enumerable).toBe(false);

    await expect(closeBrowser(handle)).resolves.toMatchObject({ cleanupErrors: [] });
  });

  it('should not report stale cleanup failures after a strict retry succeeds', async () => {
    const cleanupError = new Error('browser busy');
    const mocks = setupMockBrowser();
    mocks.mockContext.cookies.mockRejectedValue(new Error('capture unavailable'));
    mocks.mockBrowser.close
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValueOnce(undefined);
    mocks.mockBrowser.isConnected.mockReturnValue(true);
    const { handle } = await launchStatefulBrowser({ profile: 'work' }, mocks);

    let firstFailure;
    try {
      await closeBrowser(handle, { strict: true });
    } catch (error) {
      firstFailure = error;
    }
    const cachedPersistenceError = firstFailure.cause;

    let retryFailure;
    try {
      await closeBrowser(handle, { strict: true });
    } catch (error) {
      retryFailure = error;
    }

    expect(firstFailure.cleanupFailures).toEqual([
      { target: 'browser', error: cleanupError },
    ]);
    expect(retryFailure).toBe(cachedPersistenceError);
    expect(retryFailure.cleanupFailures).toEqual([]);
    expect(retryFailure.format()).not.toContain('Cleanup incomplete');
    expect(mocks.mockContext.cookies).toHaveBeenCalledOnce();
    expect(mocks.mockBrowser.close).toHaveBeenCalledTimes(2);
  });

  it('should preserve an exact state-lock hint when strict persistence and cleanup both fail', async () => {
    const exactHint = 'After confirming no stealth process is using this state, remove this exact lock file: /tmp/locks/abc.lock';
    const stateLease = createStateLease({ profile: 'work' });
    stateLease.mockImplementationOnce(() => {
      throw new ProfileError('lock release failed', {
        hint: exactHint,
        cause: new Error('https://example.com/callback?token=cleanup-secret'),
      });
    });
    const mocks = setupMockBrowser();
    const { handle } = await launchStatefulBrowser(
      { profile: 'work' },
      mocks,
      stateLease,
    );
    mocks.mockContext.cookies.mockRejectedValue(
      new Error('https://example.com/callback?token=persistence-secret'),
    );

    let failure;
    try {
      await closeBrowser(handle, { strict: true });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'PersistenceError',
      cause: expect.objectContaining({ name: 'PersistenceError' }),
      cleanupFailures: [expect.objectContaining({ target: 'state-lock' })],
    });
    expect(failure.cause.cleanupFailures).toEqual([]);
    expect(failure.format()).toContain(exactHint);
    expect(JSON.stringify(failure)).toContain(exactHint);
    expect(JSON.stringify(failure)).not.toContain('cleanup-secret');
    expect(JSON.stringify(failure)).not.toContain('persistence-secret');
  });

  it('should use a cleanup-specific error in strict mode', async () => {
    const handle = {
      isDaemon: false,
      browser: {
        close: vi.fn().mockRejectedValue(new Error('browser busy')),
        isConnected: vi.fn(() => true),
      },
      context: { close: vi.fn().mockResolvedValue(undefined) },
      page: null,
      _meta: {},
    };

    let failure;
    try {
      await closeBrowser(handle, { persist: false, strict: true });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'BrowserCleanupError',
      code: 1,
      failures: [expect.objectContaining({ target: 'browser' })],
    });
    expect(failure.hint).not.toContain('camoufox-js fetch');
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
    const handle = {
      isDaemon: false,
      page: mockPage,
      _meta: { lastKnownUrl: 'https://saved.example/account' },
    };

    const result = await navigate(handle, 'https://example.com');

    expect(mockPage.goto).toHaveBeenCalled();
    expect(result).toBe('https://example.com/');
    expect(handle._meta.lastKnownUrl).toBe('https://example.com/');
  });

  it('should keep the saved URL when a successful navigation still reports about:blank', async () => {
    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('about:blank'),
    };
    const handle = {
      isDaemon: false,
      page: mockPage,
      _meta: { lastKnownUrl: 'https://saved.example/account' },
    };

    await navigate(handle, 'about:blank');

    expect(handle._meta.lastKnownUrl).toBe('https://saved.example/account');
  });

  it('should redact credentials, paths, queries, and fragments from navigation failures', async () => {
    const rawUrl = 'https://user:password@example.com/callback?code=secret#token';
    const mockPage = {
      goto: vi.fn().mockRejectedValue(new Error(`page.goto failed for ${rawUrl}`)),
      url: vi.fn(() => 'https://saved.example/account'),
    };
    const handle = {
      isDaemon: false,
      page: mockPage,
      _meta: { lastKnownUrl: 'https://saved.example/account' },
    };

    let failure;
    try {
      await navigate(handle, rawUrl, { retries: 0 });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: 'NavigationError',
      url: rawUrl,
      message: 'Failed to navigate to https://example.com',
    });
    expect(failure.format()).not.toContain('password');
    expect(failure.format()).not.toContain('callback');
    expect(failure.format()).not.toContain('secret');
    expect(failure.format()).not.toContain('token');
    expect(handle._meta.lastKnownUrl).toBe('https://saved.example/account');
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

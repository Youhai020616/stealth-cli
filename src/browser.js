/**
 * Core browser module - wraps camoufox-js for anti-detection browsing
 *
 * Supports two modes:
 *   1. Direct mode  — launches a new browser per command
 *   2. Daemon mode  — reuses background browser (faster)
 */

import { withRetry, navigateWithRetry } from './retry.js';
import { postNavigationBehavior } from './humanize.js';
import { isDaemonRunning } from './daemon.js';
import { daemonNavigate, daemonRequest } from './client.js';
import { loadProfile, touchProfile, saveCookiesToProfile, loadCookiesFromProfile } from './profiles.js';
import { restoreSession, captureSession } from './session.js';
import { getNextProxy } from './proxy-pool.js';
import { getHostOS, createBrowser, extractPageText } from './utils/browser-factory.js';
import { log } from './output.js';
import { BrowserLaunchError, NavigationError } from './errors.js';

/**
 * Build proxy configuration
 */
function buildProxy(proxyStr) {
  if (!proxyStr) return null;

  try {
    let url;
    if (proxyStr.startsWith('http')) {
      url = new URL(proxyStr);
    } else {
      url = new URL(`http://${proxyStr}`);
    }

    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch {
    const [host, port] = proxyStr.split(':');
    return { server: `http://${host}:${port}` };
  }
}

/**
 * Launch a stealth browser instance
 *
 * @param {object} opts
 * @param {boolean} [opts.headless=true] - Run in headless mode
 * @param {string} [opts.proxy] - Proxy string (http://user:pass@host:port)
 * @param {boolean} [opts.proxyRotate] - Use proxy pool rotation
 * @param {string} [opts.profile] - Profile name to use
 * @param {string} [opts.session] - Session name (persist cookies/state)
 * @param {string} [opts.locale] - Browser locale (default: en-US)
 * @param {string} [opts.timezone] - Timezone ID
 * @param {object} [opts.viewport] - { width, height }
 * @param {boolean} [opts.humanize] - Enable human behavior simulation
 * @returns {Promise<{ browser, context, page, isDaemon, _meta }>}
 */
export async function launchBrowser(opts = {}) {
  let {
    headless = true,
    proxy: proxyStr,
    proxyRotate = false,
    profile: profileName,
    session: sessionName,
    locale = 'en-US',
    timezone = 'America/Los_Angeles',
    viewport = { width: 1280, height: 720 },
    humanize = false,
  } = opts;

  // --- Load profile if specified ---
  let profileData = null;
  if (profileName) {
    try {
      profileData = loadProfile(profileName);
      const fp = profileData.fingerprint;
      locale = fp.locale || locale;
      timezone = fp.timezone || timezone;
      viewport = fp.viewport || viewport;
      if (profileData.proxy && !proxyStr) {
        proxyStr = profileData.proxy;
      }
      touchProfile(profileName);
    } catch (err) {
      log.warn(`Profile "${profileName}" failed to load: ${err.message}`);
    }
  }

  // --- Proxy pool rotation ---
  if (proxyRotate && !proxyStr) {
    proxyStr = getNextProxy();
  }

  // Check if daemon is available (skip if proxy/profile/session needed)
  if (!proxyStr && !profileName && !sessionName && isDaemonRunning()) {
    return {
      browser: null,
      context: null,
      page: null,
      isDaemon: true,
      _meta: { profileName, sessionName, proxyUrl: null },
    };
  }

  const hostOS = profileData?.fingerprint?.os || getHostOS();
  const proxy = buildProxy(proxyStr);

  let browser;
  try {
    browser = await createBrowser({
      headless,
      os: hostOS,
      proxy: proxy || undefined,
    });
  } catch (err) {
    throw new BrowserLaunchError(err.message, { cause: err });
  }

  const contextOptions = {
    viewport,
    permissions: ['geolocation'],
  };

  if (!proxy) {
    contextOptions.locale = locale;
    contextOptions.timezoneId = timezone;
    const geo = profileData?.fingerprint?.geo || { latitude: 37.7749, longitude: -122.4194 };
    contextOptions.geolocation = geo;
  }

  const context = await browser.newContext(contextOptions);

  // --- Restore profile cookies ---
  if (profileName) {
    await loadCookiesFromProfile(profileName, context);
  }

  // --- Restore session ---
  let sessionInfo = null;
  if (sessionName) {
    sessionInfo = await restoreSession(sessionName, context);
  }

  const page = await context.newPage();

  // If session had a last URL, navigate to it
  if (sessionInfo?.lastUrl && sessionInfo.lastUrl !== 'about:blank') {
    try {
      await page.goto(sessionInfo.lastUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      log.warn(`Session URL restore failed (${sessionInfo.lastUrl}): ${err.message}`);
    }
  }

  return {
    browser, context, page, isDaemon: false,
    _meta: { profileName, sessionName, proxyUrl: proxyStr, sessionInfo },
  };
}

/**
 * Safely close browser and clean up (no-op for daemon mode)
 * Auto-saves profile cookies and session state before closing
 */
export async function closeBrowser(handle) {
  const { browser, context, page, isDaemon, _meta } = handle;

  if (isDaemon) return;

  try {
    // Auto-save profile cookies
    if (_meta?.profileName && context) {
      await saveCookiesToProfile(_meta.profileName, context).catch(() => {});
    }

    // Auto-save session
    if (_meta?.sessionName && context && page) {
      await captureSession(_meta.sessionName, context, page, {
        profile: _meta.profileName,
      }).catch(() => {});
    }

    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Navigate to URL — uses daemon if available, with retry support
 *
 * @param {object} handle - { page, isDaemon } from launchBrowser
 * @param {string} url - Target URL
 * @param {object} opts - Navigation options
 */
export async function navigate(handle, url, opts = {}) {
  const { timeout = 30000, waitUntil = 'domcontentloaded', humanize = false, retries = 2 } = opts;

  try {
    if (handle.isDaemon) {
      const result = await withRetry(
        async () => {
          const res = await daemonNavigate(url, { timeout, waitUntil });
          if (!res?.ok) throw new Error(res?.error || 'Daemon navigation failed');
          return res.url;
        },
        { maxRetries: retries, label: `navigate(daemon)` },
      );
      return result;
    }

    const finalUrl = await navigateWithRetry(handle.page, url, { timeout, waitUntil, maxRetries: retries });

    // Human behavior after navigation
    if (humanize) {
      await postNavigationBehavior(handle.page);
    }

    return finalUrl;
  } catch (err) {
    if (err instanceof NavigationError) throw err;
    throw new NavigationError(url, err);
  }
}

/**
 * Wait for page to be ready
 */
export async function waitForReady(page, opts = {}) {
  const { timeout = 5000, waitForNetwork = true } = opts;

  if (!page) return; // Daemon mode — no direct page access

  try {
    if (waitForNetwork) {
      await page.waitForLoadState('networkidle', { timeout });
    } else {
      await page.waitForLoadState('domcontentloaded', { timeout });
    }
  } catch {
    // Timeout is OK
  }
}

/**
 * Get accessibility snapshot of the page
 */
export async function getSnapshot(handle) {
  if (handle.isDaemon) {
    const res = await daemonRequest('/snapshot');
    return res?.snapshot || '';
  }

  try {
    await waitForReady(handle.page, { waitForNetwork: false });
    const snapshot = await handle.page.locator('body').ariaSnapshot({ timeout: 8000 });
    return snapshot || '';
  } catch {
    return '';
  }
}

/**
 * Extract visible text content from page
 */
export async function getTextContent(handle) {
  if (handle.isDaemon) {
    const res = await daemonRequest('/text');
    return res?.text || '';
  }

  return handle.page.evaluate(extractPageText);
}

/**
 * Get page title
 */
export async function getTitle(handle) {
  if (handle.isDaemon) {
    const res = await daemonRequest('/title');
    return res?.title || '';
  }
  return handle.page.title();
}

/**
 * Get current URL
 */
export async function getUrl(handle) {
  if (handle.isDaemon) {
    // Use /title endpoint which returns the current page URL
    const res = await daemonRequest('/title');
    return res?.url || 'about:blank';
  }
  return handle.page.url();
}

/**
 * Take screenshot
 */
export async function takeScreenshot(handle, opts = {}) {
  const { path: filePath, fullPage = false } = opts;

  if (handle.isDaemon) {
    const res = await daemonRequest('/screenshot', { fullPage });
    if (res?.data && filePath) {
      const { writeFileSync } = await import('fs');
      writeFileSync(filePath, Buffer.from(res.data, 'base64'));
    }
    return res;
  }

  const screenshotOpts = { fullPage };
  if (filePath) screenshotOpts.path = filePath;

  const buffer = await handle.page.screenshot(screenshotOpts);
  return { data: buffer.toString('base64') };
}

/**
 * Evaluate JavaScript in page
 */
export async function evaluate(handle, expression) {
  if (handle.isDaemon) {
    const res = await daemonRequest('/evaluate', { expression });
    return res?.result;
  }
  return handle.page.evaluate(expression);
}

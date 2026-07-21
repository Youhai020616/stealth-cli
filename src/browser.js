/**
 * Core browser module - wraps camoufox-js for anti-detection browsing
 *
 * Supports two modes:
 *   1. Direct mode  — launches a new browser per command
 *   2. Daemon mode  — reuses background browser (faster)
 */

import { withRetry, navigateWithRetry } from "./retry.js";
import { postNavigationBehavior } from "./humanize.js";
import { isDaemonRunning } from "./daemon.js";
import { daemonNavigate, daemonRequest } from "./client.js";
import {
  loadProfile,
  touchProfile,
  saveProfileCookies,
  loadCookiesFromProfile,
} from "./profiles.js";
import {
  getSession,
  restoreSession,
  saveSessionSnapshot,
} from "./session.js";
import { getNextProxy } from "./proxy-pool.js";
import {
  getHostOS,
  createBrowser,
  extractPageText,
} from "./utils/browser-factory.js";
import { log } from "./output.js";
import {
  BrowserLaunchError,
  NavigationError,
  PersistenceError,
  ProfileError,
} from "./errors.js";
import { buildA11yTree, clickByRef, typeByRef, hoverByRef } from "./a11y.js";

const closeOperations = new WeakMap();

/**
 * Build proxy configuration
 */
function describeUrlForLog(value) {
  try {
    return new URL(value).origin;
  } catch {
    return 'saved session URL';
  }
}

function buildProxy(proxyStr) {
  if (!proxyStr) return null;

  try {
    let url;
    if (proxyStr.startsWith("http")) {
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
    const [host, port] = proxyStr.split(":");
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
 * @param {boolean} [opts.forceDirect=false] - Never route through the daemon
 * @param {boolean} [opts.handleSignals=true] - Let Playwright own process signal handling
 * @returns {Promise<{ browser, context, page, isDaemon, _meta }>}
 */
export async function launchBrowser(opts = {}) {
  let {
    headless = true,
    proxy: proxyStr,
    proxyRotate = false,
    profile: profileName,
    session: sessionName,
    locale = "en-US",
    timezone = "America/Los_Angeles",
    viewport = { width: 1280, height: 720 },
    humanize = false,
    forceDirect = false,
    handleSignals = true,
  } = opts;

  // --- Load profile if specified ---
  let profileData = null;
  if (profileName) {
    profileData = loadProfile(profileName);
    const fp = profileData.fingerprint;
    locale = fp.locale || locale;
    timezone = fp.timezone || timezone;
    viewport = fp.viewport || viewport;
    if (profileData.proxy && !proxyStr) {
      proxyStr = profileData.proxy;
    }
  }

  // Validate profile/session identity before launching a browser. A linked
  // session must never merge authentication state from another profile.
  if (profileName && sessionName) {
    const session = getSession(sessionName);
    if (session.profile && session.profile !== profileName) {
      throw new ProfileError(
        `Session "${sessionName}" belongs to profile "${session.profile}", not "${profileName}"`,
        { hint: 'Use the linked profile or choose a different --session name' },
      );
    }
  }

  if (profileName) touchProfile(profileName);

  // --- Proxy pool rotation ---
  if (proxyRotate && !proxyStr) {
    proxyStr = getNextProxy();
  }

  // A headed or stateful browser requires its own local context. Reusing a
  // daemon here would ignore the requested window and persistence semantics.
  if (
    !forceDirect &&
    headless !== false &&
    !proxyStr &&
    !profileName &&
    !sessionName &&
    isDaemonRunning()
  ) {
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
      handleSignals,
    });
  } catch (err) {
    throw new BrowserLaunchError(err.message, { cause: err });
  }

  const contextOptions = {
    viewport,
    permissions: ["geolocation"],
  };

  if (!proxy) {
    contextOptions.locale = locale;
    contextOptions.timezoneId = timezone;
    const geo = profileData?.fingerprint?.geo || {
      latitude: 37.7749,
      longitude: -122.4194,
    };
    contextOptions.geolocation = geo;
  }

  let context;
  let page;
  let sessionInfo = null;

  try {
    context = await browser.newContext(contextOptions);

    if (profileName) {
      try {
        await loadCookiesFromProfile(profileName, context);
      } catch (cause) {
        throw new ProfileError(`Failed to restore profile "${profileName}"`, {
          hint: 'The saved profile cookies may be invalid',
          cause,
        });
      }
    }

    if (sessionName) {
      try {
        sessionInfo = await restoreSession(sessionName, context, {
          expectedProfile: profileName,
          restoreCookies: !profileName,
        });
      } catch (cause) {
        throw new ProfileError(`Failed to restore session "${sessionName}"`, {
          hint: 'Use a new --session name or remove the corrupted session file',
          cause,
        });
      }
    }

    page = await context.newPage();

    if (sessionInfo?.lastUrl && sessionInfo.lastUrl !== "about:blank") {
      try {
        await page.goto(sessionInfo.lastUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
      } catch {
        log.warn(
          `Session URL restore failed for ${describeUrlForLog(sessionInfo.lastUrl)}; continuing with a blank page`,
        );
      }
    }
  } catch (error) {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    if (error instanceof ProfileError) throw error;
    throw new BrowserLaunchError(`Browser initialization failed: ${error.message}`, {
      cause: error,
    });
  }

  let lastKnownUrl = 'about:blank';
  try {
    lastKnownUrl = page.url();
  } catch {}

  return {
    browser,
    context,
    page,
    isDaemon: false,
    _meta: {
      profileName,
      sessionName,
      proxyUrl: proxyStr,
      sessionInfo,
      lastKnownUrl,
    },
  };
}

/**
 * Capture browser state while the Playwright context is still connected.
 * Cookie values remain in-memory and are never included in log messages.
 *
 * @param {object} handle
 * @returns {Promise<{ cookies: Array<object>, lastUrl: string | null, capturedAt: string }>}
 */
export async function captureBrowserState(handle) {
  const { browser, context, page, isDaemon, _meta } = handle || {};

  if (isDaemon || !context) {
    throw new PersistenceError('Cannot capture state from a daemon browser');
  }
  if (typeof browser?.isConnected === 'function' && !browser.isConnected()) {
    throw new PersistenceError('Cannot capture state after the browser disconnected');
  }

  let lastUrl = _meta?.lastKnownUrl || null;
  const pages = typeof context.pages === 'function' ? context.pages() : [];
  const candidates = [page, ...pages].filter(Boolean).reverse();
  for (const candidate of candidates) {
    try {
      if (typeof candidate.isClosed === 'function' && candidate.isClosed()) continue;
      const candidateUrl = candidate.url();
      if (candidateUrl && candidateUrl !== 'about:blank') {
        lastUrl = candidateUrl;
        break;
      }
      if (!lastUrl && candidateUrl) lastUrl = candidateUrl;
    } catch {}
  }

  if (_meta && lastUrl) _meta.lastKnownUrl = lastUrl;

  let cookies;
  try {
    cookies = await context.cookies();
  } catch (cause) {
    throw new PersistenceError('Failed to capture browser authentication state', {
      cause,
    });
  }

  return {
    cookies,
    lastUrl,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Write a previously captured snapshot to every configured persistence target.
 * Profile and session writes are attempted independently.
 *
 * @param {object} handle
 * @param {{ cookies: Array<object>, lastUrl: string | null, capturedAt: string }} snapshot
 */
export async function writeBrowserStateSnapshot(handle, snapshot) {
  const { _meta = {}, isDaemon } = handle || {};
  const { profileName, sessionName } = _meta;
  const results = { profile: null, session: null };
  const failures = [];

  if (isDaemon || (!profileName && !sessionName)) {
    return { snapshot, results };
  }

  if (profileName) {
    try {
      results.profile = {
        name: profileName,
        cookies: saveProfileCookies(profileName, snapshot.cookies),
      };
    } catch (error) {
      failures.push({ target: 'profile', name: profileName, error });
    }
  }

  if (sessionName) {
    try {
      const session = saveSessionSnapshot(sessionName, snapshot, {
        profile: profileName,
      });
      results.session = {
        name: sessionName,
        cookies: session.cookies.length,
        lastUrl: session.lastUrl,
      };
    } catch (error) {
      failures.push({ target: 'session', name: sessionName, error });
    }
  }

  if (failures.length > 0) {
    const failedTargets = failures.map(({ target, name }) => `${target} "${name}"`).join(', ');
    throw new PersistenceError(`Failed to save browser state to ${failedTargets}`, {
      cause: failures[0].error,
      failures,
      results,
      snapshotMetadata: {
        capturedAt: snapshot.capturedAt,
        cookieCount: snapshot.cookies.length,
      },
    });
  }

  return { snapshot, results };
}

/**
 * Capture current state once and persist the same snapshot to all targets.
 */
export async function persistBrowserState(handle) {
  const { profileName, sessionName } = handle?._meta || {};
  if (handle?.isDaemon || (!profileName && !sessionName)) {
    return {
      snapshot: null,
      results: { profile: null, session: null },
    };
  }

  const snapshot = await captureBrowserState(handle);
  return writeBrowserStateSnapshot(handle, snapshot);
}

/**
 * Safely close a browser exactly once.
 *
 * Persistence is best-effort by default for SDK compatibility. Callers that
 * need a strict guarantee should use persistBrowserState() first and then call
 * closeBrowser(handle, { persist: false }).
 *
 * @param {object} handle
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true]
 * @param {boolean} [opts.strict=false]
 */
export async function closeBrowser(handle, opts = {}) {
  const { persist = true, strict = false } = opts;

  if (!handle || handle.isDaemon) {
    return { persistence: null, persistenceError: null, cleanupErrors: [] };
  }

  let closeOperation = closeOperations.get(handle);
  if (!closeOperation) {
    closeOperation = (async () => {
      const { browser, context } = handle;
      let persistence = null;
      let persistenceError = null;
      const cleanupErrors = [];

      if (persist) {
        try {
          persistence = await persistBrowserState(handle);
        } catch (error) {
          persistenceError = error;
          log.warn(`Browser state was not fully saved: ${error.message}`);
        }
      }

      if (context) {
        try {
          await context.close();
        } catch (error) {
          cleanupErrors.push({ target: 'context', error });
        }
      }
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          cleanupErrors.push({ target: 'browser', error });
        }
      }

      return { persistence, persistenceError, cleanupErrors };
    })();
    closeOperations.set(handle, closeOperation);
  }

  const result = await closeOperation;
  if (strict && result.persistenceError) throw result.persistenceError;
  if (strict && result.cleanupErrors.length > 0) {
    throw new BrowserLaunchError('Browser cleanup failed', {
      cause: result.cleanupErrors[0].error,
    });
  }
  return result;
}

/**
 * Navigate to URL — uses daemon if available, with retry support
 *
 * @param {object} handle - { page, isDaemon } from launchBrowser
 * @param {string} url - Target URL
 * @param {object} opts - Navigation options
 */
export async function navigate(handle, url, opts = {}) {
  const {
    timeout = 30000,
    waitUntil = "domcontentloaded",
    humanize = false,
    retries = 2,
  } = opts;

  try {
    if (handle.isDaemon) {
      const result = await withRetry(
        async () => {
          const res = await daemonNavigate(url, { timeout, waitUntil });
          if (!res?.ok)
            throw new Error(res?.error || "Daemon navigation failed");
          return res.url;
        },
        { maxRetries: retries, label: `navigate(daemon)` },
      );
      if (handle._meta) handle._meta.lastKnownUrl = result;
      return result;
    }

    const finalUrl = await navigateWithRetry(handle.page, url, {
      timeout,
      waitUntil,
      maxRetries: retries,
    });

    // Human behavior after navigation
    if (humanize) {
      await postNavigationBehavior(handle.page);
    }

    if (handle._meta) handle._meta.lastKnownUrl = finalUrl;
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
      await page.waitForLoadState("networkidle", { timeout });
    } else {
      await page.waitForLoadState("domcontentloaded", { timeout });
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
    const res = await daemonRequest("/snapshot");
    return res?.snapshot || "";
  }

  try {
    await waitForReady(handle.page, { waitForNetwork: false });
    const snapshot = await handle.page
      .locator("body")
      .ariaSnapshot({ timeout: 8000 });
    return snapshot || "";
  } catch {
    return "";
  }
}

/**
 * Extract visible text content from page
 */
export async function getTextContent(handle) {
  if (handle.isDaemon) {
    const res = await daemonRequest("/text");
    return res?.text || "";
  }

  return handle.page.evaluate(extractPageText);
}

/**
 * Get page title
 */
export async function getTitle(handle) {
  if (handle.isDaemon) {
    const res = await daemonRequest("/title");
    return res?.title || "";
  }
  return handle.page.title();
}

/**
 * Get current URL
 */
export async function getUrl(handle) {
  if (handle.isDaemon) {
    // Use /title endpoint which returns the current page URL
    const res = await daemonRequest("/title");
    return res?.url || "about:blank";
  }
  return handle.page.url();
}

/**
 * Take screenshot
 */
export async function takeScreenshot(handle, opts = {}) {
  const { path: filePath, fullPage = false } = opts;

  if (handle.isDaemon) {
    const res = await daemonRequest("/screenshot", { fullPage });
    if (res?.data && filePath) {
      const { writeFileSync } = await import("fs");
      writeFileSync(filePath, Buffer.from(res.data, "base64"));
    }
    return res;
  }

  const screenshotOpts = { fullPage };
  if (filePath) screenshotOpts.path = filePath;

  const buffer = await handle.page.screenshot(screenshotOpts);
  return { data: buffer.toString("base64") };
}

/**
 * Evaluate JavaScript in page
 */
export async function evaluate(handle, expression) {
  if (handle.isDaemon) {
    const res = await daemonRequest("/evaluate", { expression });
    return res?.result;
  }
  return handle.page.evaluate(expression);
}

/**
 * Get accessibility tree snapshot with [ref=eN] markers
 */
export async function getA11ySnapshot(handle) {
  if (handle.isDaemon) {
    const res = await daemonRequest("/a11y-snapshot");
    if (res?.ok) {
      return {
        tree: res.tree || "",
        refs: res.refs || {},
        totalRefs: res.totalRefs || 0,
      };
    }
    return { tree: "", refs: {}, totalRefs: 0 };
  }
  return buildA11yTree(handle.page);
}

/**
 * Click element by ref ID from accessibility snapshot
 */
export async function clickRef(handle, ref) {
  if (handle.isDaemon) {
    const res = await daemonRequest("/click-ref", { ref });
    if (!res?.ok) throw new Error(res?.error || "Click ref failed");
    return;
  }
  await clickByRef(handle.page, ref);
}

/**
 * Type text into element by ref ID from accessibility snapshot
 */
export async function typeRef(handle, ref, text, opts = {}) {
  if (handle.isDaemon) {
    const res = await daemonRequest("/type-ref", { ref, text, ...opts });
    if (!res?.ok) throw new Error(res?.error || "Type ref failed");
    return;
  }
  await typeByRef(handle.page, ref, text, opts);
}

/**
 * Hover element by ref ID from accessibility snapshot
 */
export async function hoverRef(handle, ref) {
  if (handle.isDaemon) {
    const res = await daemonRequest("/hover-ref", { ref });
    if (!res?.ok) throw new Error(res?.error || "Hover ref failed");
    return;
  }
  await hoverByRef(handle.page, ref);
}

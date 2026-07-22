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
  validateStoredProfile,
} from "./profiles.js";
import {
  getSession,
  restoreSession,
  saveSessionSnapshot,
  validateStoredSession,
} from "./session.js";
import { getNextProxy } from "./proxy-pool.js";
import {
  getHostOS,
  createBrowser,
  extractPageText,
} from "./utils/browser-factory.js";
import { log } from "./output.js";
import {
  BrowserCleanupError,
  BrowserLaunchError,
  NavigationError,
  PersistenceError,
  ProfileError,
  ProxyError,
  attachCleanupFailures,
  safeUrlForDisplay,
} from "./errors.js";
import { buildA11yTree, clickByRef, typeByRef, hoverByRef } from "./a11y.js";
import { acquireStateLocks, ownsStateLock } from "./utils/state-lock.js";
import { toPlaywrightProxy } from "./utils/proxy.js";
import { assertStateName } from "./utils/storage-paths.js";

const closeStates = new WeakMap();
const stateLeases = new WeakMap();
const lastKnownUrls = new WeakMap();
const launchRollbackHandles = new WeakMap();

function isNonBlankUrl(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'about:blank';
}

export function trackLastKnownUrl(handle, value) {
  if (isNonBlankUrl(value) && handle && typeof handle === 'object') {
    lastKnownUrls.set(handle, value);
  }
}

function configuredStateTargets(meta = {}) {
  const targets = [];
  if (meta.profileName) targets.push({ kind: 'profile', name: meta.profileName });
  if (meta.sessionName) targets.push({ kind: 'session', name: meta.sessionName });
  return targets;
}

function requireOwningStateLease(handle) {
  const targets = configuredStateTargets(handle?._meta);
  const stateLease = stateLeases.get(handle);
  const unowned = targets.filter(({ kind, name }) => {
    try {
      return !ownsStateLock(stateLease, kind, name);
    } catch {
      return true;
    }
  });

  if (unowned.length > 0) {
    const names = unowned.map(({ kind, name }) => `${kind} "${name}"`).join(', ');
    throw new PersistenceError(`Cannot save browser state without an active lease for ${names}`, {
      failures: unowned.map(({ kind, name }) => ({ target: kind, name })),
    });
  }

  return stateLease;
}

function attachLaunchCleanupFailures(error, cleanupFailures) {
  if (cleanupFailures.length === 0) return error;

  const cleanupError = new BrowserCleanupError('Browser launch rollback was incomplete', {
    cause: cleanupFailures[0].error,
    failures: cleanupFailures,
  });
  attachCleanupFailures(error, cleanupFailures);
  Object.defineProperty(error, 'cleanupError', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: cleanupError,
  });
  return error;
}

/**
 * Build proxy configuration
 */
function buildProxy(proxyStr) {
  if (!proxyStr) return null;

  try {
    return toPlaywrightProxy(proxyStr);
  } catch (cause) {
    throw new ProxyError(proxyStr, cause);
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
 * @param {boolean} [opts.restoreSessionUrl=true] - Navigate to the session's saved URL
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
    restoreSessionUrl = true,
  } = opts;

  const profileWasExplicit = profileName !== undefined && profileName !== null;
  const sessionWasExplicit = sessionName !== undefined && sessionName !== null;
  profileName = profileWasExplicit ? assertStateName(profileName, "Profile") : undefined;
  sessionName = sessionWasExplicit ? assertStateName(sessionName, "Session") : undefined;

  // A linked session carries its profile identity even when --profile is not
  // repeated. Re-read it after locking before trusting any mutable state.
  let sessionMetadata = sessionName
    ? validateStoredSession(getSession(sessionName), sessionName)
    : null;
  const preLockLinkedProfileName = sessionMetadata?.profile
    ? assertStateName(sessionMetadata.profile, "Profile")
    : null;
  if (!profileWasExplicit && preLockLinkedProfileName) {
    profileName = preLockLinkedProfileName;
  }

  const stateLease = acquireStateLocks({
    profile: profileName,
    session: sessionName,
  });
  let browser;
  let context;

  try {
    if (sessionName) {
      sessionMetadata = validateStoredSession(getSession(sessionName), sessionName);
      const linkedProfileName = sessionMetadata.profile
        ? assertStateName(sessionMetadata.profile, "Profile")
        : null;
      if (profileWasExplicit) {
        if (linkedProfileName && linkedProfileName !== profileName) {
          throw new ProfileError(
            `Session "${sessionName}" belongs to profile "${linkedProfileName}", not "${profileName}"`,
            { hint: 'Use the linked profile or choose a different --session name' },
          );
        }
      } else if (linkedProfileName !== preLockLinkedProfileName) {
        throw new ProfileError(
          `Session "${sessionName}" profile link changed while the browser was starting`,
          { hint: 'Retry the command after the session profile link is stable' },
        );
      }
    }

    let profileData = null;
    if (profileName) {
      profileData = validateStoredProfile(loadProfile(profileName), profileName);
      const fp = profileData.fingerprint;
      locale = fp.locale;
      timezone = fp.timezone;
      viewport = {
        width: fp.viewport.width,
        height: fp.viewport.height,
      };
      if (profileData.proxy && !proxyStr) proxyStr = profileData.proxy;
    }

    if (profileName) touchProfile(profileName, { lease: stateLease });
    if (proxyRotate && !proxyStr) proxyStr = getNextProxy();

    if (
      !forceDirect &&
      headless !== false &&
      !proxyStr &&
      !profileName &&
      !sessionName &&
      isDaemonRunning()
    ) {
      stateLease();
      return {
        browser: null,
        context: null,
        page: null,
        isDaemon: true,
        _meta: { profileName, sessionName },
      };
    }

    const hostOS = profileData?.fingerprint?.os || getHostOS();
    const proxy = buildProxy(proxyStr);
    try {
      browser = await createBrowser({
        headless,
        os: hostOS,
        proxy: proxy || undefined,
        handleSignals,
      });
    } catch (cause) {
      throw new BrowserLaunchError('Failed to launch browser', { cause });
    }

    const contextOptions = {
      viewport,
      permissions: ["geolocation"],
    };
    if (!proxy) {
      contextOptions.locale = locale;
      contextOptions.timezoneId = timezone;
      const profileGeo = profileData?.fingerprint?.geo;
      contextOptions.geolocation = profileGeo
        ? {
          latitude: profileGeo.latitude,
          longitude: profileGeo.longitude,
          ...(profileGeo.accuracy === undefined ? {} : { accuracy: profileGeo.accuracy }),
        }
        : {
          latitude: 37.7749,
          longitude: -122.4194,
        };
    }

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

    let sessionInfo = null;
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

    const page = await context.newPage();
    if (
      restoreSessionUrl &&
      sessionInfo?.lastUrl &&
      sessionInfo.lastUrl !== "about:blank"
    ) {
      try {
        await page.goto(sessionInfo.lastUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
      } catch {
        log.warn(
          `Session URL restore failed for ${safeUrlForDisplay(sessionInfo.lastUrl, 'saved session URL')}; continuing with a blank page`,
        );
      }
    }

    let pageUrl = null;
    try {
      pageUrl = page.url();
    } catch {}
    const lastKnownUrl = isNonBlankUrl(pageUrl)
      ? pageUrl
      : isNonBlankUrl(sessionInfo?.lastUrl) ? sessionInfo.lastUrl : pageUrl;

    const handle = {
      browser,
      context,
      page,
      isDaemon: false,
      _meta: {
        profileName,
        sessionName,
      },
    };
    trackLastKnownUrl(handle, lastKnownUrl);
    stateLeases.set(handle, stateLease);
    return handle;
  } catch (error) {
    let primaryError = error;
    if (!(error instanceof ProfileError || error instanceof BrowserLaunchError) && browser) {
      primaryError = new BrowserLaunchError('Browser initialization failed', {
        cause: error,
      });
    }

    const rollbackHandle = {
      browser,
      context,
      page: null,
      isDaemon: false,
      _meta: {},
    };
    stateLeases.set(rollbackHandle, stateLease);
    let cleanupFailures = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const cleanup = await closeBrowser(rollbackHandle, { persist: false });
        cleanupFailures = cleanup.cleanupErrors;
      } catch (cleanupError) {
        cleanupFailures = [{ target: 'rollback', error: cleanupError }];
      }
      if (cleanupFailures.length === 0) break;
    }

    const finalError = attachLaunchCleanupFailures(primaryError, cleanupFailures);
    if (cleanupFailures.length > 0) {
      launchRollbackHandles.set(finalError, rollbackHandle);
    }
    throw finalError;
  }
}

/**
 * Retry unfinished cleanup from a failed browser launch without exposing the
 * rollback handle or its private state lease.
 *
 * @param {BrowserLaunchError | ProfileError} error - The original launch error
 * @param {object} [opts]
 * @param {boolean} [opts.strict=false] - Throw when cleanup remains incomplete
 * @returns {Promise<{ persistence, persistenceError, cleanupErrors }>}
 */
export async function retryBrowserLaunchCleanup(error, opts = {}) {
  const rollbackHandle = launchRollbackHandles.get(error);
  if (!rollbackHandle) {
    throw new BrowserCleanupError(
      'No pending browser launch cleanup is available for this error',
      {
        hint: 'Pass the original launch error only while its rollback cleanup remains incomplete',
      },
    );
  }

  const { strict = false } = opts;
  const result = await closeBrowser(rollbackHandle, { persist: false, strict });
  if (result.cleanupErrors.length === 0) {
    launchRollbackHandles.delete(error);
  }
  return result;
}

/**
 * Capture browser state while the Playwright context is still connected.
 * Cookie values remain in-memory and are never included in log messages.
 *
 * @param {object} handle
 * @returns {Promise<{ cookies: Array<object>, lastUrl: string | null, capturedAt: string }>}
 */
export async function captureBrowserState(handle) {
  const { browser, context, page, isDaemon } = handle || {};

  if (isDaemon || !context) {
    throw new PersistenceError('Cannot capture state from a daemon browser');
  }
  if (typeof browser?.isConnected === 'function' && !browser.isConnected()) {
    throw new PersistenceError('Cannot capture state after the browser disconnected');
  }

  const trackedUrl = lastKnownUrls.get(handle);
  let lastUrl = isNonBlankUrl(trackedUrl) ? trackedUrl : null;
  if (!lastUrl) {
    let pages = [];
    try {
      pages = typeof context.pages === 'function' ? context.pages() : [];
    } catch {}
    const candidates = [page, ...pages.filter((candidate) => candidate !== page)].filter(Boolean);
    let blankFallback = trackedUrl || null;
    for (const candidate of candidates) {
      try {
        if (typeof candidate.isClosed === 'function' && candidate.isClosed()) continue;
        const candidateUrl = candidate.url();
        if (isNonBlankUrl(candidateUrl)) {
          lastUrl = candidateUrl;
          break;
        }
        if (!blankFallback && candidateUrl) blankFallback = candidateUrl;
      } catch {}
    }
    if (!lastUrl) lastUrl = blankFallback;
  }

  trackLastKnownUrl(handle, lastUrl);

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

  const stateLease = requireOwningStateLease(handle);

  if (profileName) {
    try {
      results.profile = {
        name: profileName,
        cookies: saveProfileCookies(profileName, snapshot.cookies, { lease: stateLease }),
      };
    } catch (error) {
      failures.push({ target: 'profile', name: profileName, error });
    }
  }

  if (sessionName) {
    try {
      const session = saveSessionSnapshot(sessionName, snapshot, {
        profile: profileName,
        lease: stateLease,
      });
      results.session = {
        name: sessionName,
        cookies: session.cookies.length,
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
 * Persist a live browser handle through its private state lease without
 * exposing that lease to SDK callers.
 *
 * WARNING: The returned result includes raw cookie values and the last URL in
 * its snapshot. Treat it as sensitive and do not log or expose it.
 */
export async function checkpointBrowserState(handle) {
  return persistBrowserState(handle);
}

function getCloseState(handle) {
  let state = closeStates.get(handle);
  if (!state) {
    state = {
      inFlight: null,
      persistenceAttempted: false,
      persistence: null,
      persistenceError: null,
      contextClosed: !handle.context,
      browserClosed: !handle.browser,
      stateLeaseReleased: !stateLeases.has(handle),
    };
    closeStates.set(handle, state);
  }
  return state;
}

function browserIsDisconnected(browser) {
  try {
    return typeof browser?.isConnected === 'function' && !browser.isConnected();
  } catch {
    return false;
  }
}

function canReleaseStateLease(handle, state) {
  return handle.browser ? state.browserClosed : state.contextClosed;
}

async function performCloseOperation(handle, state, persist) {
  const { browser, context } = handle;
  const cleanupErrors = [];
  let contextCleanupError = null;

  if (!state.persistenceAttempted) {
    state.persistenceAttempted = true;
    if (persist) {
      try {
        state.persistence = await persistBrowserState(handle);
      } catch (error) {
        state.persistenceError = error;
      }
    }
  }

  if (!state.contextClosed) {
    try {
      await context.close();
      state.contextClosed = true;
    } catch (error) {
      contextCleanupError = { target: 'context', error };
      cleanupErrors.push(contextCleanupError);
    }
  }

  if (!state.browserClosed) {
    try {
      await browser.close();
      state.browserClosed = true;
    } catch (error) {
      if (browserIsDisconnected(browser)) {
        state.browserClosed = true;
      } else {
        cleanupErrors.push({ target: 'browser', error });
      }
    }
  }

  if (browser && state.browserClosed) {
    state.contextClosed = true;
    if (contextCleanupError) {
      cleanupErrors.splice(cleanupErrors.indexOf(contextCleanupError), 1);
    }
  }

  if (
    !state.stateLeaseReleased &&
    canReleaseStateLease(handle, state)
  ) {
    try {
      await stateLeases.get(handle)();
      stateLeases.delete(handle);
      state.stateLeaseReleased = true;
    } catch (error) {
      cleanupErrors.push({ target: 'state-lock', error });
    }
  }

  if (state.contextClosed && state.browserClosed) lastKnownUrls.delete(handle);

  return {
    persistence: state.persistence,
    persistenceError: state.persistenceError,
    cleanupErrors,
  };
}

function createStrictClosePersistenceError(persistenceError, cleanupErrors) {
  const targets = cleanupErrors.map(({ target }) => target).join(', ');
  return new PersistenceError(
    `${persistenceError.message}; browser cleanup also failed (${targets})`,
    {
      cause: persistenceError,
      cleanupFailures: cleanupErrors,
      failures: persistenceError.failures,
      results: persistenceError.results,
      snapshotMetadata: persistenceError.snapshotMetadata,
    },
  );
}

/**
 * Safely close a browser, coalescing concurrent calls while allowing later
 * calls to retry resources whose cleanup did not complete.
 *
 * Persistence is best-effort by default for SDK compatibility and is attempted
 * at most once. Strict mode throws after cleanup when persistence or cleanup is
 * incomplete. A later call may retry unfinished resource/lease cleanup, but it
 * does not recapture or retry persistence.
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

  const state = getCloseState(handle);
  if (!state.inFlight) {
    const operation = performCloseOperation(handle, state, persist);
    state.inFlight = operation;
    operation.then(
      () => {
        if (state.inFlight === operation) state.inFlight = null;
      },
      () => {
        if (state.inFlight === operation) state.inFlight = null;
      },
    );
  }

  const result = await state.inFlight;
  if (strict && result.persistenceError) {
    if (result.cleanupErrors.length > 0) {
      throw createStrictClosePersistenceError(
        result.persistenceError,
        result.cleanupErrors,
      );
    }
    throw result.persistenceError;
  }
  if (strict && result.cleanupErrors.length > 0) {
    throw new BrowserCleanupError('Browser cleanup failed', {
      cause: result.cleanupErrors[0].error,
      failures: result.cleanupErrors,
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
      trackLastKnownUrl(handle, result);
      return result;
    }

    const finalUrl = await navigateWithRetry(handle.page, url, {
      timeout,
      waitUntil,
      maxRetries: retries,
      label: `navigate to ${safeUrlForDisplay(url)}`,
    });

    // Human behavior after navigation
    if (humanize) {
      await postNavigationBehavior(handle.page);
    }

    trackLastKnownUrl(handle, finalUrl);
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

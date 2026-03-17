/**
 * stealth-cli — Public API (SDK mode)
 */

// Core browser
export {
  launchBrowser, closeBrowser, navigate, getSnapshot,
  getTextContent, getTitle, getUrl, takeScreenshot, evaluate, waitForReady,
} from './browser.js';

// Search
export { expandMacro, getSupportedEngines } from './macros.js';
export { getExtractorByEngine, getExtractorByUrl } from './extractors/index.js';

// Cookies
export { parseCookieFile, loadCookies } from './cookies.js';

// Retry + Humanize
export { withRetry, navigateWithRetry } from './retry.js';
export {
  randomDelay, humanScroll, humanMouseMove,
  humanType, humanClick, warmup, postNavigationBehavior,
} from './humanize.js';

// Profile + Session + Proxy
export { createProfile, loadProfile, listProfiles, deleteProfile } from './profiles.js';
export { getSession, saveSession, captureSession, restoreSession, listSessions } from './session.js';
export { addProxy, removeProxy, listProxies, getNextProxy, getRandomProxy, testProxy } from './proxy-pool.js';

// Daemon
export { isDaemonRunning } from './daemon.js';
export { daemonStatus, daemonShutdown } from './client.js';

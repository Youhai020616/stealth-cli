/**
 * stealth-cli — Public API (SDK mode)
 */

// Core browser
export {
  launchBrowser,
  closeBrowser,
  navigate,
  getSnapshot,
  getA11ySnapshot,
  getTextContent,
  getTitle,
  getUrl,
  takeScreenshot,
  evaluate,
  waitForReady,
  clickRef,
  typeRef,
  hoverRef,
} from "./browser.js";

// Search
export { expandMacro, getSupportedEngines } from "./macros.js";
export { getExtractorByEngine, getExtractorByUrl } from "./extractors/index.js";

// Cookies
export { parseCookieFile, loadCookies } from "./cookies.js";

// Retry + Humanize
export { withRetry, navigateWithRetry } from "./retry.js";
export {
  randomDelay,
  humanScroll,
  humanMouseMove,
  humanType,
  humanClick,
  warmup,
  postNavigationBehavior,
} from "./humanize.js";

// Profile + Session + Proxy
export {
  createProfile,
  loadProfile,
  listProfiles,
  deleteProfile,
} from "./profiles.js";
export {
  getSession,
  saveSession,
  captureSession,
  restoreSession,
  listSessions,
} from "./session.js";
export {
  addProxy,
  removeProxy,
  listProxies,
  getNextProxy,
  getRandomProxy,
  testProxy,
} from "./proxy-pool.js";

// Accessibility tree with @ref targeting
export {
  buildA11yTree,
  clickByRef,
  typeByRef,
  hoverByRef,
  selectByRef,
  refSelector,
  INTERACTIVE_ROLES,
  STRUCTURAL_ROLES,
} from "./a11y.js";

// Daemon
export { isDaemonRunning } from "./daemon.js";
export { daemonStatus, daemonShutdown } from "./client.js";

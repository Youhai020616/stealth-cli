/**
 * Standardized error types with user-friendly messages and hints
 *
 * Exit codes:
 *   0  — success
 *   1  — general error
 *   2  — invalid arguments
 *   3  — browser launch failed
 *   4  — navigation failed
 *   5  — extraction failed
 *   6  — timeout
 *   7  — proxy error
 *   8  — profile/session error
 *   130 — interrupted (SIGINT)
 */

export function safeUrlForDisplay(value, fallback = 'requested URL') {
  try {
    const origin = new URL(value).origin;
    return origin && origin !== 'null' ? origin : fallback;
  } catch {
    return fallback;
  }
}

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const SAFE_CLEANUP_TARGETS = new Set([
  'browser',
  'context',
  'lifecycle',
  'persistence',
  'rollback',
  'state-lock',
]);

const DEFAULT_CLEANUP_HINTS = {
  browser: 'Ensure the browser process has exited before reusing its profile or session',
  context: 'Ensure the browser process has exited before reusing its profile or session',
  lifecycle: 'Ensure the browser process has exited before retrying the command',
  persistence: 'Do not assume authentication state was saved; retry while the browser is still available',
  rollback: 'Ensure the partially launched browser process has exited before retrying',
  'state-lock': 'Do not remove a state lock until you have confirmed that no stealth process owns it',
  'profile state lock': 'Do not remove a state lock until you have confirmed that no stealth process owns it',
  'session state lock': 'Do not remove a state lock until you have confirmed that no stealth process owns it',
  'browser resource': 'Ensure the browser process has exited before retrying',
};

function defineHidden(target, property, value) {
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}

function redactUrls(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/https?:\/\/[^\s]+/giu, (url) => safeUrlForDisplay(url));
}

function safeCleanupTarget(value) {
  if (typeof value !== 'string') return 'browser resource';
  const target = value.trim().toLowerCase();
  if (SAFE_CLEANUP_TARGETS.has(target)) return target;
  if (target === 'profile' || target.startsWith('profile:')) return 'profile state lock';
  if (target === 'session' || target.startsWith('session:')) return 'session state lock';
  return 'browser resource';
}

function findCleanupHint(value, seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const nestedHint = findCleanupHint(value.cleanupError, seen)
    || findCleanupHint(value.cause, seen);
  if (nestedHint) return nestedHint;

  if (value instanceof StealthError && typeof value.hint === 'string' && value.hint) {
    return redactUrls(value.hint);
  }
  return null;
}

function collectCleanupFailures(value, failures = [], seen = new Set()) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return failures;
  if (seen.has(value)) return failures;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === 'object' && 'target' in entry) failures.push(entry);
      collectCleanupFailures(entry?.error, failures, seen);
    }
    return failures;
  }

  collectCleanupFailures(value.cleanupFailures, failures, seen);
  collectCleanupFailures(value.cleanupErrors, failures, seen);
  collectCleanupFailures(value.cleanupError, failures, seen);
  collectCleanupFailures(value.cause, failures, seen);
  return failures;
}

export function getCleanupTargetSummaries(value) {
  const summaries = [];
  const seen = new Set();

  for (const failure of collectCleanupFailures(value)) {
    const target = safeCleanupTarget(failure.target);
    const hint = findCleanupHint(failure.error) || DEFAULT_CLEANUP_HINTS[target];
    const key = `${target}\u0000${hint || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(hint ? { target, hint } : { target });
  }

  return summaries;
}

export function formatCleanupFailures(value, prefix = 'Cleanup was incomplete') {
  const summaries = getCleanupTargetSummaries(value);
  if (summaries.length === 0) return null;

  const targets = summaries.map(({ target }) => target).join(', ');
  const hints = summaries
    .filter(({ hint }) => hint)
    .map(({ target, hint }) => `  Hint for ${target}: ${hint}`);
  return [`${prefix} (${targets})`, ...hints].join('\n');
}

export function attachCleanupFailures(error, failures) {
  if (!error || !Array.isArray(failures) || failures.length === 0) return error;
  const existing = Array.isArray(error.cleanupFailures) ? error.cleanupFailures : [];
  defineHidden(error, 'cleanupFailures', [...existing, ...failures]);
  return error;
}

export class StealthError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'StealthError';
    this.code = opts.code || 1;
    this.hint = opts.hint || null;
    defineHidden(this, 'cause', opts.cause || null);
  }

  format() {
    let msg = redactUrls(this.message);
    if (this.hint) msg += `\n  Hint: ${redactUrls(this.hint)}`;

    for (const { target, hint } of getCleanupTargetSummaries(this)) {
      msg += `\n  Cleanup incomplete: ${target}`;
      if (hint) msg += `\n    Hint: ${hint}`;
    }
    return msg;
  }

  toJSON() {
    const serialized = {
      message: redactUrls(this.message),
      code: this.code,
      hint: this.hint ? redactUrls(this.hint) : null,
    };
    const cleanupFailures = getCleanupTargetSummaries(this);
    if (cleanupFailures.length > 0) serialized.cleanupFailures = cleanupFailures;
    return serialized;
  }

  [INSPECT_CUSTOM]() {
    return { name: this.name, ...this.toJSON() };
  }
}

export class BrowserLaunchError extends StealthError {
  constructor(message, opts = {}) {
    super(message, { code: 3, ...opts });
    this.name = 'BrowserLaunchError';
    this.hint = opts.hint || 'Try: npx camoufox-js fetch (re-download browser)';
    defineHidden(this, 'cleanupFailures', []);
    attachCleanupFailures(this, opts.cleanupFailures || []);
    defineHidden(this, 'cleanupError', opts.cleanupError || null);
  }
}

export class BrowserCleanupError extends StealthError {
  constructor(message = 'Browser cleanup failed', opts = {}) {
    super(message, {
      code: 1,
      hint: opts.hint || 'Retry closing the browser before reusing its profile or session',
      ...opts,
    });
    this.name = 'BrowserCleanupError';
    const failures = opts.failures || [];
    defineHidden(this, 'failures', failures);
    defineHidden(this, 'cleanupFailures', []);
    attachCleanupFailures(this, failures);
  }
}

export class NavigationError extends StealthError {
  constructor(url, cause) {
    const msg = `Failed to navigate to ${safeUrlForDisplay(url)}`;
    let hint = 'Check the URL and your network connection';
    if (cause?.message?.toLowerCase().includes('timeout')) {
      hint = 'Page load timed out. Try --wait <ms> or --retries <n>';
    } else if (cause?.message?.includes('net::ERR_')) {
      hint = 'Network error. Check DNS, proxy, or firewall';
    }
    super(msg, { code: 4, hint, cause });
    this.name = 'NavigationError';
    defineHidden(this, 'url', url);
  }
}

export class ExtractionError extends StealthError {
  constructor(message, opts = {}) {
    super(message, { code: 5, ...opts });
    this.name = 'ExtractionError';
    this.hint = opts.hint || 'The page structure may have changed. Try -f snapshot to inspect';
  }
}

export class TimeoutError extends StealthError {
  constructor(operation, timeoutMs) {
    super(`${operation} timed out after ${timeoutMs}ms`, {
      code: 6,
      hint: 'Try increasing --wait or --retries',
    });
    this.name = 'TimeoutError';
  }
}

export class ProxyError extends StealthError {
  constructor(proxyUrl, cause) {
    super(`Proxy connection failed: ${safeUrlForDisplay(proxyUrl, 'configured proxy')}`, {
      code: 7,
      hint: 'Check proxy URL, credentials, and connectivity. Run: stealth proxy test',
      cause,
    });
    this.name = 'ProxyError';
  }
}

export class ProfileError extends StealthError {
  constructor(message, opts = {}) {
    super(message, { code: 8, ...opts });
    this.name = 'ProfileError';
    this.hint = opts.hint || 'Run: stealth profile list';
  }
}

export class PersistenceError extends StealthError {
  constructor(message, opts = {}) {
    super(message, {
      code: 8,
      hint: opts.hint || 'Authentication state was not fully saved; keep the browser open and retry',
      ...opts,
    });
    this.name = 'PersistenceError';
    defineHidden(this, 'results', opts.results || null);
    defineHidden(this, 'failures', opts.failures || []);
    defineHidden(this, 'snapshotMetadata', opts.snapshotMetadata || null);
    defineHidden(this, 'cleanupFailures', []);
    attachCleanupFailures(this, opts.cleanupFailures || []);
  }
}

export class BlockedError extends StealthError {
  constructor(engine, url) {
    super(`${engine} detected automation and blocked the request`, {
      code: 4,
      hint: 'Try: --proxy <proxy>, --warmup, --humanize, or use a different engine',
    });
    this.name = 'BlockedError';
    defineHidden(this, 'url', url);
  }
}

/**
 * Format and print error with hint, then exit
 *
 * @param {Error} err - The error to handle
 * @param {object} [opts]
 * @param {object} [opts.log] - Logger (default: console with stderr)
 * @param {boolean} [opts.exit=true] - Whether to call process.exit
 */
export function handleError(err, opts = {}) {
  const { exit = true } = opts;

  // Use provided log or fallback to stderr console
  const log = opts.log || {
    error: (msg) => console.error(`\x1b[31m✖\x1b[0m ${msg}`),
    dim: (msg) => console.error(`\x1b[2m${msg}\x1b[0m`),
  };

  if (err instanceof StealthError) {
    log.error(redactUrls(err.message));
    if (err.hint) log.dim(`  Hint: ${redactUrls(err.hint)}`);
    for (const { target, hint } of getCleanupTargetSummaries(err)) {
      log.dim(`  Cleanup incomplete: ${target}`);
      if (hint) log.dim(`    Hint: ${hint}`);
    }
    if (exit) process.exit(err.code);
    return err.code;
  }

  // Unknown error — detect common patterns and add helpful hints
  log.error(redactUrls(err.message || String(err)));

  const msg = err.message || '';
  if (msg.includes('ECONNREFUSED')) {
    log.dim('  Hint: Connection refused. Is the target server running?');
  } else if (msg.includes('ENOTFOUND')) {
    log.dim('  Hint: DNS lookup failed. Check the URL');
  } else if (msg.includes('camoufox')) {
    log.dim('  Hint: Try: npx camoufox-js fetch');
  } else if (msg.includes('timeout') || msg.includes('Timeout')) {
    log.dim('  Hint: Try increasing --retries or --wait');
  }

  for (const { target, hint } of getCleanupTargetSummaries(err)) {
    log.dim(`  Cleanup incomplete: ${target}`);
    if (hint) log.dim(`    Hint: ${hint}`);
  }

  if (exit) process.exit(1);
  return 1;
}

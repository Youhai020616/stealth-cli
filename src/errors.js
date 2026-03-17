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

export class StealthError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'StealthError';
    this.code = opts.code || 1;
    this.hint = opts.hint || null;
    this.cause = opts.cause || null;
  }

  format() {
    let msg = this.message;
    if (this.hint) msg += `\n  Hint: ${this.hint}`;
    return msg;
  }
}

export class BrowserLaunchError extends StealthError {
  constructor(message, opts = {}) {
    super(message, { code: 3, ...opts });
    this.name = 'BrowserLaunchError';
    this.hint = opts.hint || 'Try: npx camoufox-js fetch (re-download browser)';
  }
}

export class NavigationError extends StealthError {
  constructor(url, cause) {
    const msg = `Failed to navigate to ${url}`;
    let hint = 'Check the URL and your network connection';
    if (cause?.message?.includes('timeout')) {
      hint = 'Page load timed out. Try --wait <ms> or --retries <n>';
    } else if (cause?.message?.includes('net::ERR_')) {
      hint = 'Network error. Check DNS, proxy, or firewall';
    }
    super(msg, { code: 4, hint, cause });
    this.name = 'NavigationError';
    this.url = url;
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
    super(`Proxy connection failed: ${proxyUrl}`, {
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

export class BlockedError extends StealthError {
  constructor(engine, url) {
    super(`${engine} detected automation and blocked the request`, {
      code: 4,
      hint: 'Try: --proxy <proxy>, --warmup, --humanize, or use a different engine',
    });
    this.name = 'BlockedError';
    this.url = url;
  }
}

/**
 * Format and print error with hint, then exit
 */
export function handleError(err) {
  const { log } = loadOutput();

  if (err instanceof StealthError) {
    log.error(err.message);
    if (err.hint) log.dim(`  Hint: ${err.hint}`);
    process.exit(err.code);
  }

  // Unknown error
  log.error(err.message || String(err));

  // Common error patterns → helpful hints
  const msg = err.message || '';
  if (msg.includes('ECONNREFUSED')) {
    log.dim('  Hint: Connection refused. Is the target server running?');
  } else if (msg.includes('ENOTFOUND')) {
    log.dim('  Hint: DNS lookup failed. Check the URL');
  } else if (msg.includes('camoufox')) {
    log.dim('  Hint: Try: npx camoufox-js fetch');
  }

  process.exit(1);
}

// Lazy import to avoid circular dependency
function loadOutput() {
  // Use dynamic require-like pattern
  return { log: console };
}

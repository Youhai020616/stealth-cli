const PROXY_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;
const INVALID_PROXY_DISPLAY = 'invalid proxy';

function invalidProxyError() {
  return new TypeError('Invalid proxy URL format');
}

function decodeProxyCredential(value) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidProxyError();
  }
}

/**
 * Parse and validate an HTTP(S) proxy URL.
 *
 * Bare host[:port] values default to http://. Proxy URLs must address the
 * origin root and cannot contain query parameters or fragments.
 *
 * @param {unknown} value
 * @returns {URL}
 */
export function parseProxyUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidProxyError();
  }

  const candidate = PROXY_SCHEME_PATTERN.test(value)
    ? value
    : `http://${value}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw invalidProxyError();
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !parsed.hostname
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw invalidProxyError();
  }
  decodeProxyCredential(parsed.username);
  decodeProxyCredential(parsed.password);

  return parsed;
}

/**
 * Convert a proxy URL to Playwright's proxy launch option.
 *
 * @param {unknown} value
 * @returns {{server: string, username: string|undefined, password: string|undefined}}
 */
export function toPlaywrightProxy(value) {
  const parsed = parseProxyUrl(value);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    username: decodeProxyCredential(parsed.username),
    password: decodeProxyCredential(parsed.password),
  };
}

/**
 * Validate an HTTP(S) proxy URL without exposing parsing details.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidProxyUrl(value) {
  try {
    parseProxyUrl(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Produce a normalized proxy URL safe for logs and terminal output.
 * Invalid values are never echoed because they may contain credentials that
 * could not be parsed reliably.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function maskProxyUrl(value) {
  try {
    const parsed = parseProxyUrl(value);
    if (parsed.username || parsed.password) {
      parsed.username = '****';
      parsed.password = '';
    }
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return INVALID_PROXY_DISPLAY;
  }
}

/**
 * Cookie file parser - supports Netscape cookie format
 * Inspired by camofox-browser (MIT License)
 */

import { readFileSync } from 'fs';

/**
 * Parse a Netscape-format cookie file
 *
 * Format: domain\tincludeSubdomains\tpath\tsecure\texpires\tname\tvalue
 *
 * @param {string} filePath - Path to cookie file
 * @param {string} [filterDomain] - Only return cookies matching this domain
 * @returns {Array} Playwright-format cookies
 */
export function parseCookieFile(filePath, filterDomain) {
  const content = readFileSync(filePath, 'utf-8');
  const cookies = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    const [domain, , path, secure, expires, name, value] = parts;

    // Filter by domain if specified
    if (filterDomain) {
      const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain;
      if (!filterDomain.includes(cleanDomain) && !cleanDomain.includes(filterDomain)) {
        continue;
      }
    }

    cookies.push({
      name,
      value,
      domain,
      path: path || '/',
      expires: parseInt(expires) || -1,
      httpOnly: false,
      secure: secure.toLowerCase() === 'true',
      sameSite: 'Lax',
    });
  }

  return cookies;
}

/**
 * Load cookies from file and inject into browser context
 */
export async function loadCookies(context, filePath, filterDomain) {
  const cookies = parseCookieFile(filePath, filterDomain);

  if (cookies.length === 0) {
    return { count: 0, message: 'No cookies found' };
  }

  await context.addCookies(cookies);
  return { count: cookies.length, message: `Loaded ${cookies.length} cookies` };
}

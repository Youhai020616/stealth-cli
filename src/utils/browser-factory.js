/**
 * Shared browser bootstrap utilities
 * Eliminates duplication across browser.js, daemon.js, serve.js, mcp-server.js
 */

import os from 'os';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';

/**
 * Detect host OS for Camoufox fingerprint matching
 */
export function getHostOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * Launch a Camoufox browser instance with standard settings
 *
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string} [opts.os] - Override OS (default: auto-detect)
 * @param {object} [opts.proxy] - { server, username?, password? }
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function createBrowser(opts = {}) {
  const {
    headless = true,
    os: targetOS,
    proxy,
  } = opts;

  const options = await launchOptions({
    headless,
    os: targetOS || getHostOS(),
    // Camoufox's `humanize` controls low-level fingerprint randomization (canvas noise, etc.)
    // This is NOT the same as stealth-cli's --humanize flag (which controls mouse/scroll/type simulation).
    // Always enabled for anti-detection effectiveness.
    humanize: true,
    enable_cache: true,
    proxy: proxy || undefined,
    geoip: !!proxy,
  });

  return firefox.launch(options);
}

/**
 * Create a standard browser context
 *
 * @param {import('playwright-core').Browser} browser
 * @param {object} opts
 * @returns {Promise<import('playwright-core').BrowserContext>}
 */
export async function createContext(browser, opts = {}) {
  const {
    locale = 'en-US',
    timezone = 'America/Los_Angeles',
    viewport = { width: 1280, height: 720 },
    geo = { latitude: 37.7749, longitude: -122.4194 },
  } = opts;

  return browser.newContext({
    viewport,
    locale,
    timezoneId: timezone,
    permissions: ['geolocation'],
    geolocation: geo,
  });
}

/**
 * Extract visible text from a page.
 * Pass directly to page.evaluate() — must not reference Node.js scope.
 * Using a function (not a string) avoids eval-injection risks.
 */
export function extractPageText() {
  const body = document.body;
  if (!body) return '';
  const clone = body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  return clone.innerText || clone.textContent || '';
}

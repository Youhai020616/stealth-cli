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
 * JavaScript snippet to extract visible text from a page.
 * Evaluate this in page.evaluate() — cannot reference Node.js scope.
 */
export const TEXT_EXTRACT_SCRIPT = `
(() => {
  const body = document.body;
  if (!body) return '';
  const clone = body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  return clone.innerText || clone.textContent || '';
})()
`;

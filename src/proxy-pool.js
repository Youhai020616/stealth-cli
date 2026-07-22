/**
 * Proxy pool management — store, test, and rotate proxies
 *
 * Storage: ~/.stealth/proxies.json
 */

import path from 'path';
import os from 'os';
import { ProxyError } from './errors.js';
import {
  ensurePrivateDirectory,
  readPrivateFile,
  writeJsonAtomic,
} from './utils/json-file.js';
import {
  isValidProxyUrl,
  maskProxyUrl,
  parseProxyUrl,
  toPlaywrightProxy,
} from './utils/proxy.js';

const STEALTH_DIR = path.join(os.homedir(), '.stealth');
const PROXIES_FILE = path.join(STEALTH_DIR, 'proxies.json');

function invalidProxyPool(cause) {
  return new ProxyError(null, cause, {
    message: 'Proxy pool has an invalid format',
    hint: `Fix or remove the proxy pool file: ${PROXIES_FILE}`,
  });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isValidProxyRecord(proxy) {
  return Boolean(
    isPlainObject(proxy)
    && isValidProxyUrl(proxy.url)
    && (proxy.label === null || typeof proxy.label === 'string')
    && (proxy.region === null || typeof proxy.region === 'string')
    && typeof proxy.addedAt === 'string'
    && (proxy.lastUsed === null || typeof proxy.lastUsed === 'string')
    && Number.isInteger(proxy.useCount)
    && proxy.useCount >= 0
    && (proxy.lastStatus === null || proxy.lastStatus === 'ok' || proxy.lastStatus === 'fail')
    && (proxy.lastLatency === null || (Number.isFinite(proxy.lastLatency) && proxy.lastLatency >= 0))
    && Number.isInteger(proxy.failCount)
    && proxy.failCount >= 0
  );
}

function validateProxyPool(data) {
  if (
    !isPlainObject(data)
    || !Array.isArray(data.proxies)
    || !data.proxies.every(isValidProxyRecord)
    || !Number.isInteger(data.lastRotateIndex)
    || data.lastRotateIndex < 0
  ) {
    throw invalidProxyPool(new Error('Invalid persisted proxy pool data'));
  }
  return data;
}

function ensureDir() {
  ensurePrivateDirectory(STEALTH_DIR);
}

function loadData() {
  ensureDir();
  let contents;
  try {
    contents = readPrivateFile(PROXIES_FILE, { encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') return { proxies: [], lastRotateIndex: 0 };
    throw error;
  }

  let data;
  try {
    data = JSON.parse(contents);
  } catch (cause) {
    throw invalidProxyPool(cause);
  }
  return validateProxyPool(data);
}

function saveData(data) {
  ensureDir();
  writeJsonAtomic(PROXIES_FILE, validateProxyPool(data));
}

/**
 * Add a proxy to the pool
 *
 * @param {string} proxyUrl - Proxy URL (http://user:pass@host:port)
 * @param {object} opts
 * @param {string} [opts.label] - Label/name for this proxy
 * @param {string} [opts.region] - Geographic region
 */
export function addProxy(proxyUrl, opts = {}) {
  try {
    parseProxyUrl(proxyUrl);
  } catch (cause) {
    throw new ProxyError(proxyUrl, cause);
  }

  const data = loadData();

  // Check for duplicates
  if (data.proxies.some((p) => p.url === proxyUrl)) {
    throw new ProxyError(proxyUrl, new Error('Duplicate proxy'), {
      message: 'Proxy already exists in pool',
      hint: 'Remove the existing proxy before adding the same URL again',
    });
  }

  data.proxies.push({
    url: proxyUrl,
    label: opts.label || null,
    region: opts.region || null,
    addedAt: new Date().toISOString(),
    lastUsed: null,
    useCount: 0,
    lastStatus: null, // 'ok' | 'fail' | null
    lastLatency: null, // ms
    failCount: 0,
  });

  saveData(data);
  return data.proxies.length;
}

/**
 * Remove a proxy from the pool
 */
export function removeProxy(proxyUrl) {
  const data = loadData();
  const idx = data.proxies.findIndex((p) => p.url === proxyUrl || p.label === proxyUrl);
  if (idx === -1) {
    throw new ProxyError(proxyUrl, new Error('Proxy not found'), {
      message: 'Proxy not found in pool',
      hint: 'Run: stealth proxy list',
    });
  }
  data.proxies.splice(idx, 1);
  saveData(data);
}

/**
 * List all proxies
 */
export function listProxies() {
  const data = loadData();
  return data.proxies.map((p) => ({
    url: maskProxyUrl(p.url),
    label: p.label || '-',
    region: p.region || '-',
    status: p.lastStatus || 'unknown',
    latency: p.lastLatency ? `${p.lastLatency}ms` : '-',
    useCount: p.useCount,
    failCount: p.failCount,
    lastUsed: p.lastUsed || 'never',
  }));
}

/**
 * Get the next proxy (round-robin rotation)
 */
export function getNextProxy() {
  const data = loadData();

  if (data.proxies.length === 0) return null;

  // Filter out proxies with too many consecutive failures
  const available = data.proxies.filter((p) => p.failCount < 5);
  if (available.length === 0) {
    // Reset all fail counts and try again
    data.proxies.forEach((p) => { p.failCount = 0; });
    saveData(data);
    return data.proxies[0]?.url || null;
  }

  // Round-robin
  const idx = data.lastRotateIndex % available.length;
  const proxy = available[idx];

  // Update stats
  proxy.lastUsed = new Date().toISOString();
  proxy.useCount += 1;
  data.lastRotateIndex = idx + 1;

  saveData(data);
  return proxy.url;
}

/**
 * Get a random proxy from the pool
 */
export function getRandomProxy() {
  const data = loadData();
  const available = data.proxies.filter((p) => p.failCount < 5);
  if (available.length === 0) return null;

  const proxy = available[Math.floor(Math.random() * available.length)];
  proxy.lastUsed = new Date().toISOString();
  proxy.useCount += 1;
  saveData(data);

  return proxy.url;
}

/**
 * Report proxy success/failure (updates stats)
 */
export function reportProxy(proxyUrl, success, latencyMs = null) {
  const data = loadData();
  const proxy = data.proxies.find((p) => p.url === proxyUrl);
  if (!proxy) return;

  if (success) {
    proxy.lastStatus = 'ok';
    proxy.failCount = 0;
    proxy.lastLatency = latencyMs;
  } else {
    proxy.lastStatus = 'fail';
    proxy.failCount += 1;
  }

  saveData(data);
}

/**
 * Test a proxy by making a request
 */
export async function testProxy(proxyUrl) {
  const { createBrowser } = await import('./utils/browser-factory.js');

  const start = Date.now();
  let browser;

  try {
    let proxyConfig;
    try {
      proxyConfig = toPlaywrightProxy(proxyUrl);
    } catch (cause) {
      throw new ProxyError(proxyUrl, cause);
    }

    browser = await createBrowser({ headless: true, proxy: proxyConfig });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Test with a fast, reliable site
    await page.goto('https://httpbin.org/ip', { timeout: 15000 });
    const body = await page.textContent('body');
    const ip = JSON.parse(body)?.origin || 'unknown';

    const latency = Date.now() - start;

    await context.close();
    await browser.close();

    reportProxy(proxyUrl, true, latency);

    return {
      ok: true,
      ip,
      latency,
      proxy: maskProxyUrl(proxyUrl),
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    reportProxy(proxyUrl, false);
    const publicError = err instanceof ProxyError
      ? err
      : new ProxyError(proxyUrl, err);

    return {
      ok: false,
      error: publicError.message,
      latency: Date.now() - start,
      proxy: maskProxyUrl(proxyUrl),
    };
  }
}

/**
 * Test all proxies in pool
 */
export async function testAllProxies() {
  const data = loadData();
  const results = [];

  for (const proxy of data.proxies) {
    const result = await testProxy(proxy.url);
    results.push(result);
  }

  return results;
}

/**
 * Get pool size
 */
export function poolSize() {
  return loadData().proxies.length;
}

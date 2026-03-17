/**
 * Proxy pool management — store, test, and rotate proxies
 *
 * Storage: ~/.stealth/proxies.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const STEALTH_DIR = path.join(os.homedir(), '.stealth');
const PROXIES_FILE = path.join(STEALTH_DIR, 'proxies.json');

function ensureDir() {
  fs.mkdirSync(STEALTH_DIR, { recursive: true });
}

function loadData() {
  ensureDir();
  if (!fs.existsSync(PROXIES_FILE)) {
    return { proxies: [], lastRotateIndex: 0 };
  }
  return JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8'));
}

function saveData(data) {
  ensureDir();
  // Atomic write: write to temp file then rename (prevents corruption on crash)
  const tmpPath = PROXIES_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, PROXIES_FILE);
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
  const data = loadData();

  // Check for duplicates
  if (data.proxies.some((p) => p.url === proxyUrl)) {
    throw new Error('Proxy already exists in pool');
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
  if (idx === -1) throw new Error('Proxy not found');
  data.proxies.splice(idx, 1);
  saveData(data);
}

/**
 * List all proxies
 */
export function listProxies() {
  const data = loadData();
  return data.proxies.map((p) => ({
    url: maskPassword(p.url),
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
    // Parse proxy URL
    let proxyConfig;
    try {
      const url = new URL(proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`);
      proxyConfig = {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        username: url.username || undefined,
        password: url.password || undefined,
      };
    } catch {
      throw new Error(`Invalid proxy URL: ${proxyUrl}`);
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
      proxy: maskPassword(proxyUrl),
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    reportProxy(proxyUrl, false);

    return {
      ok: false,
      error: err.message,
      latency: Date.now() - start,
      proxy: maskPassword(proxyUrl),
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

/**
 * Mask password in proxy URL for display
 */
function maskPassword(url) {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `http://${url}`);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

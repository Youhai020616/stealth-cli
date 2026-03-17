/**
 * Daemon client — communicates with background daemon via unix socket
 *
 * Usage:
 *   if (await daemonRequest('/status')) { ... } // daemon is running
 *   const result = await daemonNavigate('https://example.com');
 */

import http from 'http';
import { SOCKET_PATH, isDaemonRunning } from './daemon.js';

/**
 * Send a request to the daemon
 *
 * @param {string} route - Route path (e.g. '/navigate')
 * @param {object} body - Request body
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<object|null>} Response data, or null if daemon not available
 */
export async function daemonRequest(route, body = {}, timeout = 35000) {
  if (!isDaemonRunning()) return null;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);

    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: route,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Navigate via daemon (returns null if daemon not available)
 */
export async function daemonNavigate(url, opts = {}) {
  return daemonRequest('/navigate', { url, ...opts });
}

/**
 * Get page snapshot via daemon
 */
export async function daemonSnapshot(opts = {}) {
  return daemonRequest('/snapshot', opts);
}

/**
 * Get page text via daemon
 */
export async function daemonText(opts = {}) {
  return daemonRequest('/text', opts);
}

/**
 * Take screenshot via daemon (returns base64)
 */
export async function daemonScreenshot(opts = {}) {
  return daemonRequest('/screenshot', opts);
}

/**
 * Get page title via daemon
 */
export async function daemonTitle(opts = {}) {
  return daemonRequest('/title', opts);
}

/**
 * Evaluate JS via daemon
 */
export async function daemonEvaluate(expression, opts = {}) {
  return daemonRequest('/evaluate', { expression, ...opts });
}

/**
 * Check daemon status
 */
export async function daemonStatus() {
  return daemonRequest('/status');
}

/**
 * Shutdown daemon
 */
export async function daemonShutdown() {
  return daemonRequest('/shutdown');
}

/**
 * Daemon mode — keeps browser alive in background for instant reuse
 *
 * Architecture:
 *   1. `stealth daemon start` spawns a background HTTP server on a unix socket
 *   2. CLI commands detect the daemon and send requests via HTTP
 *   3. Daemon auto-shuts down after idle timeout (default 5 min)
 *
 * Socket: ~/.stealth/daemon.sock
 * PID:    ~/.stealth/daemon.pid
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createBrowser, createContext, TEXT_EXTRACT_SCRIPT } from './utils/browser-factory.js';

const STEALTH_DIR = path.join(os.homedir(), '.stealth');
const SOCKET_PATH = path.join(STEALTH_DIR, 'daemon.sock');
const PID_PATH = path.join(STEALTH_DIR, 'daemon.pid');
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export { SOCKET_PATH, PID_PATH, STEALTH_DIR };

/**
 * Check if daemon is currently running
 */
export function isDaemonRunning() {
  try {
    if (!fs.existsSync(PID_PATH)) return false;
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim());
    // Check if process is alive
    process.kill(pid, 0);
    // Also check if socket exists
    return fs.existsSync(SOCKET_PATH);
  } catch {
    // Process not found or permission error
    cleanup();
    return false;
  }
}

/**
 * Clean up stale socket/pid files
 */
function cleanup() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  try { fs.unlinkSync(PID_PATH); } catch {}
}

/**
 * Start the daemon server
 */
export async function startDaemon(opts = {}) {
  const { idleTimeout = DEFAULT_IDLE_TIMEOUT, verbose = false } = opts;

  // Ensure directory exists
  fs.mkdirSync(STEALTH_DIR, { recursive: true });

  // Clean up stale files
  cleanup();

  const log = (msg) => {
    if (verbose) {
      const ts = new Date().toISOString();
      process.stdout.write(`[${ts}] ${msg}\n`);
    }
  };

  // Launch browser
  log('Launching Camoufox browser...');
  const browser = await createBrowser({ headless: true });
  log('Browser launched');

  // Track contexts for reuse
  // key → { context, page, lastUsed }
  const contexts = new Map();
  let idleTimer = null;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      log('Idle timeout reached, shutting down...');
      await shutdown();
    }, idleTimeout);
  }

  async function getOrCreateContext(key = 'default', contextOpts = {}) {
    resetIdleTimer();

    if (contexts.has(key)) {
      const ctx = contexts.get(key);
      ctx.lastUsed = Date.now();

      // Check if page is still alive
      try {
        await ctx.page.evaluate('1');
        return ctx;
      } catch {
        // Page died, recreate
        try { await ctx.context.close(); } catch {}
        contexts.delete(key);
      }
    }

    const context = await createContext(browser, contextOpts);

    const page = await context.newPage();
    const entry = { context, page, lastUsed: Date.now() };
    contexts.set(key, entry);

    return entry;
  }

  // Handle JSON request body
  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  // HTTP server on unix socket
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    try {
      const body = await parseBody(req);
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname;

      resetIdleTimer();

      // --- Routes ---

      if (route === '/status') {
        res.end(JSON.stringify({
          ok: true,
          pid: process.pid,
          uptime: Math.floor(process.uptime()),
          contexts: contexts.size,
          browserConnected: browser.isConnected(),
          memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        }));
        return;
      }

      if (route === '/navigate') {
        const { key = 'default', url: targetUrl, waitUntil = 'domcontentloaded', timeout = 30000 } = body;
        const ctx = await getOrCreateContext(key);
        await ctx.page.goto(targetUrl, { waitUntil, timeout });
        res.end(JSON.stringify({ ok: true, url: ctx.page.url() }));
        return;
      }

      if (route === '/snapshot') {
        const { key = 'default' } = body;
        const ctx = await getOrCreateContext(key);
        const snapshot = await ctx.page.locator('body').ariaSnapshot({ timeout: 8000 }).catch(() => '');
        res.end(JSON.stringify({ ok: true, snapshot, url: ctx.page.url() }));
        return;
      }

      if (route === '/text') {
        const { key = 'default' } = body;
        const ctx = await getOrCreateContext(key);
        const text = await ctx.page.evaluate(TEXT_EXTRACT_SCRIPT);
        res.end(JSON.stringify({ ok: true, text, url: ctx.page.url() }));
        return;
      }

      if (route === '/screenshot') {
        const { key = 'default', fullPage = false } = body;
        const ctx = await getOrCreateContext(key);
        const buffer = await ctx.page.screenshot({ type: 'png', fullPage });
        res.end(JSON.stringify({ ok: true, data: buffer.toString('base64'), url: ctx.page.url() }));
        return;
      }

      if (route === '/evaluate') {
        const { key = 'default', expression } = body;
        const ctx = await getOrCreateContext(key);
        const result = await ctx.page.evaluate(expression);
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      if (route === '/title') {
        const { key = 'default' } = body;
        const ctx = await getOrCreateContext(key);
        const title = await ctx.page.title();
        res.end(JSON.stringify({ ok: true, title, url: ctx.page.url() }));
        return;
      }

      if (route === '/close') {
        const { key } = body;
        if (key && contexts.has(key)) {
          const ctx = contexts.get(key);
          await ctx.context.close().catch(() => {});
          contexts.delete(key);
        }
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (route === '/shutdown') {
        res.end(JSON.stringify({ ok: true, message: 'Shutting down' }));
        setTimeout(() => shutdown(), 100);
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  async function shutdown() {
    log('Shutting down daemon...');
    for (const [, ctx] of contexts) {
      await ctx.context.close().catch(() => {});
    }
    contexts.clear();
    await browser.close().catch(() => {});
    server.close();
    cleanup();
    log('Daemon stopped');
    process.exit(0);
  }

  // Handle signals
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Listen on unix socket
  server.listen(SOCKET_PATH, () => {
    // Write PID file
    fs.writeFileSync(PID_PATH, String(process.pid));
    log(`Daemon started (pid: ${process.pid}, socket: ${SOCKET_PATH})`);
    log(`Idle timeout: ${idleTimeout / 1000}s`);
    resetIdleTimer();
  });

  server.on('error', (err) => {
    console.error(`Daemon error: ${err.message}`);
    cleanup();
    process.exit(1);
  });
}

/**
 * Session management — persist and restore browsing sessions
 *
 * A session saves:
 *   - Cookies
 *   - Browsing history (visited URLs)
 *   - Last active URL
 *   - Profile reference
 *
 * Storage: ~/.stealth/sessions/<name>.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSIONS_DIR = path.join(os.homedir(), '.stealth', 'sessions');

function ensureDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(name) {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(SESSIONS_DIR, `${safeName}.json`);
}

/**
 * Create or load a session
 */
export function getSession(name) {
  ensureDir();
  const filePath = sessionPath(name);

  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  return {
    name,
    profile: null,
    cookies: [],
    history: [],
    lastUrl: null,
    createdAt: new Date().toISOString(),
    lastAccess: null,
  };
}

/**
 * Save session state
 */
export function saveSession(name, session) {
  ensureDir();
  const filePath = sessionPath(name);
  session.lastAccess = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
}

/**
 * Save current browser state to session
 */
export async function captureSession(name, context, page, opts = {}) {
  const session = getSession(name);

  // Save cookies
  try {
    session.cookies = await context.cookies();
  } catch { /* context may be closed */ }

  // Save current URL
  try {
    session.lastUrl = page.url();
  } catch { /* page may be closed */ }

  // Append to history
  if (session.lastUrl && session.lastUrl !== 'about:blank') {
    if (!session.history.includes(session.lastUrl)) {
      session.history.push(session.lastUrl);
    }
    // Keep history manageable
    if (session.history.length > 100) {
      session.history = session.history.slice(-100);
    }
  }

  // Link profile if provided
  if (opts.profile) {
    session.profile = opts.profile;
  }

  saveSession(name, session);
  return session;
}

/**
 * Restore session into browser context
 * Returns the last URL to navigate to
 */
export async function restoreSession(name, context) {
  const session = getSession(name);

  // Restore cookies
  if (session.cookies && session.cookies.length > 0) {
    try {
      // Filter expired cookies
      const now = Date.now() / 1000;
      const validCookies = session.cookies.filter((c) => {
        if (c.expires && c.expires > 0 && c.expires < now) return false;
        return true;
      });

      if (validCookies.length > 0) {
        await context.addCookies(validCookies);
      }
    } catch { /* cookies may have invalid format */ }
  }

  return {
    lastUrl: session.lastUrl,
    history: session.history,
    cookiesRestored: session.cookies?.length || 0,
    profile: session.profile,
  };
}

/**
 * List all sessions
 */
export function listSessions() {
  ensureDir();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));

  return files.map((f) => {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
      return {
        name: session.name,
        lastUrl: session.lastUrl || '-',
        cookies: session.cookies?.length || 0,
        history: session.history?.length || 0,
        profile: session.profile || '-',
        lastAccess: session.lastAccess || 'never',
      };
    } catch {
      return { name: f.replace('.json', ''), error: 'corrupted' };
    }
  });
}

/**
 * Delete a session
 */
export function deleteSession(name) {
  const filePath = sessionPath(name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

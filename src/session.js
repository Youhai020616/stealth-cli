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
import { ProfileError } from './errors.js';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  writeJsonAtomic,
} from './utils/json-file.js';
import { assertStateName, getSessionsDir } from './utils/storage-paths.js';

function ensureDir() {
  const directory = getSessionsDir();
  try {
    ensurePrivateDirectory(directory);
  } catch (cause) {
    throw new ProfileError('Browser session storage is not private', {
      hint: `Fix permissions for: ${directory}`,
      cause,
    });
  }
  return directory;
}

function sessionPath(name) {
  return path.join(getSessionsDir(), `${assertStateName(name, 'Session')}.json`);
}

/**
 * Create or load a session
 */
export function getSession(name) {
  ensureDir();
  const filePath = sessionPath(name);

  if (fs.existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      throw new ProfileError(`Session "${name}" is corrupted`, {
        hint: 'Use a new --session name or remove the corrupted session file',
        cause: error,
      });
    }
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
  writeJsonAtomic(filePath, session);
}

/**
 * Persist an already-captured browser snapshot to a named session.
 *
 * @param {string} name
 * @param {{ cookies: Array<object>, lastUrl?: string | null }} snapshot
 * @param {object} [opts]
 * @param {string} [opts.profile]
 */
export function saveSessionSnapshot(name, snapshot, opts = {}) {
  const filePath = sessionPath(name);
  const existed = fs.existsSync(filePath);
  const session = getSession(name);
  const before = JSON.stringify({
    cookies: session.cookies,
    history: session.history,
    lastUrl: session.lastUrl,
    profile: session.profile,
  });

  if (!Array.isArray(snapshot.cookies)) {
    throw new ProfileError(`Cannot save session "${name}": invalid cookie snapshot`);
  }
  session.cookies = snapshot.cookies;

  if (Object.hasOwn(snapshot, 'lastUrl') && snapshot.lastUrl !== undefined) {
    session.lastUrl = snapshot.lastUrl;
  }

  if (session.lastUrl && session.lastUrl !== 'about:blank') {
    if (!session.history.includes(session.lastUrl)) {
      session.history.push(session.lastUrl);
    }
    if (session.history.length > 100) {
      session.history = session.history.slice(-100);
    }
  }

  if (opts.profile) {
    if (session.profile && session.profile !== opts.profile) {
      throw new ProfileError(
        `Session "${name}" belongs to profile "${session.profile}", not "${opts.profile}"`,
        { hint: 'Use the linked profile or choose a different --session name' },
      );
    }
    session.profile = opts.profile;
  }

  const after = JSON.stringify({
    cookies: session.cookies,
    history: session.history,
    lastUrl: session.lastUrl,
    profile: session.profile,
  });

  if (!existed || before !== after) {
    saveSession(name, session);
  }

  return session;
}

/**
 * Capture and save current browser state to a session.
 */
export async function captureSession(name, context, page, opts = {}) {
  let lastUrl;
  try {
    lastUrl = page?.url();
  } catch {}

  const cookies = opts.cookies || await context.cookies();
  return saveSessionSnapshot(name, { cookies, lastUrl }, opts);
}

/**
 * Restore session into browser context
 * Returns the last URL to navigate to
 */
export async function restoreSession(name, context, opts = {}) {
  const session = getSession(name);
  const { restoreCookies = true, expectedProfile } = opts;

  if (expectedProfile && session.profile && session.profile !== expectedProfile) {
    throw new ProfileError(
      `Session "${name}" belongs to profile "${session.profile}", not "${expectedProfile}"`,
      { hint: 'Use the linked profile or choose a different --session name' },
    );
  }

  // When a profile and session are combined, the profile is the canonical
  // cookie owner. The session still restores navigation/history metadata.
  if (restoreCookies && session.cookies && session.cookies.length > 0) {
    // Filter expired cookies before restoring them into the new context.
    const now = Date.now() / 1000;
    const validCookies = session.cookies.filter((c) => {
      if (c.expires && c.expires > 0 && c.expires < now) return false;
      return true;
    });

    if (validCookies.length > 0) {
      await context.addCookies(validCookies);
    }
  }

  return {
    lastUrl: session.lastUrl,
    history: session.history,
    cookiesRestored: restoreCookies ? session.cookies?.length || 0 : 0,
    profile: session.profile,
  };
}

/**
 * List all sessions
 */
export function listSessions() {
  const directory = ensureDir();
  const files = fs.readdirSync(directory).filter((f) => f.endsWith('.json'));

  return files.map((f) => {
    try {
      const filePath = path.join(directory, f);
      ensurePrivateFile(filePath);
      const session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

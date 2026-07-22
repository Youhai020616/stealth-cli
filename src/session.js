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
import { ProfileError } from './errors.js';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  writeJsonAtomic,
} from './utils/json-file.js';
import { withStateLock } from './utils/state-lock.js';
import {
  assertStateName,
  getSessionsDir,
  getStealthHome,
  listStateFilePaths,
  normalizeStoredStateName,
  resolveStateFilePath,
} from './utils/storage-paths.js';

const SESSION_METADATA_MIGRATIONS = new WeakSet();
const VALID_COOKIE_SAME_SITES = new Set(['Strict', 'Lax', 'None']);

function ensureDir() {
  const root = getStealthHome();
  const directory = getSessionsDir();
  try {
    ensurePrivateDirectory(root);
    ensurePrivateDirectory(directory);
  } catch (cause) {
    throw new ProfileError('Browser session storage is not private', {
      hint: `Fix permissions and path types for: ${root}`,
      cause,
    });
  }
  return directory;
}

function resolveSession(name) {
  const directory = ensureDir();
  try {
    return resolveStateFilePath(directory, name, 'Session');
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError('Browser session storage could not be read', {
      hint: `Check access permissions for: ${directory}`,
      cause,
    });
  }
}

function newSession(name) {
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidCookieUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isValidCookie(cookie) {
  if (
    !isPlainObject(cookie)
    || !isNonEmptyString(cookie.name)
    || typeof cookie.value !== 'string'
  ) {
    return false;
  }

  const hasUrl = Object.hasOwn(cookie, 'url');
  const hasDomain = Object.hasOwn(cookie, 'domain');
  const hasPath = Object.hasOwn(cookie, 'path');
  if (hasUrl && !isValidCookieUrl(cookie.url)) return false;
  if (
    (hasDomain || hasPath)
    && (!isNonEmptyString(cookie.domain) || !isNonEmptyString(cookie.path))
  ) {
    return false;
  }
  if (!hasUrl && !(hasDomain && hasPath)) return false;

  if (
    Object.hasOwn(cookie, 'expires')
    && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))
  ) {
    return false;
  }
  for (const field of ['httpOnly', 'secure']) {
    if (Object.hasOwn(cookie, field) && typeof cookie[field] !== 'boolean') return false;
  }
  if (
    Object.hasOwn(cookie, 'sameSite')
    && !VALID_COOKIE_SAME_SITES.has(cookie.sameSite)
  ) {
    return false;
  }
  return true;
}

function invalidSession(name, cause) {
  return new ProfileError(`Session "${name}" has an invalid format`, {
    hint: 'Use a new --session name or remove the invalid session file',
    cause,
  });
}

function normalizeSession(session, canonicalName, requestedName = canonicalName) {
  if (
    !isPlainObject(session)
    || !Array.isArray(session.cookies)
    || !session.cookies.every(isValidCookie)
    || !Array.isArray(session.history)
    || !session.history.every((entry) => typeof entry === 'string')
  ) {
    throw invalidSession(requestedName);
  }

  if (session.name !== null) {
    if (typeof session.name !== 'string') throw invalidSession(requestedName);
    try {
      normalizeStoredStateName(session.name, 'Session', canonicalName);
    } catch (cause) {
      throw invalidSession(requestedName, cause);
    }
  }

  let profile = null;
  if (session.profile !== null) {
    if (typeof session.profile !== 'string') throw invalidSession(requestedName);
    try {
      profile = normalizeStoredStateName(session.profile, 'Profile');
    } catch (cause) {
      throw invalidSession(requestedName, cause);
    }
  }

  if (
    session.lastUrl !== null
    && (typeof session.lastUrl !== 'string' || session.lastUrl.trim().length === 0)
  ) {
    throw invalidSession(requestedName);
  }

  return { ...session, name: canonicalName, profile };
}

function readSession(location, requestedName = location.name) {
  try {
    ensurePrivateFile(location.filePath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw new ProfileError(`Session "${requestedName}" cannot be accessed securely`, {
      hint: `Fix permissions and path type for: ${location.filePath}`,
      cause,
    });
  }

  let contents;
  try {
    contents = fs.readFileSync(location.filePath, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw new ProfileError(`Session "${requestedName}" could not be read`, {
      hint: `Check access permissions for: ${location.filePath}`,
      cause,
    });
  }

  let session;
  try {
    session = JSON.parse(contents);
  } catch (cause) {
    throw new ProfileError(`Session "${requestedName}" is corrupted`, {
      hint: 'Use a new --session name or remove the corrupted session file',
      cause,
    });
  }

  const normalized = normalizeSession(session, location.name, requestedName);
  if (session.name !== normalized.name || session.profile !== normalized.profile) {
    SESSION_METADATA_MIGRATIONS.add(normalized);
  }
  return normalized;
}

function writeSession(location, session, requestedName = location.name) {
  const normalized = {
    ...normalizeSession(session, location.name, requestedName),
    lastAccess: new Date().toISOString(),
  };
  try {
    writeJsonAtomic(location.filePath, normalized);
    SESSION_METADATA_MIGRATIONS.delete(session);
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError(`Failed to save session "${location.name}"`, {
      hint: `Check storage permissions and free space for: ${location.filePath}`,
      cause,
    });
  }
  return normalized;
}

/**
 * Create or load a validated session.
 */
export function getSession(name) {
  const location = resolveSession(name);
  if (!location.exists) return newSession(location.name);
  return readSession(location, location.name) || newSession(location.name);
}

/**
 * Save session state.
 *
 * @param {string} name
 * @param {object} session
 * @param {{ lease?: Function }} [opts]
 */
export function saveSession(name, session, opts = {}) {
  const canonicalName = assertStateName(name, 'Session');
  return withStateLock('session', canonicalName, opts.lease, () => {
    const location = resolveSession(canonicalName);
    writeSession(location, session, canonicalName);
  });
}

/**
 * Persist an already-captured browser snapshot to a named session.
 *
 * @param {string} name
 * @param {{ cookies: Array<object>, lastUrl?: string | null }} snapshot
 * @param {object} [opts]
 * @param {string} [opts.profile]
 * @param {Function} [opts.lease]
 */
export function saveSessionSnapshot(name, snapshot, opts = {}) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.cookies)) {
    throw new ProfileError(`Cannot save session "${name}": invalid cookie snapshot`);
  }
  if (!snapshot.cookies.every(isValidCookie)) {
    throw new ProfileError(`Cannot save session "${name}": invalid cookie snapshot`);
  }
  if (
    Object.hasOwn(snapshot, 'lastUrl')
    && snapshot.lastUrl !== undefined
    && snapshot.lastUrl !== null
    && (typeof snapshot.lastUrl !== 'string' || snapshot.lastUrl.trim().length === 0)
  ) {
    throw new ProfileError(`Cannot save session "${name}": invalid last URL`);
  }

  const canonicalName = assertStateName(name, 'Session');
  const profile = opts.profile === undefined || opts.profile === null
    ? null
    : assertStateName(opts.profile, 'Profile');

  return withStateLock('session', canonicalName, opts.lease, () => {
    const location = resolveSession(canonicalName);
    let session = location.exists
      ? readSession(location, canonicalName)
      : newSession(canonicalName);
    if (!session) session = newSession(canonicalName);

    const needsMetadataMigration = SESSION_METADATA_MIGRATIONS.has(session);
    const before = JSON.stringify({
      cookies: session.cookies,
      history: session.history,
      lastUrl: session.lastUrl,
      profile: session.profile,
    });

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

    if (profile) {
      if (session.profile && session.profile !== profile) {
        throw new ProfileError(
          `Session "${canonicalName}" belongs to profile "${session.profile}", not "${profile}"`,
          { hint: 'Use the linked profile or choose a different --session name' },
        );
      }
      session.profile = profile;
    }

    const after = JSON.stringify({
      cookies: session.cookies,
      history: session.history,
      lastUrl: session.lastUrl,
      profile: session.profile,
    });

    if (!location.exists || before !== after || needsMetadataMigration) {
      session = writeSession(location, session, canonicalName);
    }
    return session;
  });
}

/**
 * Capture and save current browser state to a session.
 */
export async function captureSession(name, context, page, opts = {}) {
  const canonicalName = assertStateName(name, 'Session');
  return withStateLock('session', canonicalName, opts.lease, async (activeLease) => {
    let lastUrl;
    try {
      lastUrl = page?.url();
    } catch {}

    const cookies = Object.hasOwn(opts, 'cookies')
      ? opts.cookies
      : await context.cookies();
    return saveSessionSnapshot(canonicalName, { cookies, lastUrl }, {
      ...opts,
      lease: activeLease,
    });
  });
}

/**
 * Restore session into browser context.
 * Returns the last URL to navigate to.
 */
export async function restoreSession(name, context, opts = {}) {
  const session = getSession(name);
  const { restoreCookies = true } = opts;
  const expectedProfile = opts.expectedProfile === undefined || opts.expectedProfile === null
    ? null
    : assertStateName(opts.expectedProfile, 'Profile');

  if (expectedProfile && session.profile && session.profile !== expectedProfile) {
    throw new ProfileError(
      `Session "${session.name}" belongs to profile "${session.profile}", not "${expectedProfile}"`,
      { hint: 'Use the linked profile or choose a different --session name' },
    );
  }

  // When a profile and session are combined, the profile is the canonical
  // cookie owner. The session still restores navigation/history metadata.
  if (restoreCookies && session.cookies.length > 0) {
    const now = Date.now() / 1000;
    const validCookies = session.cookies.filter((cookie) => {
      if (cookie.expires && cookie.expires > 0 && cookie.expires < now) return false;
      return true;
    });

    if (validCookies.length > 0) {
      await context.addCookies(validCookies);
    }
  }

  return {
    lastUrl: session.lastUrl,
    history: session.history,
    cookiesRestored: restoreCookies ? session.cookies.length : 0,
    profile: session.profile,
  };
}

/**
 * List all sessions.
 */
export function listSessions() {
  const directory = ensureDir();
  let files;
  try {
    files = listStateFilePaths(directory, 'Session');
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError('Browser session storage could not be read', {
      hint: `Check access permissions for: ${directory}`,
      cause,
    });
  }

  return files.map((location) => {
    try {
      const session = readSession(location, location.name);
      if (!session) return { name: location.name, error: 'unreadable' };
      return {
        name: location.name,
        lastUrl: session.lastUrl || '-',
        cookies: session.cookies.length,
        history: session.history.length,
        profile: session.profile || '-',
        lastAccess: session.lastAccess || 'never',
      };
    } catch (error) {
      const corrupted = error.message.includes('corrupted')
        || error.message.includes('invalid format');
      return { name: location.name, error: corrupted ? 'corrupted' : 'unreadable' };
    }
  });
}

/**
 * Delete a session.
 *
 * @param {string} name
 * @param {{ lease?: Function }} [opts]
 */
export function deleteSession(name, opts = {}) {
  const canonicalName = assertStateName(name, 'Session');
  return withStateLock('session', canonicalName, opts.lease, () => {
    const location = resolveSession(canonicalName);
    if (!location.exists) return;
    try {
      ensurePrivateFile(location.filePath);
      fs.unlinkSync(location.filePath);
    } catch (cause) {
      if (cause.code === 'ENOENT') return;
      throw new ProfileError(`Failed to delete session "${canonicalName}"`, {
        hint: `Check permissions and path type for: ${location.filePath}`,
        cause,
      });
    }
  });
}

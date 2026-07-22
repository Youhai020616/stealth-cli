/**
 * Profile management — persistent browser identity profiles
 *
 * Each profile stores:
 *   - Fingerprint config (locale, timezone, viewport, os)
 *   - Proxy settings
 *   - Cookie data (auto-saved between sessions)
 *   - Usage stats
 *
 * Storage: ~/.stealth/profiles/<name>.json
 */

import fs from 'fs';
import crypto from 'crypto';
import { ProfileError } from './errors.js';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  writeJsonAtomic,
} from './utils/json-file.js';
import { isValidProxyUrl } from './utils/proxy.js';
import { withStateLock } from './utils/state-lock.js';
import {
  assertStateName,
  getProfilesDir,
  getStealthHome,
  listStateFilePaths,
  normalizeStoredStateName,
  resolveStateFilePath,
} from './utils/storage-paths.js';

// Realistic fingerprint presets
const FINGERPRINT_PRESETS = {
  'us-desktop': {
    locale: 'en-US',
    timezone: 'America/New_York',
    viewport: { width: 1920, height: 1080 },
    os: 'windows',
    geo: { latitude: 40.7128, longitude: -74.006 },
  },
  'us-laptop': {
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    viewport: { width: 1440, height: 900 },
    os: 'macos',
    geo: { latitude: 37.7749, longitude: -122.4194 },
  },
  'uk-desktop': {
    locale: 'en-GB',
    timezone: 'Europe/London',
    viewport: { width: 1920, height: 1080 },
    os: 'windows',
    geo: { latitude: 51.5074, longitude: -0.1278 },
  },
  'de-desktop': {
    locale: 'de-DE',
    timezone: 'Europe/Berlin',
    viewport: { width: 1920, height: 1080 },
    os: 'windows',
    geo: { latitude: 52.52, longitude: 13.405 },
  },
  'jp-desktop': {
    locale: 'ja-JP',
    timezone: 'Asia/Tokyo',
    viewport: { width: 1920, height: 1080 },
    os: 'windows',
    geo: { latitude: 35.6762, longitude: 139.6503 },
  },
  'cn-desktop': {
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    viewport: { width: 1920, height: 1080 },
    os: 'windows',
    geo: { latitude: 31.2304, longitude: 121.4737 },
  },
  'mobile-ios': {
    locale: 'en-US',
    timezone: 'America/Chicago',
    viewport: { width: 390, height: 844 },
    os: 'macos',
    geo: { latitude: 41.8781, longitude: -87.6298 },
  },
  'mobile-android': {
    locale: 'en-US',
    timezone: 'America/Denver',
    viewport: { width: 412, height: 915 },
    os: 'linux',
    geo: { latitude: 39.7392, longitude: -104.9903 },
  },
};

// Random viewport sizes for generating unique profiles
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 2560, height: 1440 },
  { width: 1280, height: 800 },
];

const PROFILE_METADATA_MIGRATIONS = new WeakSet();
const VALID_PROFILE_OSES = new Set(['macos', 'windows', 'linux']);
const VALID_COOKIE_SAME_SITES = new Set(['Strict', 'Lax', 'None']);
const MAX_VIEWPORT_DIMENSION = 16_384;

const LOCALES = [
  { locale: 'en-US', tz: 'America/New_York', geo: { latitude: 40.7128, longitude: -74.006 } },
  { locale: 'en-US', tz: 'America/Los_Angeles', geo: { latitude: 34.0522, longitude: -118.2437 } },
  { locale: 'en-US', tz: 'America/Chicago', geo: { latitude: 41.8781, longitude: -87.6298 } },
  { locale: 'en-GB', tz: 'Europe/London', geo: { latitude: 51.5074, longitude: -0.1278 } },
  { locale: 'de-DE', tz: 'Europe/Berlin', geo: { latitude: 52.52, longitude: 13.405 } },
  { locale: 'fr-FR', tz: 'Europe/Paris', geo: { latitude: 48.8566, longitude: 2.3522 } },
  { locale: 'ja-JP', tz: 'Asia/Tokyo', geo: { latitude: 35.6762, longitude: 139.6503 } },
  { locale: 'zh-CN', tz: 'Asia/Shanghai', geo: { latitude: 31.2304, longitude: 121.4737 } },
];

/**
 * Ensure profiles directory exists below a validated STEALTH_HOME root.
 */
function ensureDir() {
  const root = getStealthHome();
  const directory = getProfilesDir();
  try {
    ensurePrivateDirectory(root);
    ensurePrivateDirectory(directory);
  } catch (cause) {
    throw new ProfileError('Browser profile storage is not private', {
      hint: `Fix permissions and path types for: ${root}`,
      cause,
    });
  }
  return directory;
}

function resolveProfile(name) {
  const directory = ensureDir();
  try {
    return resolveStateFilePath(directory, name, 'Profile');
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError('Browser profile storage could not be read', {
      hint: `Check access permissions for: ${directory}`,
      cause,
    });
  }
}

function profileNotFound(name) {
  return new ProfileError(`Profile "${name}" not found`, {
    hint: `Create with: stealth profile create ${name}`,
  });
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

function isValidLocale(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function isValidTimezone(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a cookie before it is persisted or passed to Playwright.
 */
export function isValidPersistedCookie(cookie) {
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
  if (hasUrl) {
    if (hasDomain || hasPath || !isValidCookieUrl(cookie.url)) return false;
  } else if (
    !hasDomain
    || !hasPath
    || !isNonEmptyString(cookie.domain)
    || !isNonEmptyString(cookie.path)
  ) {
    return false;
  }

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
  if (
    Object.hasOwn(cookie, 'partitionKey')
    && typeof cookie.partitionKey !== 'string'
  ) {
    return false;
  }
  return true;
}

function isValidFingerprint(fingerprint) {
  if (
    !isPlainObject(fingerprint)
    || !isValidLocale(fingerprint.locale)
    || !isValidTimezone(fingerprint.timezone)
    || !isPlainObject(fingerprint.viewport)
    || !Number.isInteger(fingerprint.viewport.width)
    || fingerprint.viewport.width <= 0
    || fingerprint.viewport.width > MAX_VIEWPORT_DIMENSION
    || !Number.isInteger(fingerprint.viewport.height)
    || fingerprint.viewport.height <= 0
    || fingerprint.viewport.height > MAX_VIEWPORT_DIMENSION
    || !VALID_PROFILE_OSES.has(fingerprint.os)
  ) {
    return false;
  }

  if (fingerprint.geo !== undefined) {
    if (
      !isPlainObject(fingerprint.geo)
      || !Number.isFinite(fingerprint.geo.latitude)
      || fingerprint.geo.latitude < -90
      || fingerprint.geo.latitude > 90
      || !Number.isFinite(fingerprint.geo.longitude)
      || fingerprint.geo.longitude < -180
      || fingerprint.geo.longitude > 180
      || (
        Object.hasOwn(fingerprint.geo, 'accuracy')
        && (!Number.isFinite(fingerprint.geo.accuracy) || fingerprint.geo.accuracy < 0)
      )
    ) {
      return false;
    }
  }
  return true;
}

function invalidProfile(name, cause) {
  return new ProfileError(`Profile "${name}" has an invalid format`, {
    hint: `Delete and recreate it: stealth profile delete ${name}`,
    cause,
  });
}

export function validateStoredProfile(profile, canonicalName, requestedName = canonicalName) {
  if (
    !isPlainObject(profile)
    || !isValidFingerprint(profile.fingerprint)
    || (profile.proxy !== null && !isValidProxyUrl(profile.proxy))
    || !Array.isArray(profile.cookies)
    || !profile.cookies.every(isValidPersistedCookie)
  ) {
    throw invalidProfile(requestedName);
  }
  if (profile.name !== undefined && profile.name !== null) {
    try {
      normalizeStoredStateName(profile.name, 'Profile', canonicalName);
    } catch (cause) {
      throw invalidProfile(requestedName, cause);
    }
  }
  return { ...profile, name: canonicalName };
}

function readProfile(location, requestedName = location.name) {
  try {
    ensurePrivateFile(location.filePath);
  } catch (cause) {
    if (cause.code === 'ENOENT') throw profileNotFound(location.name);
    throw new ProfileError(`Profile "${requestedName}" cannot be accessed securely`, {
      hint: `Fix permissions and path type for: ${location.filePath}`,
      cause,
    });
  }

  let contents;
  try {
    contents = fs.readFileSync(location.filePath, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') throw profileNotFound(location.name);
    throw new ProfileError(`Profile "${requestedName}" could not be read`, {
      hint: `Check access permissions for: ${location.filePath}`,
      cause,
    });
  }

  let profile;
  try {
    profile = JSON.parse(contents);
  } catch (cause) {
    throw new ProfileError(`Profile "${requestedName}" is corrupted`, {
      hint: `Delete and recreate it: stealth profile delete ${location.name}`,
      cause,
    });
  }

  const normalized = validateStoredProfile(profile, location.name, requestedName);
  if (profile.name !== normalized.name) PROFILE_METADATA_MIGRATIONS.add(normalized);
  return normalized;
}

function writeProfile(location, profile, requestedName = location.name) {
  const normalized = validateStoredProfile(profile, location.name, requestedName);
  try {
    writeJsonAtomic(location.filePath, normalized);
    PROFILE_METADATA_MIGRATIONS.delete(profile);
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError(`Failed to save profile "${location.name}"`, {
      hint: `Check storage permissions and free space for: ${location.filePath}`,
      cause,
    });
  }
  return normalized;
}

/**
 * Generate a random fingerprint
 */
function randomFingerprint() {
  const localeInfo = LOCALES[Math.floor(Math.random() * LOCALES.length)];
  const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
  const osOptions = ['windows', 'macos', 'linux'];
  const selectedOs = osOptions[Math.floor(Math.random() * osOptions.length)];

  return {
    locale: localeInfo.locale,
    timezone: localeInfo.tz,
    viewport,
    os: selectedOs,
    geo: localeInfo.geo,
  };
}

/**
 * Create a new profile.
 *
 * @param {string} name - Profile name
 * @param {object} opts
 * @param {string} [opts.preset] - Use a preset (us-desktop, uk-desktop, etc.)
 * @param {string} [opts.proxy] - Proxy server
 * @param {boolean} [opts.random] - Generate random fingerprint
 * @param {Function} [opts.lease] - Owning state lease
 */
export function createProfile(name, opts = {}) {
  const canonicalName = assertStateName(name, 'Profile');
  return withStateLock('profile', canonicalName, opts.lease, () => {
    const location = resolveProfile(canonicalName);
    if (location.exists) {
      throw new ProfileError(
        `Profile "${canonicalName}" already exists. Use --force to overwrite.`,
      );
    }
    if (opts.proxy !== undefined && opts.proxy !== null && !isValidProxyUrl(opts.proxy)) {
      throw new ProfileError(`Profile "${canonicalName}" has an invalid proxy URL`, {
        hint: 'Use an HTTP(S) proxy in the form [http://][user:password@]host[:port]',
      });
    }

    let fingerprint;
    if (opts.preset) {
      fingerprint = FINGERPRINT_PRESETS[opts.preset];
      if (!fingerprint) {
        throw new ProfileError(
          `Unknown preset "${opts.preset}". Available: ${Object.keys(FINGERPRINT_PRESETS).join(', ')}`,
          { hint: 'Run: stealth profile presets' },
        );
      }
      fingerprint = { ...fingerprint };
    } else if (opts.random || !opts.locale) {
      fingerprint = randomFingerprint();
    } else {
      fingerprint = {
        locale: opts.locale || 'en-US',
        timezone: opts.timezone || 'America/New_York',
        viewport: opts.viewport || { width: 1920, height: 1080 },
        os: opts.os || 'windows',
        geo: opts.geo || { latitude: 40.7128, longitude: -74.006 },
      };
    }

    const profile = {
      id: crypto.randomUUID(),
      name: canonicalName,
      fingerprint,
      proxy: opts.proxy ?? null,
      cookies: [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
      useCount: 0,
    };

    writeProfile(location, profile, canonicalName);
    return profile;
  });
}

/**
 * Load a profile by name.
 */
export function loadProfile(name) {
  const location = resolveProfile(name);
  if (!location.exists) throw profileNotFound(location.name);
  return readProfile(location, location.name);
}

/**
 * Save profile (update cookies, stats, etc.).
 *
 * @param {string} name
 * @param {object} profile
 * @param {{ lease?: Function }} [opts]
 */
export function saveProfile(name, profile, opts = {}) {
  const canonicalName = assertStateName(name, 'Profile');
  return withStateLock('profile', canonicalName, opts.lease, () => {
    const location = resolveProfile(canonicalName);
    writeProfile(location, profile, canonicalName);
  });
}

/**
 * Update profile usage stats.
 *
 * @param {string} name
 * @param {{ lease?: Function }} [opts]
 */
export function touchProfile(name, opts = {}) {
  const canonicalName = assertStateName(name, 'Profile');
  return withStateLock('profile', canonicalName, opts.lease, () => {
    const location = resolveProfile(canonicalName);
    if (!location.exists) throw profileNotFound(canonicalName);
    const profile = readProfile(location, canonicalName);
    profile.lastUsed = new Date().toISOString();
    profile.useCount = Number.isFinite(profile.useCount) ? profile.useCount + 1 : 1;
    writeProfile(location, profile, canonicalName);
    return profile;
  });
}

/**
 * Persist an already-captured cookie snapshot to a profile.
 *
 * @param {string} name
 * @param {Array<object>} cookies
 * @param {{ lease?: Function }} [opts]
 * @returns {number} Number of cookies in the snapshot
 */
export function saveProfileCookies(name, cookies, opts = {}) {
  if (!Array.isArray(cookies) || !cookies.every(isValidPersistedCookie)) {
    throw new ProfileError(`Cannot save profile "${name}": invalid cookie snapshot`);
  }

  const canonicalName = assertStateName(name, 'Profile');
  return withStateLock('profile', canonicalName, opts.lease, () => {
    const location = resolveProfile(canonicalName);
    if (!location.exists) throw profileNotFound(canonicalName);
    const profile = readProfile(location, canonicalName);
    const changed = JSON.stringify(profile.cookies || []) !== JSON.stringify(cookies);
    const needsMetadataMigration = PROFILE_METADATA_MIGRATIONS.has(profile);

    if (changed) {
      profile.cookies = cookies;
      profile.lastUsed = new Date().toISOString();
    }
    if (changed || needsMetadataMigration) {
      writeProfile(location, profile, canonicalName);
    }

    return cookies.length;
  });
}

/**
 * Capture and save cookies to a profile.
 *
 * @param {string} name
 * @param {object} context
 * @param {{ lease?: Function }} [opts]
 */
export async function saveCookiesToProfile(name, context, opts = {}) {
  const canonicalName = assertStateName(name, 'Profile');
  return withStateLock('profile', canonicalName, opts.lease, async (activeLease) => {
    const cookies = await context.cookies();
    return saveProfileCookies(canonicalName, cookies, { lease: activeLease });
  });
}

/**
 * Load cookies from profile into browser context.
 */
export async function loadCookiesFromProfile(name, context) {
  const profile = loadProfile(name);
  if (profile.cookies && profile.cookies.length > 0) {
    await context.addCookies(profile.cookies);
    return profile.cookies.length;
  }
  return 0;
}

/**
 * List all profiles.
 */
export function listProfiles() {
  const directory = ensureDir();
  let files;
  try {
    files = listStateFilePaths(directory, 'Profile');
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError('Browser profile storage could not be read', {
      hint: `Check access permissions for: ${directory}`,
      cause,
    });
  }

  return files.map((location) => {
    try {
      const profile = readProfile(location, location.name);
      return {
        name: location.name,
        locale: profile.fingerprint?.locale || '?',
        timezone: profile.fingerprint?.timezone || '?',
        os: profile.fingerprint?.os || '?',
        viewport: profile.fingerprint?.viewport
          ? `${profile.fingerprint.viewport.width}x${profile.fingerprint.viewport.height}`
          : '?',
        proxy: profile.proxy ? '✓' : '-',
        cookies: profile.cookies?.length || 0,
        lastUsed: profile.lastUsed || 'never',
        useCount: profile.useCount || 0,
      };
    } catch (error) {
      const corrupted = error.message.includes('corrupted')
        || error.message.includes('invalid format');
      return { name: location.name, error: corrupted ? 'corrupted' : 'unreadable' };
    }
  });
}

/**
 * Delete a profile.
 *
 * @param {string} name
 * @param {{ lease?: Function }} [opts]
 */
export function deleteProfile(name, opts = {}) {
  const canonicalName = assertStateName(name, 'Profile');
  return withStateLock('profile', canonicalName, opts.lease, () => {
    const location = resolveProfile(canonicalName);
    if (!location.exists) throw profileNotFound(canonicalName);
    try {
      ensurePrivateFile(location.filePath);
      fs.unlinkSync(location.filePath);
    } catch (cause) {
      if (cause.code === 'ENOENT') throw profileNotFound(canonicalName);
      throw new ProfileError(`Failed to delete profile "${canonicalName}"`, {
        hint: `Check permissions and path type for: ${location.filePath}`,
        cause,
      });
    }
  });
}

/**
 * Get available presets.
 */
export function getPresets() {
  return Object.keys(FINGERPRINT_PRESETS);
}

/**
 * Pick a random profile from existing ones.
 */
export function randomProfile() {
  const profiles = listProfiles();
  if (profiles.length === 0) return null;
  return profiles[Math.floor(Math.random() * profiles.length)].name;
}

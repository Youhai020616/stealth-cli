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
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ProfileError } from './errors.js';

const PROFILES_DIR = path.join(os.homedir(), '.stealth', 'profiles');

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
 * Ensure profiles directory exists
 */
function ensureDir() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

/**
 * Get path to a profile file
 */
function profilePath(name) {
  // Sanitize name
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(PROFILES_DIR, `${safeName}.json`);
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
 * Create a new profile
 *
 * @param {string} name - Profile name
 * @param {object} opts
 * @param {string} [opts.preset] - Use a preset (us-desktop, uk-desktop, etc.)
 * @param {string} [opts.proxy] - Proxy server
 * @param {boolean} [opts.random] - Generate random fingerprint
 */
export function createProfile(name, opts = {}) {
  ensureDir();
  const filePath = profilePath(name);

  if (fs.existsSync(filePath)) {
    throw new ProfileError(`Profile "${name}" already exists. Use --force to overwrite.`);
  }

  let fingerprint;

  if (opts.preset) {
    fingerprint = FINGERPRINT_PRESETS[opts.preset];
    if (!fingerprint) {
      throw new ProfileError(`Unknown preset "${opts.preset}". Available: ${Object.keys(FINGERPRINT_PRESETS).join(', ')}`, { hint: 'Run: stealth profile presets' });
    }
    fingerprint = { ...fingerprint }; // Clone
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
    name,
    fingerprint,
    proxy: opts.proxy || null,
    cookies: [],
    createdAt: new Date().toISOString(),
    lastUsed: null,
    useCount: 0,
  };

  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
  return profile;
}

/**
 * Load a profile by name
 */
export function loadProfile(name) {
  const filePath = profilePath(name);

  if (!fs.existsSync(filePath)) {
    throw new ProfileError(`Profile "${name}" not found`, { hint: `Create with: stealth profile create ${name}` });
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Save profile (update cookies, stats, etc.)
 */
export function saveProfile(name, profile) {
  ensureDir();
  const filePath = profilePath(name);
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
}

/**
 * Update profile usage stats
 */
export function touchProfile(name) {
  const profile = loadProfile(name);
  profile.lastUsed = new Date().toISOString();
  profile.useCount += 1;
  saveProfile(name, profile);
  return profile;
}

/**
 * Save cookies to profile (auto-called when browser closes)
 */
export async function saveCookiesToProfile(name, context) {
  try {
    const profile = loadProfile(name);
    const cookies = await context.cookies();
    profile.cookies = cookies;
    profile.lastUsed = new Date().toISOString();
    saveProfile(name, profile);
    return cookies.length;
  } catch {
    return 0;
  }
}

/**
 * Load cookies from profile into browser context
 */
export async function loadCookiesFromProfile(name, context) {
  try {
    const profile = loadProfile(name);
    if (profile.cookies && profile.cookies.length > 0) {
      await context.addCookies(profile.cookies);
      return profile.cookies.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * List all profiles
 */
export function listProfiles() {
  ensureDir();
  const files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));

  return files.map((f) => {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf-8'));
      return {
        name: profile.name,
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
    } catch {
      return { name: f.replace('.json', ''), error: 'corrupted' };
    }
  });
}

/**
 * Delete a profile
 */
export function deleteProfile(name) {
  const filePath = profilePath(name);
  if (!fs.existsSync(filePath)) {
    throw new ProfileError(`Profile "${name}" not found`);
  }
  fs.unlinkSync(filePath);
}

/**
 * Get available presets
 */
export function getPresets() {
  return Object.keys(FINGERPRINT_PRESETS);
}

/**
 * Pick a random profile from existing ones
 */
export function randomProfile() {
  const profiles = listProfiles();
  if (profiles.length === 0) return null;
  return profiles[Math.floor(Math.random() * profiles.length)].name;
}

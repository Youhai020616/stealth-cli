import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import {
  createProfile, loadProfile, deleteProfile,
  listProfiles, getPresets, saveCookiesToProfile,
  saveProfileCookies, loadCookiesFromProfile,
  saveProfile, touchProfile,
} from '../../src/profiles.js';
import { acquireStateLocks } from '../../src/utils/state-lock.js';
import { normalizeStoredStateName } from '../../src/utils/storage-paths.js';

const TEST_PROFILE = '__vitest_test_profile__';
const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-profiles-'));
const PROFILES_DIR = path.join(TEST_STEALTH_HOME, 'profiles');
process.env.STEALTH_HOME = TEST_STEALTH_HOME;

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(PROFILES_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(TEST_STEALTH_HOME, 'locks'), { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_STEALTH_HOME === undefined) delete process.env.STEALTH_HOME;
  else process.env.STEALTH_HOME = ORIGINAL_STEALTH_HOME;
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
});

function profileFixture(name) {
  return {
    id: `fixture-${name}`,
    name,
    fingerprint: {
      locale: 'en-US',
      timezone: 'UTC',
      viewport: { width: 1280, height: 720 },
      os: 'linux',
    },
    proxy: null,
    cookies: [],
    createdAt: new Date(0).toISOString(),
    lastUsed: null,
    useCount: 0,
  };
}

function writeProfileFixture(fileName, profile) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(PROFILES_DIR, fileName),
    `${JSON.stringify(profile)}\n`,
    { mode: 0o600 },
  );
}

function writeMainSerializedProfile(name) {
  const legacyBasename = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(PROFILES_DIR, `${legacyBasename}.json`);
  fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(profileFixture(name), null, 2), { mode: 0o600 });
  return filePath;
}

function supportsCaseSensitiveNames(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const upper = path.join(directory, '__CaseProbe');
  const lower = path.join(directory, '__caseprobe');
  fs.writeFileSync(upper, 'upper');
  try {
    fs.writeFileSync(lower, 'lower', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(upper, { force: true });
    fs.rmSync(lower, { force: true });
  }
}

describe('profiles', () => {
  it('should create a profile with preset', () => {
    const p = createProfile(TEST_PROFILE, { preset: 'us-desktop' });
    expect(p.name).toBe(TEST_PROFILE);
    expect(p.fingerprint.locale).toBe('en-US');
    expect(p.fingerprint.os).toBe('windows');
    expect(p.fingerprint.viewport.width).toBe(1920);
    expect(p.useCount).toBe(0);
    if (process.platform !== 'win32') {
      expect(fs.statSync(PROFILES_DIR).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(PROFILES_DIR, `${TEST_PROFILE}.json`)).mode & 0o777).toBe(0o600);
    }
  });

  it('should create a random profile', () => {
    const p = createProfile(TEST_PROFILE, { random: true });
    expect(p.name).toBe(TEST_PROFILE);
    expect(p.fingerprint.locale).toBeTruthy();
    expect(p.fingerprint.timezone).toBeTruthy();
    expect(p.fingerprint.viewport).toBeTruthy();
    expect(p.id).toBeTruthy();
  });

  it('should load a saved profile', () => {
    createProfile(TEST_PROFILE, { preset: 'jp-desktop' });
    const loaded = loadProfile(TEST_PROFILE);
    expect(loaded.name).toBe(TEST_PROFILE);
    expect(loaded.fingerprint.locale).toBe('ja-JP');
  });

  it('accepts fully validated URL-scoped profile cookies and bounded geolocation', () => {
    const name = 'validated-profile';
    const cookie = {
      name: 'sid',
      value: '',
      url: 'https://example.com/account',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    };
    writeProfileFixture(`${name}.json`, {
      ...profileFixture(name),
      fingerprint: {
        ...profileFixture(name).fingerprint,
        geo: { latitude: -90, longitude: 180 },
      },
      cookies: [cookie],
    });

    expect(loadProfile(name)).toMatchObject({
      fingerprint: { geo: { latitude: -90, longitude: 180 } },
      cookies: [cookie],
    });
  });

  it('rejects deeply malformed stored profile state', () => {
    const validCookie = {
      name: 'sid',
      value: '123',
      domain: '.example.com',
      path: '/',
    };
    const malformedProfiles = [
      (profile) => ({ ...profile, fingerprint: { ...profile.fingerprint, locale: ' ' } }),
      (profile) => ({ ...profile, fingerprint: { ...profile.fingerprint, timezone: null } }),
      (profile) => ({ ...profile, fingerprint: { ...profile.fingerprint, viewport: null } }),
      (profile) => ({
        ...profile,
        fingerprint: {
          ...profile.fingerprint,
          viewport: { ...profile.fingerprint.viewport, width: 0 },
        },
      }),
      (profile) => ({
        ...profile,
        fingerprint: {
          ...profile.fingerprint,
          viewport: { ...profile.fingerprint.viewport, height: '720' },
        },
      }),
      (profile) => ({ ...profile, fingerprint: { ...profile.fingerprint, os: 'android' } }),
      (profile) => ({ ...profile, fingerprint: { ...profile.fingerprint, geo: null } }),
      (profile) => ({
        ...profile,
        fingerprint: {
          ...profile.fingerprint,
          geo: { latitude: 90.1, longitude: 0 },
        },
      }),
      (profile) => ({
        ...profile,
        fingerprint: {
          ...profile.fingerprint,
          geo: { latitude: 0, longitude: -180.1 },
        },
      }),
      (profile) => ({ ...profile, proxy: {} }),
      (profile) => ({ ...profile, cookies: [{ ...validCookie, name: ' ' }] }),
      (profile) => ({ ...profile, cookies: [{ ...validCookie, value: 123 }] }),
      (profile) => ({ ...profile, cookies: [{ name: 'sid', value: '123', url: 'not-a-url' }] }),
      (profile) => ({ ...profile, cookies: [{ name: 'sid', value: '123', domain: '.example.com' }] }),
      (profile) => ({ ...profile, cookies: [{ ...validCookie, expires: 'never' }] }),
      (profile) => ({ ...profile, cookies: [{ ...validCookie, httpOnly: 'true' }] }),
      (profile) => ({ ...profile, cookies: [{ ...validCookie, secure: 1 }] }),
      (profile) => ({ ...profile, cookies: [{ ...validCookie, sameSite: 'lax' }] }),
    ];

    malformedProfiles.forEach((mutate, index) => {
      const name = `malformed-profile-${index}`;
      writeProfileFixture(`${name}.json`, mutate(profileFixture(name)));
      let error;
      try {
        loadProfile(name);
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({ name: 'ProfileError', code: 8 });
      expect(error?.message).toContain('invalid format');
      expect(error).not.toBeInstanceOf(TypeError);
    });
  });

  it('rejects malformed profile cookie snapshots before persisting them', () => {
    createProfile(TEST_PROFILE, { preset: 'us-desktop' });

    expect(() => saveProfileCookies(TEST_PROFILE, [
      { name: 'sid', value: '123', domain: '.example.com' },
    ])).toThrow('invalid cookie snapshot');
  });

  it('should harden a legacy profile directory when loading through the SDK', () => {
    createProfile(TEST_PROFILE, { preset: 'us-desktop' });
    if (process.platform !== 'win32') {
      fs.chmodSync(PROFILES_DIR, 0o755);
      loadProfile(TEST_PROFILE);
      expect(fs.statSync(PROFILES_DIR).mode & 0o777).toBe(0o700);
    }
  });

  it('should reject unsafe profile names with safe legacy basename guidance', () => {
    let error;
    try {
      loadProfile('Old Profile');
    } catch (cause) {
      error = cause;
    }

    expect(error?.message).toContain('only letters');
    expect(error?.hint).toContain('sanitized basename "old_profile"');
    expect(() => createProfile('../outside', { random: true })).toThrow('only letters');
    expect(() => loadProfile('work.json')).toThrow('only letters');
    expect(() => createProfile('CON', { random: true })).toThrow('reserved Windows');
    expect(() => loadProfile('com9')).toThrow('reserved Windows');

    expect(normalizeStoredStateName('work.prod', 'Profile', 'work_prod'))
      .toBe('work_prod');
    expect(() => normalizeStoredStateName('../work', 'Profile', 'work'))
      .toThrow('path-like');
    expect(() => normalizeStoredStateName('other.prod', 'Profile', 'work_prod'))
      .toThrow('does not match');
  });

  it('canonicalizes case aliases to one profile file and identity', () => {
    const profile = createProfile('MixedCase', { preset: 'us-desktop' });

    expect(profile.name).toBe('mixedcase');
    expect(fs.existsSync(path.join(PROFILES_DIR, 'mixedcase.json'))).toBe(true);
    expect(loadProfile('MIXEDCASE').name).toBe('mixedcase');
    expect(() => createProfile('mixedcase', { random: true })).toThrow('already exists');
  });

  it('resolves mixed-case legacy filenames and lists a canonical basename', () => {
    writeProfileFixture('LegacyWork.JSON', profileFixture('LEGACYWORK'));

    expect(loadProfile('legacywork').name).toBe('legacywork');
    expect(loadProfile('LegacyWork').fingerprint.locale).toBe('en-US');
    expect(listProfiles()).toContainEqual(expect.objectContaining({ name: 'legacywork' }));
  });

  it('migrates the exact profile metadata shape serialized by main\'s old sanitizer', () => {
    const filePath = writeMainSerializedProfile('work.prod');

    const loaded = loadProfile('work_prod');
    expect(loaded.name).toBe('work_prod');

    // An unchanged cookie save is still the next save and must canonicalize metadata.
    expect(saveProfileCookies('work_prod', [])).toBe(0);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).name).toBe('work_prod');
  });

  it('detects case-insensitive filename collisions on case-sensitive filesystems', () => {
    if (!supportsCaseSensitiveNames(PROFILES_DIR)) return;
    writeProfileFixture('Work.json', profileFixture('Work'));
    writeProfileFixture('work.JSON', profileFixture('work'));

    expect(() => loadProfile('work')).toThrow('filename collisions');
    expect(() => listProfiles()).toThrow('filename collisions');
  });

  it('uses canonical basenames and rejects mismatched or path-like embedded names', () => {
    writeProfileFixture('ListedProfile.json', profileFixture('ListedProfile'));
    writeProfileFixture('Mismatched.json', profileFixture('OtherProfile'));
    writeProfileFixture('UnsafeEmbedded.json', profileFixture('../outside'));

    const profiles = listProfiles();
    expect(profiles).toContainEqual(expect.objectContaining({ name: 'listedprofile' }));
    expect(profiles).toContainEqual({ name: 'mismatched', error: 'corrupted' });
    expect(profiles).toContainEqual({ name: 'unsafeembedded', error: 'corrupted' });
  });

  it('should throw when profile not found', () => {
    expect(() => loadProfile('nonexistent_profile_xyz')).toThrow('not found');
  });

  it('should throw when creating duplicate profile', () => {
    createProfile(TEST_PROFILE, { random: true });
    expect(() => createProfile(TEST_PROFILE, { random: true })).toThrow('already exists');
  });

  it('should delete a profile', () => {
    createProfile(TEST_PROFILE, { random: true });
    deleteProfile(TEST_PROFILE);
    expect(() => loadProfile(TEST_PROFILE)).toThrow('not found');
  });

  it('should list profiles', () => {
    createProfile(TEST_PROFILE, { preset: 'uk-desktop' });
    const profiles = listProfiles();
    const found = profiles.find((p) => p.name === TEST_PROFILE);
    expect(found).toBeTruthy();
    expect(found.locale).toBe('en-GB');
  });

  it('should return available presets', () => {
    const presets = getPresets();
    expect(presets).toContain('us-desktop');
    expect(presets).toContain('jp-desktop');
    expect(presets).toContain('mobile-ios');
    expect(presets.length).toBeGreaterThanOrEqual(8);
  });

  it('should throw for unknown preset', () => {
    expect(() => createProfile(TEST_PROFILE, { preset: 'nonexistent' })).toThrow('Unknown preset');
  });

  it('should save proxy in profile', () => {
    const p = createProfile(TEST_PROFILE, { preset: 'us-desktop', proxy: 'http://proxy:8080' });
    expect(p.proxy).toBe('http://proxy:8080');
    const loaded = loadProfile(TEST_PROFILE);
    expect(loaded.proxy).toBe('http://proxy:8080');
  });

  it('should persist and restore a captured cookie snapshot', async () => {
    const cookies = [{ name: 'sid', value: '123', domain: 'example.com', path: '/' }];
    createProfile(TEST_PROFILE, { preset: 'us-desktop' });
    const context = {
      cookies: vi.fn().mockResolvedValue(cookies),
      addCookies: vi.fn().mockResolvedValue(undefined),
    };

    expect(await saveCookiesToProfile(TEST_PROFILE, context)).toBe(1);
    expect(saveProfileCookies(TEST_PROFILE, cookies)).toBe(1);
    expect(await loadCookiesFromProfile(TEST_PROFILE, context)).toBe(1);
    expect(context.addCookies).toHaveBeenCalledWith(cookies);
    expect(loadProfile(TEST_PROFILE).cookies).toEqual(cookies);
  });

  it('locks every profile mutation and reuses an owning lifetime lease', async () => {
    const lease = acquireStateLocks({ profile: TEST_PROFILE });
    const cookies = [{ name: 'sid', value: '123', domain: 'example.com', path: '/' }];
    const context = { cookies: vi.fn().mockResolvedValue(cookies) };

    try {
      expect(() => createProfile(TEST_PROFILE, { preset: 'us-desktop' }))
        .toThrow('already in use');
      const profile = createProfile(TEST_PROFILE, { preset: 'us-desktop', lease });

      expect(() => saveProfile(TEST_PROFILE, profile)).toThrow('already in use');
      saveProfile(TEST_PROFILE, profile, { lease });

      expect(() => touchProfile(TEST_PROFILE)).toThrow('already in use');
      expect(touchProfile(TEST_PROFILE, { lease }).useCount).toBe(1);

      expect(() => saveProfileCookies(TEST_PROFILE, cookies)).toThrow('already in use');
      expect(saveProfileCookies(TEST_PROFILE, cookies, { lease })).toBe(1);

      await expect(saveCookiesToProfile(TEST_PROFILE, context)).rejects.toThrow('already in use');
      await expect(saveCookiesToProfile(TEST_PROFILE, context, { lease })).resolves.toBe(1);

      expect(() => deleteProfile(TEST_PROFILE)).toThrow('already in use');
      deleteProfile(TEST_PROFILE, { lease });
      expect(() => loadProfile(TEST_PROFILE)).toThrow('not found');
    } finally {
      lease();
    }
  });

  it('distinguishes unreadable profile files from corrupted JSON', () => {
    createProfile(TEST_PROFILE, { preset: 'us-desktop' });
    const filePath = path.join(PROFILES_DIR, `${TEST_PROFILE}.json`);
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
      if (path.resolve(String(target)) === filePath) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return readFileSync(target, ...args);
    });

    let permissionError;
    try {
      loadProfile(TEST_PROFILE);
    } catch (cause) {
      permissionError = cause;
    }
    expect(permissionError?.code).toBe(8);
    expect(permissionError?.message).toContain('could not be read');
    expect(permissionError?.message).not.toContain('corrupted');

    vi.restoreAllMocks();
    fs.writeFileSync(filePath, '{bad-json', { mode: 0o600 });
    expect(() => loadProfile(TEST_PROFILE)).toThrow('corrupted');
  });

  const symlinkIt = process.platform === 'win32' ? it.skip : it;
  symlinkIt('rejects profile-file and STEALTH_HOME symlinks', () => {
    fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
    const outsideFile = path.join(TEST_STEALTH_HOME, 'outside-profile.json');
    fs.writeFileSync(outsideFile, JSON.stringify(profileFixture('linked')), { mode: 0o600 });
    fs.symlinkSync(outsideFile, path.join(PROFILES_DIR, 'linked.json'));

    expect(() => loadProfile('linked')).toThrow('cannot be accessed securely');
    expect(listProfiles()).toContainEqual({ name: 'linked', error: 'unreadable' });

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-profile-root-link-'));
    const target = path.join(base, 'target');
    const linkedHome = path.join(base, 'home');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, linkedHome);
    const previousHome = process.env.STEALTH_HOME;
    process.env.STEALTH_HOME = linkedHome;
    try {
      expect(() => listProfiles()).toThrow('storage is not private');
    } finally {
      process.env.STEALTH_HOME = previousHome;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('should surface cookie capture failures instead of returning false success', async () => {
    createProfile(TEST_PROFILE, { preset: 'us-desktop' });
    const context = {
      cookies: vi.fn().mockRejectedValue(new Error('browser disconnected')),
    };

    await expect(saveCookiesToProfile(TEST_PROFILE, context)).rejects.toThrow('browser disconnected');
  });
});

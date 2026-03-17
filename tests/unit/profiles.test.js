import { describe, it, expect, afterEach } from 'vitest';
import {
  createProfile, loadProfile, deleteProfile,
  listProfiles, getPresets,
} from '../../src/profiles.js';

const TEST_PROFILE = '__vitest_test_profile__';

afterEach(() => {
  try { deleteProfile(TEST_PROFILE); } catch {}
});

describe('profiles', () => {
  it('should create a profile with preset', () => {
    const p = createProfile(TEST_PROFILE, { preset: 'us-desktop' });
    expect(p.name).toBe(TEST_PROFILE);
    expect(p.fingerprint.locale).toBe('en-US');
    expect(p.fingerprint.os).toBe('windows');
    expect(p.fingerprint.viewport.width).toBe(1920);
    expect(p.useCount).toBe(0);
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
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-config-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
vi.resetModules();

const {
  loadConfig, setConfigValue, getConfigValue,
  deleteConfigValue, listConfig, resetConfig,
} = await import('../../src/config.js');

beforeEach(() => {
  resetConfig();
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('config', () => {
  it('should return defaults when no config file exists', () => {
    const config = loadConfig();
    expect(config.headless).toBe(true);
    expect(config.locale).toBe('en-US');
    expect(config.retries).toBe(2);
    expect(config.timeout).toBe(30000);
  });

  it('should set and get string values', () => {
    setConfigValue('locale', 'zh-CN');
    expect(getConfigValue('locale')).toBe('zh-CN');
  });

  it('should set and get boolean values', () => {
    setConfigValue('humanize', 'true');
    expect(getConfigValue('humanize')).toBe(true);

    setConfigValue('headless', 'false');
    expect(getConfigValue('headless')).toBe(false);
  });

  it('should set and get number values', () => {
    setConfigValue('timeout', '5000');
    expect(getConfigValue('timeout')).toBe(5000);
  });

  it('should reject unknown keys', () => {
    expect(() => setConfigValue('nonexistent', 'val')).toThrow('Unknown config key');
  });

  it('should delete a config value (reset to default)', () => {
    setConfigValue('locale', 'fr-FR');
    expect(getConfigValue('locale')).toBe('fr-FR');
    deleteConfigValue('locale');
    expect(getConfigValue('locale')).toBe('en-US'); // default
  });

  it('should list all config with sources', () => {
    setConfigValue('locale', 'de-DE');
    const items = listConfig();
    const localeItem = items.find((i) => i.key === 'locale');
    expect(localeItem.value).toBe('de-DE');
    expect(localeItem.source).toBe('user');

    const headlessItem = items.find((i) => i.key === 'headless');
    expect(headlessItem.source).toBe('default');
  });

  it('should reset all config', () => {
    setConfigValue('locale', 'ja-JP');
    setConfigValue('retries', '5');
    resetConfig();
    expect(getConfigValue('locale')).toBe('en-US');
    expect(getConfigValue('retries')).toBe(2);
  });
});

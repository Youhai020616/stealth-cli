import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  loadConfig, setConfigValue, getConfigValue,
  deleteConfigValue, listConfig, resetConfig, CONFIG_FILE,
} from '../../src/config.js';
import fs from 'fs';

// Save and restore original config
let originalConfig = null;

beforeEach(() => {
  try {
    originalConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf-8') : null;
  } catch {}
  resetConfig();
});

afterAll(() => {
  if (originalConfig) {
    fs.writeFileSync(CONFIG_FILE, originalConfig);
  } else {
    resetConfig();
  }
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

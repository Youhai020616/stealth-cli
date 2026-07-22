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
  deleteConfigValue, listConfig, resetConfig, CONFIG_FILE,
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

  it('should store proxy credentials in owner-only config storage', () => {
    const proxy = 'http://api-token:proxy-secret@proxy.example:8080';
    setConfigValue('proxy', proxy);

    expect(getConfigValue('proxy')).toBe(proxy);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(CONFIG_FILE)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(CONFIG_FILE).mode & 0o777).toBe(0o600);
    }
  });

  it('should reject an invalid proxy without mutating persisted config', () => {
    setConfigValue('locale', 'en-GB');
    const before = fs.readFileSync(CONFIG_FILE, 'utf8');
    const invalid = 'http://user:do-not-leak@proxy.example:8080/private';

    let failure;
    try {
      setConfigValue('proxy', invalid);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: 'ProxyError', code: 7 });
    expect(JSON.stringify(failure)).not.toContain('do-not-leak');
    expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(before);
  });

  it('should fail closed on malformed JSON instead of silently dropping proxy settings', () => {
    fs.writeFileSync(CONFIG_FILE, '{"proxy":"http://proxy.example:8080"', { mode: 0o600 });

    expect(() => loadConfig()).toThrow('contains malformed JSON');
  });

  it('hardens a legacy config directory and file during a read-only load', () => {
    fs.chmodSync(path.dirname(CONFIG_FILE), 0o755);
    fs.chmodSync(CONFIG_FILE, 0o644);

    loadConfig();

    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(CONFIG_FILE)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(CONFIG_FILE).mode & 0o777).toBe(0o600);
    }
  });

  it('does not replace malformed config during transactional mutations', () => {
    fs.writeFileSync(CONFIG_FILE, '{broken-config', { mode: 0o600 });
    const before = fs.readFileSync(CONFIG_FILE, 'utf8');

    expect(() => setConfigValue('locale', 'fr-FR')).toThrow('contains malformed JSON');
    expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(before);
    expect(() => deleteConfigValue('locale')).toThrow('contains malformed JSON');
    expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(before);

    resetConfig();
    expect(loadConfig()).toMatchObject({ locale: 'en-US' });
  });

  it('should reject an invalid proxy already persisted on disk', () => {
    const invalid = 'http://user:do-not-leak@proxy.example:8080/private';
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ proxy: invalid })}\n`, { mode: 0o600 });

    let failure;
    try {
      loadConfig();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: 'ProxyError', code: 7 });
    expect(JSON.stringify(failure)).not.toContain('do-not-leak');
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

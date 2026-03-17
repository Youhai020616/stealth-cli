import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resolveOpts } from '../../src/utils/resolve-opts.js';
import { setConfigValue, resetConfig, CONFIG_FILE } from '../../src/config.js';
import fs from 'fs';

let originalConfig = null;

beforeEach(() => {
  try {
    originalConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf-8') : null;
  } catch {}
  resetConfig();
});

afterAll(() => {
  if (originalConfig) fs.writeFileSync(CONFIG_FILE, originalConfig);
  else resetConfig();
});

describe('resolveOpts', () => {
  it('should return defaults when no config and no CLI opts', () => {
    const opts = resolveOpts({});
    expect(opts.headless).toBe(true);
    expect(opts.humanize).toBe(false);
    expect(opts.retries).toBe(2);
    expect(opts.format).toBe('text');
    expect(opts.locale).toBe('en-US');
  });

  it('should apply global config values', () => {
    setConfigValue('humanize', 'true');
    setConfigValue('locale', 'zh-CN');
    setConfigValue('retries', '5');

    const opts = resolveOpts({});
    expect(opts.humanize).toBe(true);
    expect(opts.locale).toBe('zh-CN');
    expect(opts.retries).toBe(5);
  });

  it('should let CLI opts override global config', () => {
    setConfigValue('humanize', 'true');
    setConfigValue('locale', 'zh-CN');

    const opts = resolveOpts({ humanize: false, locale: 'ja-JP' });
    expect(opts.humanize).toBe(false);
    expect(opts.locale).toBe('ja-JP');
  });

  it('should not override CLI false with config true for headless', () => {
    setConfigValue('headless', 'true');
    const opts = resolveOpts({ headless: false });
    expect(opts.headless).toBe(false);
  });

  it('should handle proxy from config', () => {
    setConfigValue('proxy', 'http://proxy:8080');
    const opts = resolveOpts({});
    expect(opts.proxy).toBe('http://proxy:8080');
  });

  it('should handle string retries from CLI (Commander passes strings)', () => {
    const opts = resolveOpts({ retries: '3' });
    expect(opts.retries).toBe(3);
  });

  it('should pass through unknown CLI opts untouched', () => {
    const opts = resolveOpts({ output: 'file.json', depth: '3', warmup: true });
    expect(opts.output).toBe('file.json');
    expect(opts.depth).toBe('3');
    expect(opts.warmup).toBe(true);
  });
});

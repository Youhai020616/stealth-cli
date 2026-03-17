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

  it('should not override CLI --no-headless (explicit false) with config true', () => {
    setConfigValue('headless', 'true');
    // User passed --no-headless → Commander sets headless=false
    const opts = resolveOpts({ headless: false });
    expect(opts.headless).toBe(false);
  });

  it('should let global config headless=false win over Commander auto-default true', () => {
    setConfigValue('headless', 'false');
    // User did NOT pass --headless or --no-headless → Commander auto-sets headless=true
    const opts = resolveOpts({ headless: true });
    expect(opts.headless).toBe(false); // Global config wins
  });

  it('should use Commander auto-default when global config has no custom value', () => {
    // No custom config set for headless (defaults to true)
    const opts = resolveOpts({ headless: true });
    expect(opts.headless).toBe(true); // Both agree, no conflict
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

  it('should coerce all numeric CLI fields from strings', () => {
    const opts = resolveOpts({
      timeout: '5000',
      delay: '2000',
      wait: '3000',
      depth: '3',
      limit: '50',
      width: '1920',
      height: '1080',
    });
    expect(opts.timeout).toBe(5000);
    expect(opts.delay).toBe(2000);
    expect(opts.wait).toBe(3000);
    expect(opts.depth).toBe(3);
    expect(opts.limit).toBe(50);
    expect(opts.width).toBe(1920);
    expect(opts.height).toBe(1080);
  });

  it('should pass through unknown CLI opts untouched', () => {
    const opts = resolveOpts({ output: 'file.json', warmup: true, selector: '.price' });
    expect(opts.output).toBe('file.json');
    expect(opts.warmup).toBe(true);
    expect(opts.selector).toBe('.price');
  });
});

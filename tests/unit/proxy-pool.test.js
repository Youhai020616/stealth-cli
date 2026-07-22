import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const createBrowser = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/browser-factory.js', () => ({ createBrowser }));

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-proxy-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
vi.resetModules();

const {
  addProxy,
  removeProxy,
  listProxies,
  getNextProxy,
  getRandomProxy,
  poolSize,
  testProxy,
} = await import('../../src/proxy-pool.js');
const PROXIES_FILE = path.join(TEST_HOME, '.stealth', 'proxies.json');

beforeEach(() => {
  createBrowser.mockReset();
  const directory = path.dirname(PROXIES_FILE);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(PROXIES_FILE, JSON.stringify({ proxies: [], lastRotateIndex: 0 }));
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('proxy-pool', () => {
  it('should add and list proxies', () => {
    addProxy('http://proxy1:8080', { label: 'us', region: 'US' });
    addProxy('http://proxy2:8080', { label: 'eu', region: 'EU' });
    const list = listProxies();
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('us');
    expect(list[0].region).toBe('US');
    expect(list[1].label).toBe('eu');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(PROXIES_FILE)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(PROXIES_FILE).mode & 0o777).toBe(0o600);
    }
  });

  it('should reject duplicate proxy', () => {
    addProxy('http://proxy1:8080');
    expect(() => addProxy('http://proxy1:8080')).toThrow('already exists');
  });

  it('should reject invalid proxies without exposing credentials or mutating the pool', () => {
    const invalid = 'HTTP://user:do-not-leak@proxy.example:8080/private';
    let failure;
    try {
      addProxy(invalid);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: 'ProxyError', code: 7 });
    expect(failure.message).not.toContain('do-not-leak');
    expect(poolSize()).toBe(0);
  });

  it('should fail closed on malformed or invalid persisted proxy-pool data', () => {
    fs.writeFileSync(PROXIES_FILE, '{"proxies":', { mode: 0o600 });
    expect(() => listProxies()).toThrow('invalid format');

    const invalid = 'http://user:do-not-leak@proxy.example:8080/private';
    fs.writeFileSync(PROXIES_FILE, JSON.stringify({
      proxies: [{
        url: invalid,
        label: null,
        region: null,
        addedAt: new Date(0).toISOString(),
        lastUsed: null,
        useCount: 0,
        lastStatus: null,
        lastLatency: null,
        failCount: 0,
      }],
      lastRotateIndex: 0,
    }), { mode: 0o600 });

    let failure;
    try {
      listProxies();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: 'ProxyError', code: 7 });
    expect(JSON.stringify(failure)).not.toContain('do-not-leak');
  });

  it('does not replace malformed pool data during a transactional mutation', () => {
    fs.writeFileSync(PROXIES_FILE, '{broken-pool', { mode: 0o600 });
    const before = fs.readFileSync(PROXIES_FILE, 'utf8');

    expect(() => addProxy('http://new-proxy:8080')).toThrow('invalid format');
    expect(fs.readFileSync(PROXIES_FILE, 'utf8')).toBe(before);
  });

  it('should rotate proxies round-robin', () => {
    addProxy('http://a:1');
    addProxy('http://b:2');
    addProxy('http://c:3');

    const first = getNextProxy();
    const second = getNextProxy();
    const third = getNextProxy();
    const fourth = getNextProxy(); // wraps around

    expect(first).toBe('http://a:1');
    expect(second).toBe('http://b:2');
    expect(third).toBe('http://c:3');
    expect(fourth).toBe('http://a:1');
  });

  it('should remove proxy by URL', () => {
    addProxy('http://proxy1:8080');
    expect(poolSize()).toBe(1);
    removeProxy('http://proxy1:8080');
    expect(poolSize()).toBe(0);
  });

  it('should remove proxy by label', () => {
    addProxy('http://proxy1:8080', { label: 'test' });
    removeProxy('test');
    expect(poolSize()).toBe(0);
  });

  it('should return null when pool is empty', () => {
    expect(getNextProxy()).toBeNull();
  });

  it('should get random proxy', () => {
    addProxy('http://a:1');
    addProxy('http://b:2');
    const proxy = getRandomProxy();
    expect(['http://a:1', 'http://b:2']).toContain(proxy);
  });

  it('should return null for random when pool is empty', () => {
    expect(getRandomProxy()).toBeNull();
  });

  it('should normalize uppercase schemes and mask passwords in listed proxies', () => {
    addProxy('HTTP://user:secret@proxy:8080');
    const list = listProxies();
    expect(list[0].url).toBe('http://****@proxy:8080');
    expect(list[0].url).not.toContain('secret');
  });

  it('should track use count', () => {
    addProxy('http://a:1');
    getNextProxy();
    getNextProxy();
    const list = listProxies();
    expect(list[0].useCount).toBe(2);
  });

  it('should redact invalid credentials when proxy testing fails before launch', async () => {
    const result = await testProxy('HTTP://user:do-not-leak@proxy.example:8080/private');

    expect(createBrowser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      proxy: 'invalid proxy',
    });
    expect(result.error).not.toContain('do-not-leak');
  });

  it('should not expose dependency errors or proxy userinfo when testing fails', async () => {
    createBrowser.mockRejectedValue(
      new Error('launch failed password=do-not-leak for http://user:secret@proxy.example:8080'),
    );

    const result = await testProxy('http://api-token:proxy-secret@proxy.example:8080');

    expect(result).toMatchObject({
      ok: false,
      error: 'Proxy connection failed: http://proxy.example:8080',
      proxy: 'http://****@proxy.example:8080',
    });
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
    expect(JSON.stringify(result)).not.toContain('api-token');
    expect(JSON.stringify(result)).not.toContain('proxy-secret');
  });

  it('should test uppercase credentialed IPv6 proxies with normalized Playwright options', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      textContent: vi.fn().mockResolvedValue('{"origin":"203.0.113.10"}'),
    };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    createBrowser.mockResolvedValue(browser);

    const result = await testProxy('HTTP://user:secret@[2001:db8::1]:8080');

    expect(createBrowser).toHaveBeenCalledWith({
      headless: true,
      proxy: {
        server: 'http://[2001:db8::1]:8080',
        username: 'user',
        password: 'secret',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      ip: '203.0.113.10',
      proxy: 'http://****@[2001:db8::1]:8080',
    });
  });
});

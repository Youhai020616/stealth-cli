import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-proxy-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
vi.resetModules();

const {
  addProxy, removeProxy, listProxies, getNextProxy, getRandomProxy, poolSize,
} = await import('../../src/proxy-pool.js');
const PROXIES_FILE = path.join(TEST_HOME, '.stealth', 'proxies.json');

beforeEach(() => {
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
  });

  it('should reject duplicate proxy', () => {
    addProxy('http://proxy1:8080');
    expect(() => addProxy('http://proxy1:8080')).toThrow('already exists');
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

  it('should mask password in listed proxies', () => {
    addProxy('http://user:secret@proxy:8080');
    const list = listProxies();
    expect(list[0].url).toContain('****');
    expect(list[0].url).not.toContain('secret');
  });

  it('should track use count', () => {
    addProxy('http://a:1');
    getNextProxy();
    getNextProxy();
    const list = listProxies();
    expect(list[0].useCount).toBe(2);
  });
});

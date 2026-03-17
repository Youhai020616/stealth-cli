import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addProxy, removeProxy, listProxies, getNextProxy, getRandomProxy, poolSize } from '../../src/proxy-pool.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROXIES_FILE = path.join(os.homedir(), '.stealth', 'proxies.json');
let backup = null;

beforeEach(() => {
  try {
    backup = fs.existsSync(PROXIES_FILE) ? fs.readFileSync(PROXIES_FILE, 'utf-8') : null;
  } catch {}
  // Reset to empty pool
  const dir = path.dirname(PROXIES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROXIES_FILE, JSON.stringify({ proxies: [], lastRotateIndex: 0 }));
});

afterEach(() => {
  if (backup) {
    fs.writeFileSync(PROXIES_FILE, backup);
  } else {
    fs.writeFileSync(PROXIES_FILE, JSON.stringify({ proxies: [], lastRotateIndex: 0 }));
  }
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

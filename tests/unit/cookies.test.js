import { describe, it, expect } from 'vitest';
import { parseCookieFile } from '../../src/cookies.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'cookies.txt');

describe('cookies', () => {
  it('should parse netscape cookie file', () => {
    const cookies = parseCookieFile(FIXTURE);
    expect(cookies.length).toBe(4);
  });

  it('should parse cookie fields correctly', () => {
    const cookies = parseCookieFile(FIXTURE);
    const first = cookies[0];
    expect(first.name).toBe('test_cookie');
    expect(first.value).toBe('test_value');
    expect(first.domain).toBe('.example.com');
    expect(first.path).toBe('/');
    expect(first.secure).toBe(false);
  });

  it('should filter by domain', () => {
    const cookies = parseCookieFile(FIXTURE, 'example.com');
    expect(cookies.length).toBe(3); // 3 example.com cookies, skip other.com
    cookies.forEach((c) => {
      expect(c.domain).toContain('example.com');
    });
  });

  it('should handle secure cookies', () => {
    const cookies = parseCookieFile(FIXTURE);
    const secureCookie = cookies.find((c) => c.name === 'secure_cookie');
    expect(secureCookie).toBeDefined();
    expect(secureCookie.secure).toBe(true);
    expect(secureCookie.path).toBe('/path');
  });

  it('should skip comments and empty lines', () => {
    const cookies = parseCookieFile(FIXTURE);
    const names = cookies.map((c) => c.name);
    expect(names).not.toContain('#');
    expect(names).not.toContain('');
  });
});

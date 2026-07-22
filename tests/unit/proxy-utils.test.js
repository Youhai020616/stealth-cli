import { describe, expect, it } from 'vitest';
import {
  isValidProxyUrl,
  maskProxyUrl,
  parseProxyUrl,
  toPlaywrightProxy,
} from '../../src/utils/proxy.js';

describe('proxy URL utilities', () => {
  it('parses scheme-less and uppercase HTTP(S) proxy URLs consistently', () => {
    expect(parseProxyUrl('proxy.example:8080')).toMatchObject({
      protocol: 'http:',
      host: 'proxy.example:8080',
    });
    expect(parseProxyUrl('HTTP://proxy.example:8080')).toMatchObject({
      protocol: 'http:',
      host: 'proxy.example:8080',
    });
    expect(parseProxyUrl('HTTPS://proxy.example:8443')).toMatchObject({
      protocol: 'https:',
      host: 'proxy.example:8443',
    });
  });

  it('builds Playwright proxy options with credentials and URL host normalization', () => {
    expect(toPlaywrightProxy('HTTP://user:secret@proxy.example:80')).toEqual({
      server: 'http://proxy.example',
      username: 'user',
      password: 'secret',
    });
    expect(toPlaywrightProxy('http://user%40example.com:p%40ss%3Aword@proxy.example:8080')).toEqual({
      server: 'http://proxy.example:8080',
      username: 'user@example.com',
      password: 'p@ss:word',
    });
    expect(toPlaywrightProxy('https://[2001:db8::1]:8443')).toEqual({
      server: 'https://[2001:db8::1]:8443',
      username: undefined,
      password: undefined,
    });
    expect(toPlaywrightProxy('HTTPS://[2001:db8::2]:443')).toEqual({
      server: 'https://[2001:db8::2]',
      username: undefined,
      password: undefined,
    });
  });

  it.each([
    null,
    '',
    'ftp://proxy.example:21',
    'http://proxy.example:8080/path',
    'http://proxy.example:8080?token=secret',
    'http://proxy.example:8080#secret',
    'http://',
    'http://user%ZZ:secret@proxy.example:8080',
  ])('rejects an invalid proxy URL without partial acceptance: %j', (value) => {
    expect(isValidProxyUrl(value)).toBe(false);
    expect(() => parseProxyUrl(value)).toThrow('Invalid proxy URL format');
  });

  it('masks valid credentials and never echoes invalid credential-bearing input', () => {
    expect(maskProxyUrl('HTTP://user:secret@proxy.example:8080'))
      .toBe('http://****@proxy.example:8080');
    expect(maskProxyUrl('http://api-token@proxy.example:8080'))
      .toBe('http://****@proxy.example:8080');

    const invalid = 'HTTP://user:do-not-leak@proxy.example:8080/private';
    const masked = maskProxyUrl(invalid);
    expect(masked).toBe('invalid proxy');
    expect(masked).not.toContain('do-not-leak');
    expect(masked).not.toBe(invalid);
  });
});

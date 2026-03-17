import { describe, it, expect } from 'vitest';
import { getHostOS, TEXT_EXTRACT_SCRIPT } from '../../src/utils/browser-factory.js';

describe('browser-factory', () => {
  it('getHostOS should return valid OS string', () => {
    const os = getHostOS();
    expect(['macos', 'windows', 'linux']).toContain(os);
  });

  it('TEXT_EXTRACT_SCRIPT should be a non-empty string', () => {
    expect(typeof TEXT_EXTRACT_SCRIPT).toBe('string');
    expect(TEXT_EXTRACT_SCRIPT.length).toBeGreaterThan(10);
    expect(TEXT_EXTRACT_SCRIPT).toContain('cloneNode');
    expect(TEXT_EXTRACT_SCRIPT).toContain('script');
  });

  it('TEXT_EXTRACT_SCRIPT should be a self-invoking function', () => {
    // It should be an IIFE so it can be passed directly to page.evaluate()
    expect(TEXT_EXTRACT_SCRIPT.trim()).toMatch(/^\(\s*\(\)\s*=>/);
    expect(TEXT_EXTRACT_SCRIPT.trim()).toMatch(/\)\s*$/);
  });
});

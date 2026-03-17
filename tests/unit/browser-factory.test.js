import { describe, it, expect } from 'vitest';
import { getHostOS, extractPageText } from '../../src/utils/browser-factory.js';

describe('browser-factory', () => {
  it('getHostOS should return valid OS string', () => {
    const os = getHostOS();
    expect(['macos', 'windows', 'linux']).toContain(os);
  });

  it('extractPageText should be a function', () => {
    expect(typeof extractPageText).toBe('function');
  });

  it('extractPageText source should reference DOM APIs', () => {
    const src = extractPageText.toString();
    expect(src).toContain('cloneNode');
    expect(src).toContain('script');
    expect(src).toContain('innerText');
  });
});

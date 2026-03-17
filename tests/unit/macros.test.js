import { describe, it, expect } from 'vitest';
import { expandMacro, getSupportedEngines } from '../../src/macros.js';

describe('macros', () => {
  it('should return supported engines', () => {
    const engines = getSupportedEngines();
    expect(engines).toContain('google');
    expect(engines).toContain('duckduckgo');
    expect(engines).toContain('bing');
    expect(engines).toContain('github');
    expect(engines).toContain('youtube');
    expect(engines.length).toBeGreaterThanOrEqual(14);
  });

  it('should expand google macro', () => {
    const url = expandMacro('google', 'test query');
    expect(url).toBe('https://www.google.com/search?q=test%20query');
  });

  it('should expand duckduckgo macro', () => {
    const url = expandMacro('duckduckgo', 'hello world');
    expect(url).toBe('https://duckduckgo.com/?q=hello%20world');
  });

  it('should expand bing macro', () => {
    const url = expandMacro('bing', 'test');
    expect(url).toBe('https://www.bing.com/search?q=test');
  });

  it('should expand github macro', () => {
    const url = expandMacro('github', 'camoufox');
    expect(url).toContain('github.com/search');
    expect(url).toContain('camoufox');
  });

  it('should return null for unknown engine', () => {
    expect(expandMacro('nonexistent', 'test')).toBeNull();
  });

  it('should handle special characters in query', () => {
    const url = expandMacro('google', 'hello & goodbye <tag>');
    expect(url).toContain('hello%20%26%20goodbye');
  });

  it('should handle empty query', () => {
    const url = expandMacro('google', '');
    expect(url).toBe('https://www.google.com/search?q=');
  });
});

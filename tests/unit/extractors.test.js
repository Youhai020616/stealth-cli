import { describe, it, expect } from 'vitest';
import { getExtractorByEngine, getExtractorByUrl, listExtractors } from '../../src/extractors/index.js';

describe('extractors', () => {
  it('should list all extractors', () => {
    const list = listExtractors();
    expect(list).toContain('google');
    expect(list).toContain('duckduckgo');
    expect(list).toContain('bing');
    expect(list).toContain('github');
    expect(list).toContain('youtube');
    expect(list).toContain('generic');
  });

  it('should get extractor by engine name', () => {
    expect(getExtractorByEngine('google').name).toBe('google');
    expect(getExtractorByEngine('duckduckgo').name).toBe('duckduckgo');
    expect(getExtractorByEngine('bing').name).toBe('bing');
    expect(getExtractorByEngine('github').name).toBe('github');
    expect(getExtractorByEngine('youtube').name).toBe('youtube');
  });

  it('should fallback to generic for unknown engine', () => {
    expect(getExtractorByEngine('yahoo').name).toBe('generic');
    expect(getExtractorByEngine('nonexistent').name).toBe('generic');
  });

  it('should get extractor by URL', () => {
    expect(getExtractorByUrl('https://www.google.com/search?q=test').name).toBe('google');
    expect(getExtractorByUrl('https://duckduckgo.com/?q=test').name).toBe('duckduckgo');
    expect(getExtractorByUrl('https://www.bing.com/search?q=test').name).toBe('bing');
    expect(getExtractorByUrl('https://github.com/search?q=test').name).toBe('github');
    expect(getExtractorByUrl('https://www.youtube.com/results?search_query=test').name).toBe('youtube');
  });

  it('should fallback to generic for unknown URL', () => {
    expect(getExtractorByUrl('https://example.com').name).toBe('generic');
  });

  it('each extractor should have required methods', () => {
    const engines = ['google', 'duckduckgo', 'bing', 'github', 'youtube'];
    for (const engine of engines) {
      const ext = getExtractorByEngine(engine);
      expect(typeof ext.canHandle).toBe('function');
      expect(typeof ext.extractResults).toBe('function');
      expect(typeof ext.waitForResults).toBe('function');
      expect(typeof ext.name).toBe('string');
    }
  });
});

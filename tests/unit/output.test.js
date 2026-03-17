import { describe, it, expect } from 'vitest';
import { formatOutput } from '../../src/output.js';

describe('output', () => {
  it('should format as JSON', () => {
    const result = formatOutput({ name: 'test', value: 42 }, 'json');
    const parsed = JSON.parse(result);
    expect(parsed.name).toBe('test');
    expect(parsed.value).toBe(42);
  });

  it('should format as JSONL for arrays', () => {
    const result = formatOutput([{ a: 1 }, { b: 2 }], 'jsonl');
    const lines = result.split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).a).toBe(1);
    expect(JSON.parse(lines[1]).b).toBe(2);
  });

  it('should format string as text', () => {
    expect(formatOutput('hello', 'text')).toBe('hello');
  });

  it('should format object as text (JSON stringified)', () => {
    const result = formatOutput({ key: 'val' }, 'text');
    expect(result).toContain('key');
    expect(result).toContain('val');
  });

  it('should format as markdown with links', () => {
    const data = [
      { title: 'Example', url: 'https://example.com', text: 'A test' },
      { title: 'Test', url: 'https://test.com' },
    ];
    const result = formatOutput(data, 'markdown');
    expect(result).toContain('[Example](https://example.com)');
    expect(result).toContain('[Test](https://test.com)');
  });
});

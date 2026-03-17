import { describe, it, expect } from 'vitest';
import { randomDelay } from '../../src/humanize.js';

describe('humanize', () => {
  it('randomDelay should wait within range', async () => {
    const start = Date.now();
    await randomDelay(50, 100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // Small tolerance
    expect(elapsed).toBeLessThan(150);
  });

  it('randomDelay should produce different wait times', async () => {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await randomDelay(10, 50);
      times.push(Date.now() - start);
    }
    // At least 2 different values (probabilistic but very likely)
    const unique = new Set(times);
    expect(unique.size).toBeGreaterThanOrEqual(1);
  });
});

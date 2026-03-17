import { describe, it, expect } from 'vitest';
import { withRetry } from '../../src/retry.js';

describe('retry', () => {
  it('should return result on first success', async () => {
    const result = await withRetry(() => 'ok', { maxRetries: 3 });
    expect(result).toBe('ok');
  });

  it('should retry on failure and eventually succeed', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) throw new Error('timeout: fail');
        return 'success';
      },
      { maxRetries: 3, baseDelay: 10 },
    );
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('should throw after max retries', async () => {
    await expect(
      withRetry(
        () => { throw new Error('timeout: always fails'); },
        { maxRetries: 2, baseDelay: 10 },
      ),
    ).rejects.toThrow('always fails');
  });

  it('should not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw new Error('invalid argument');
        },
        { maxRetries: 3, baseDelay: 10 },
      ),
    ).rejects.toThrow('invalid argument');
    expect(attempts).toBe(1); // No retry for non-retryable
  });

  it('should call onRetry callback', async () => {
    let retryCount = 0;
    let attempts = 0;
    await withRetry(
      () => {
        attempts++;
        if (attempts < 2) throw new Error('timeout');
        return 'ok';
      },
      {
        maxRetries: 3,
        baseDelay: 10,
        onRetry: () => { retryCount++; },
      },
    );
    expect(retryCount).toBe(1);
  });

  it('should support custom shouldRetry function', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw new Error('custom error');
        },
        {
          maxRetries: 5,
          baseDelay: 10,
          shouldRetry: (err) => err.message.includes('retry-this'),
        },
      ),
    ).rejects.toThrow('custom error');
    expect(attempts).toBe(1); // Custom check says don't retry
  });
});

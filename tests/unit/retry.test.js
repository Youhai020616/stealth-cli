import { describe, it, expect, vi } from 'vitest';
import { withRetry, navigateWithRetry } from '../../src/retry.js';
import { log } from '../../src/output.js';

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

  it('should not log raw navigation URLs or dependency error messages while retrying', async () => {
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'dim').mockImplementation(() => {});
    const page = {
      goto: vi.fn().mockRejectedValue(
        new Error('page.goto: Timeout at https://user:password@example.com/callback?token=secret password=hidden'),
      ),
      url: vi.fn(),
    };

    await expect(navigateWithRetry(
      page,
      'https://user:password@example.com/callback?token=secret',
      { maxRetries: 1, baseDelay: 0 },
    )).rejects.toThrow('password=hidden');

    const output = warning.mock.calls.flat().join(' ');
    expect(output).toContain('navigate to https://example.com');
    expect(output).not.toContain('user:password');
    expect(output).not.toContain('token=secret');
    expect(output).not.toContain('password=hidden');
    vi.restoreAllMocks();
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

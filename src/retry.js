/**
 * Retry mechanism with exponential backoff
 */

import { log } from './output.js';

/**
 * Retryable error types
 */
const RETRYABLE_PATTERNS = [
  'timeout',
  'net::ERR_',
  'Navigation failed',
  'Target closed',
  'Session closed',
  'Connection refused',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'page.goto: Timeout',
  'frame was detached',
  'browser has disconnected',
];

/**
 * Check if an error is retryable
 */
function isRetryable(err) {
  const msg = err.message || String(err);
  return RETRYABLE_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}

/**
 * Execute a function with retry logic
 *
 * @param {Function} fn - Async function to execute
 * @param {object} opts
 * @param {number} [opts.maxRetries=3] - Maximum retry attempts
 * @param {number} [opts.baseDelay=1000] - Base delay in ms (doubles each retry)
 * @param {number} [opts.maxDelay=10000] - Maximum delay between retries
 * @param {string} [opts.label='operation'] - Label for log messages
 * @param {Function} [opts.shouldRetry] - Custom retry check (receives error)
 * @param {Function} [opts.onRetry] - Callback before each retry (receives { error, attempt, delay })
 * @returns {Promise<*>} Result of fn
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    label = 'operation',
    shouldRetry = isRetryable,
    onRetry,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Don't retry if max attempts reached
      if (attempt >= maxRetries) break;

      // Don't retry if error is not retryable
      if (!shouldRetry(err)) {
        break;
      }

      // Calculate delay with exponential backoff + jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = Math.random() * baseDelay * 0.5;
      const delay = Math.min(exponentialDelay + jitter, maxDelay);

      log.warn(`${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      log.dim(`  Retrying in ${Math.round(delay)}ms...`);

      if (onRetry) {
        await onRetry({ error: err, attempt: attempt + 1, delay });
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Navigate to URL with automatic retry
 */
export async function navigateWithRetry(page, url, opts = {}) {
  const { timeout = 30000, waitUntil = 'domcontentloaded', maxRetries = 2, ...retryOpts } = opts;

  return withRetry(
    async () => {
      await page.goto(url, { waitUntil, timeout });
      return page.url();
    },
    {
      maxRetries,
      label: `navigate to ${url.slice(0, 60)}`,
      ...retryOpts,
    },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

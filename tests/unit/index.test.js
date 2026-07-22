import { describe, expect, it } from 'vitest';
import {
  BrowserCleanupError,
  PersistenceError,
  checkpointBrowserState,
  retryBrowserLaunchCleanup,
} from '../../src/index.js';

describe('public SDK entrypoint', () => {
  it('exports handle-scoped checkpointing and documented strict-close errors', () => {
    expect(checkpointBrowserState).toBeTypeOf('function');
    expect(retryBrowserLaunchCleanup).toBeTypeOf('function');
    expect(new PersistenceError('save failed')).toBeInstanceOf(PersistenceError);
    expect(new BrowserCleanupError()).toBeInstanceOf(BrowserCleanupError);
  });
});

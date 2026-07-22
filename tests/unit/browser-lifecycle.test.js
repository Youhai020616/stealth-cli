import { EventEmitter } from 'events';
import { describe, it, expect, vi } from 'vitest';
import {
  createBrowserLifecycle,
  createLaunchSignalGuard,
} from '../../src/browser-lifecycle.js';

class MockPage extends EventEmitter {
  constructor(url = 'about:blank') {
    super();
    this.currentUrl = url;
    this.closed = false;
  }

  url() {
    return this.currentUrl;
  }

  isClosed() {
    return this.closed;
  }

  mainFrame() {
    return this;
  }

  closePage() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

class MockContext extends EventEmitter {
  constructor(pages = []) {
    super();
    this.pageList = pages;
  }

  pages() {
    return this.pageList;
  }

  addPage(page) {
    this.pageList.push(page);
    this.emit('page', page);
  }

  closeContext() {
    this.emit('close');
  }
}

class MockBrowser extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
  }

  isConnected() {
    return this.connected;
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnected');
  }
}

function createHarness(opts = {}) {
  const page = new MockPage('https://example.com');
  const context = new MockContext([page]);
  const browser = new MockBrowser();
  const handle = {
    browser,
    context,
    page,
    isDaemon: false,
    _meta: {
      profileName: opts.profile === false ? null : 'work',
      sessionName: opts.session ? 'login' : null,
      lastKnownUrl: page.url(),
    },
  };
  const captureState = opts.captureState || vi.fn(async () => ({
    cookies: [{ name: 'sid', value: '123' }],
    lastUrl: handle._meta.lastKnownUrl,
    capturedAt: new Date().toISOString(),
  }));
  const writeSnapshot = opts.writeSnapshot || vi.fn(async (_handle, snapshot) => ({
    snapshot,
    results: {
      profile: handle._meta.profileName
        ? { name: handle._meta.profileName, cookies: snapshot.cookies.length }
        : null,
      session: null,
    },
  }));
  const close = opts.close || vi.fn(async () => ({
    persistence: null,
    persistenceError: null,
    cleanupErrors: [],
  }));
  const signalEmitter = new EventEmitter();
  const lifecycle = createBrowserLifecycle(handle, {
    checkpointInterval: 60_000,
    signalEmitter,
    captureState,
    writeSnapshot,
    close,
    onCheckpointError: opts.onCheckpointError,
  });

  return {
    page,
    context,
    browser,
    handle,
    captureState,
    writeSnapshot,
    close,
    signalEmitter,
    lifecycle,
  };
}

describe('launch signal guard', () => {
  it('should transfer a signal received during launch to the lifecycle', async () => {
    const signalEmitter = new EventEmitter();
    const guard = createLaunchSignalGuard({ signalEmitter });
    const lifecycle = {
      start: vi.fn(),
      requestExit: vi.fn().mockResolvedValue(undefined),
    };

    signalEmitter.emit('SIGTERM');
    await guard.transferTo(lifecycle);

    expect(lifecycle.start).toHaveBeenCalledOnce();
    expect(lifecycle.requestExit).toHaveBeenCalledWith('signal', { signal: 'SIGTERM' });
    expect(signalEmitter.listenerCount('SIGTERM')).toBe(0);
  });

  it('should treat a second launch-time signal as force-exit intent', () => {
    const signalEmitter = new EventEmitter();
    const onForceExit = vi.fn();
    const guard = createLaunchSignalGuard({ signalEmitter, onForceExit });

    signalEmitter.emit('SIGINT');
    signalEmitter.emit('SIGINT');

    expect(onForceExit).toHaveBeenCalledWith('SIGINT', 130);
    guard.dispose();
  });
});

describe('browser lifecycle', () => {
  it('should finalize when the last page closes and save a fresh snapshot', async () => {
    const harness = createHarness();
    harness.lifecycle.start();

    harness.page.closePage();
    const result = await harness.lifecycle.wait();

    expect(result.reason).toBe('last-page-closed');
    expect(result.usedCheckpointFallback).toBe(false);
    expect(harness.captureState).toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.close).toHaveBeenCalledWith(harness.handle, { persist: false });
  });

  it('should keep running while another popup remains open', async () => {
    const harness = createHarness();
    const popup = new MockPage('https://example.com/popup');
    harness.lifecycle.start();
    harness.context.addPage(popup);

    harness.page.closePage();
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.lifecycle.phase).toBe('running');

    popup.closePage();
    const result = await harness.lifecycle.wait();
    expect(result.reason).toBe('last-page-closed');
  });

  it('should detach closed popup listeners immediately and ignore repeated close events', async () => {
    const harness = createHarness();
    const popup = new MockPage('https://example.com/popup');
    harness.lifecycle.start();
    harness.context.addPage(popup);

    expect(popup.listenerCount('close')).toBe(1);
    expect(popup.listenerCount('framenavigated')).toBe(1);

    popup.closePage();
    expect(popup.listenerCount('close')).toBe(0);
    expect(popup.listenerCount('framenavigated')).toBe(0);

    popup.emit('close');
    popup.emit('framenavigated', popup);
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.lifecycle.phase).toBe('running');

    harness.page.closePage();
    const result = await harness.lifecycle.wait();
    expect(result.reason).toBe('last-page-closed');
  });

  it('should track pages created after lifecycle startup', async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    const popup = new MockPage('https://example.com/popup');
    harness.context.addPage(popup);

    harness.page.closePage();
    popup.closePage();
    await harness.lifecycle.wait();

    expect(popup.listenerCount('close')).toBe(0);
    expect(harness.context.listenerCount('page')).toBe(0);
  });

  it('should use the latest durable checkpoint after a hard disconnect', async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await harness.lifecycle.checkpoint();
    const capturesBeforeDisconnect = harness.captureState.mock.calls.length;

    harness.browser.disconnect();
    const result = await harness.lifecycle.wait();

    expect(result.reason).toBe('disconnected');
    expect(result.usedCheckpointFallback).toBe(true);
    expect(result.persistenceIncomplete).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(harness.captureState).toHaveBeenCalledTimes(capturesBeforeDisconnect);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('should report capture failures and clear the error after a retry succeeds', async () => {
    const captureState = vi.fn()
      .mockRejectedValueOnce(new Error('capture unavailable'))
      .mockResolvedValue({
        cookies: [],
        lastUrl: 'https://example.com',
        capturedAt: new Date().toISOString(),
      });
    const onCheckpointError = vi.fn();
    const harness = createHarness({ captureState, onCheckpointError });
    harness.lifecycle.start();

    await new Promise((resolve) => setImmediate(resolve));
    expect(onCheckpointError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'capture unavailable',
    }));
    expect(harness.lifecycle.getState().lastCheckpointError?.message).toBe('capture unavailable');

    await harness.lifecycle.checkpoint();
    expect(harness.lifecycle.getState().lastCheckpointError).toBeNull();
    harness.signalEmitter.emit('SIGINT');
    await harness.lifecycle.wait();
  });

  it('should not emit an unhandled rejection when finalization fails before wait', async () => {
    const captureState = vi.fn().mockRejectedValue(new Error('capture unavailable'));
    const harness = createHarness({ captureState });
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    try {
      harness.lifecycle.start();
      harness.context.closeContext();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(harness.lifecycle.wait()).rejects.toThrow('capture unavailable');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('should use a durable checkpoint when the context closes', async () => {
    const harness = createHarness();
    harness.lifecycle.start();
    await harness.lifecycle.checkpoint();

    harness.context.closeContext();
    const result = await harness.lifecycle.wait();

    expect(result.reason).toBe('context-closed');
    expect(result.usedCheckpointFallback).toBe(true);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('should retry writing a captured snapshot after disconnect', async () => {
    const writeSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('temporary disk failure'))
      .mockResolvedValue({
        results: { profile: { name: 'work', cookies: 1 }, session: null },
      });
    const harness = createHarness({ writeSnapshot });
    harness.lifecycle.start();

    await new Promise((resolve) => setImmediate(resolve));
    expect(writeSnapshot).toHaveBeenCalledOnce();

    harness.browser.disconnect();
    const result = await harness.lifecycle.wait();

    expect(writeSnapshot).toHaveBeenCalledTimes(2);
    expect(result.persistence.profile.cookies).toBe(1);
  });

  it('should treat a successful cached retry as a fresh final save', async () => {
    const writeSnapshot = vi.fn()
      .mockResolvedValueOnce({
        results: { profile: { name: 'work', cookies: 1 }, session: null },
      })
      .mockRejectedValueOnce(new Error('temporary final write failure'))
      .mockResolvedValueOnce({
        results: { profile: { name: 'work', cookies: 1 }, session: null },
      });
    const harness = createHarness({ writeSnapshot });
    harness.lifecycle.start();
    await new Promise((resolve) => setImmediate(resolve));

    harness.page.closePage();
    const result = await harness.lifecycle.wait();

    expect(writeSnapshot).toHaveBeenCalledTimes(3);
    expect(result.usedCheckpointFallback).toBe(false);
    expect(result.persistenceIncomplete).toBe(false);
    expect(result.finalCaptureError).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it('should fail when a fresh final capture is unavailable despite a stale checkpoint', async () => {
    const durableSnapshot = {
      cookies: [{ name: 'sid', value: 'checkpoint' }],
      lastUrl: 'https://example.com',
      capturedAt: new Date().toISOString(),
    };
    const captureState = vi.fn()
      .mockResolvedValueOnce(durableSnapshot)
      .mockRejectedValueOnce(new Error('final capture unavailable'));
    const harness = createHarness({ captureState });
    harness.lifecycle.start();
    await new Promise((resolve) => setImmediate(resolve));

    harness.page.closePage();
    const result = await harness.lifecycle.wait();

    expect(result.usedCheckpointFallback).toBe(true);
    expect(result.persistenceIncomplete).toBe(true);
    expect(result.finalCaptureError?.message).toBe('final capture unavailable');
    expect(result.exitCode).toBe(8);
    expect(result.persistedAt).not.toBeNull();
  });

  it('should finalize exactly once when signal and page close race', async () => {
    const harness = createHarness();
    harness.lifecycle.start();

    harness.signalEmitter.emit('SIGINT');
    harness.page.closePage();
    harness.browser.disconnect();
    const result = await harness.lifecycle.wait();

    expect(result.reason).toBe('signal');
    expect(result.exitCode).toBe(130);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it('should handle SIGHUP with the conventional exit code', async () => {
    const harness = createHarness();
    harness.lifecycle.start();

    harness.signalEmitter.emit('SIGHUP');
    const result = await harness.lifecycle.wait();

    expect(result.reason).toBe('signal');
    expect(result.exitCode).toBe(129);
  });

  it('should report cleanup failures with a non-zero exit code', async () => {
    const close = vi.fn(async () => ({
      cleanupErrors: [{ target: 'browser', error: new Error('still connected') }],
    }));
    const harness = createHarness({ close });
    harness.lifecycle.start();

    harness.page.closePage();
    const result = await harness.lifecycle.wait();

    expect(result.exitCode).toBe(1);
    expect(result.cleanupErrors[0].target).toBe('browser');
  });

  it('should combine persistence and cleanup failures without hiding either', async () => {
    const captureState = vi.fn().mockRejectedValue(new Error('persistence failed'));
    const close = vi.fn(async () => ({
      cleanupErrors: [{ target: 'browser', error: new Error('still connected') }],
    }));
    const harness = createHarness({ captureState, close });
    harness.lifecycle.start();
    harness.context.closeContext();

    let failure;
    try {
      await harness.lifecycle.wait();
    } catch (error) {
      failure = error;
    }

    expect(failure.message).toContain('persistence failed');
    expect(failure.message).toContain('cleanup also failed');
    expect(failure.cleanupFailures).toEqual([{ target: 'browser' }]);
  });

  it('should coalesce slow checkpoints and run a fresh final checkpoint', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst;
    let callCount = 0;
    const firstCapture = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const captureState = vi.fn(async () => {
      callCount += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (callCount === 1) await firstCapture;
      active -= 1;
      return {
        cookies: [],
        lastUrl: 'https://example.com',
        capturedAt: new Date().toISOString(),
      };
    });
    const harness = createHarness({ captureState });
    harness.lifecycle.start();

    const pendingA = harness.lifecycle.checkpoint();
    const pendingB = harness.lifecycle.checkpoint();
    harness.signalEmitter.emit('SIGTERM');
    releaseFirst();

    await Promise.allSettled([pendingA, pendingB]);
    const result = await harness.lifecycle.wait();

    expect(maxActive).toBe(1);
    expect(captureState.mock.calls.length).toBe(3);
    expect(result.exitCode).toBe(143);
  });
});

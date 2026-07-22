import {
  captureBrowserState,
  closeBrowser,
  writeBrowserStateSnapshot,
} from './browser.js';
import { PersistenceError } from './errors.js';

export const DEFAULT_CHECKPOINT_INTERVAL = 1000;

export const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function attachLifecycleResult(error, result) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
  Object.defineProperty(error, 'lifecycleResult', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: result,
  });
  return error;
}

/**
 * Convert an incomplete command-error finalization result into one hidden
 * cleanup failure while retaining the complete lifecycle evidence.
 */
export function createLifecyclePersistenceCleanupFailure(result) {
  if (
    !result
    || !(
      result.persistenceIncomplete
      || result.exitCode === 8
      || result.finalCaptureError
    )
  ) {
    return null;
  }

  const cleanupFailures = Array.isArray(result.cleanupErrors)
    ? result.cleanupErrors
    : [];
  const error = new PersistenceError('Browser state finalization was incomplete', {
    cause: result.finalCaptureError || result.cleanup?.persistenceError || null,
    cleanupFailures,
    results: result.persistence || null,
    snapshotMetadata: {
      persistedAt: result.persistedAt || null,
      usedCheckpointFallback: Boolean(result.usedCheckpointFallback),
      persistenceIncomplete: Boolean(result.persistenceIncomplete),
    },
  });
  attachLifecycleResult(error, result);
  return { target: 'persistence', error };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Own process signals during asynchronous browser launch, before a browser
 * handle exists. The first signal is transferred to the lifecycle coordinator;
 * a second signal is treated as an explicit force-exit request.
 *
 * @param {object} [opts]
 * @param {NodeJS.EventEmitter} [opts.signalEmitter=process]
 * @param {(signal: string, exitCode: number) => void} [opts.onForceExit]
 */
export function createLaunchSignalGuard(opts = {}) {
  const { signalEmitter = process } = opts;
  const onForceExit = opts.onForceExit || ((signal, exitCode) => {
    if (signalEmitter === process) process.exit(exitCode);
  });
  const listeners = new Map();
  let pendingSignal = null;
  let disposed = false;

  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    const listener = () => {
      if (!pendingSignal) {
        pendingSignal = signal;
        return;
      }
      onForceExit(signal, SIGNAL_EXIT_CODES[signal] || 1);
    };
    signalEmitter.on(signal, listener);
    listeners.set(signal, listener);
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners) {
      if (typeof signalEmitter.removeListener === 'function') {
        signalEmitter.removeListener(signal, listener);
      } else if (typeof signalEmitter.off === 'function') {
        signalEmitter.off(signal, listener);
      }
    }
    listeners.clear();
  };

  return {
    dispose,
    transferTo(lifecycle) {
      dispose();
      lifecycle.start();
      if (pendingSignal) {
        return lifecycle.requestExit('signal', { signal: pendingSignal });
      }
      return null;
    },
    get pendingSignal() {
      return pendingSignal;
    },
    get exitCode() {
      return pendingSignal ? SIGNAL_EXIT_CODES[pendingSignal] || 1 : 0;
    },
  };
}

/**
 * Coordinate browser lifetime and authentication-state persistence.
 *
 * State transitions are exactly-once: IDLE -> RUNNING -> FINALIZING -> CLOSED.
 * The coordinator owns every listener/timer it installs and coalesces checkpoint
 * requests to at most one active operation plus one pending operation.
 *
 * @param {object} handle Direct browser handle from launchBrowser()
 * @param {object} [opts]
 * @param {number} [opts.checkpointInterval=1000]
 * @param {NodeJS.EventEmitter} [opts.signalEmitter=process]
 * @param {(error: Error) => void} [opts.onCheckpointError]
 * @param {(handle: object) => Promise<object>} [opts.captureState]
 * @param {(handle: object, snapshot: object) => Promise<object>} [opts.writeSnapshot]
 * @param {(handle: object, opts: object) => Promise<object>} [opts.close]
 */
export function createBrowserLifecycle(handle, opts = {}) {
  if (!handle || handle.isDaemon || !handle.browser || !handle.context) {
    throw new Error('Browser lifecycle requires a direct browser handle');
  }

  const {
    checkpointInterval = DEFAULT_CHECKPOINT_INTERVAL,
    signalEmitter = process,
    onCheckpointError = () => {},
    captureState = captureBrowserState,
    writeSnapshot = writeBrowserStateSnapshot,
    close = closeBrowser,
  } = opts;

  const { browser, context } = handle;
  const hasPersistenceTarget = Boolean(
    handle._meta?.profileName || handle._meta?.sessionName,
  );
  const interval = Number.isFinite(checkpointInterval)
    ? Math.max(250, checkpointInterval)
    : DEFAULT_CHECKPOINT_INTERVAL;

  let phase = 'idle';
  let contextClosed = false;
  let checkpointTimer = null;
  let activeCheckpoint = null;
  let queuedCheckpoint = null;
  let acceptingCheckpoints = true;
  let latestCaptured = null;
  let latestPersisted = null;
  let lastCheckpointError = null;
  let finalization = null;
  const completion = deferred();
  // Commands may still be loading cookies or navigating when finalization starts.
  // Mark the deferred as observed immediately while wait() continues to return
  // the original rejecting promise to its eventual caller.
  completion.promise.catch(() => {});
  const pageListeners = new Map();
  const signalListeners = new Map();

  const safeNotifyCheckpointError = (error) => {
    lastCheckpointError = { error, at: new Date().toISOString() };
    try {
      onCheckpointError(error);
    } catch {}
  };

  const performCheckpoint = async () => {
    try {
      const snapshot = await captureState(handle);
      latestCaptured = snapshot;
      const result = await writeSnapshot(handle, snapshot);
      latestPersisted = {
        snapshot,
        result,
        persistedAt: new Date().toISOString(),
      };
      lastCheckpointError = null;
      return result;
    } catch (error) {
      safeNotifyCheckpointError(error);
      throw error;
    }
  };

  const launchCheckpoint = () => {
    const operation = performCheckpoint();
    activeCheckpoint = operation;

    const settle = () => {
      if (activeCheckpoint === operation) activeCheckpoint = null;
      if (queuedCheckpoint) {
        const queued = queuedCheckpoint;
        queuedCheckpoint = null;
        const next = launchCheckpoint();
        next.then(queued.resolve, queued.reject);
      }
    };

    operation.then(settle, settle);
    return operation;
  };

  const requestCheckpoint = () => {
    if (!hasPersistenceTarget || !acceptingCheckpoints) {
      return Promise.resolve(latestPersisted?.result || null);
    }
    if (!activeCheckpoint) return launchCheckpoint();
    if (!queuedCheckpoint) queuedCheckpoint = deferred();
    return queuedCheckpoint.promise;
  };

  const drainCheckpoints = async () => {
    while (activeCheckpoint || queuedCheckpoint) {
      const pending = queuedCheckpoint?.promise || activeCheckpoint;
      await pending.catch(() => {});
    }
  };

  const removeListener = (emitter, event, listener) => {
    if (typeof emitter?.removeListener === 'function') {
      emitter.removeListener(event, listener);
    } else if (typeof emitter?.off === 'function') {
      emitter.off(event, listener);
    }
  };

  const updateLastKnownUrl = (page) => {
    try {
      const url = page.url();
      if (url && url !== 'about:blank' && handle._meta) {
        handle._meta.lastKnownUrl = url;
      }
    } catch {}
  };

  const getOpenPages = () => {
    try {
      return context.pages().filter((page) => {
        try {
          return typeof page.isClosed !== 'function' || !page.isClosed();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  };

  let requestExit;

  const checkForLastPage = () => {
    queueMicrotask(() => {
      if (phase !== 'running') return;
      if (getOpenPages().length === 0) {
        void requestExit('last-page-closed');
      }
    });
  };

  const bindPage = (page) => {
    if (!page || pageListeners.has(page)) return;

    const onFrameNavigated = (frame) => {
      try {
        if (typeof page.mainFrame !== 'function' || frame === page.mainFrame()) {
          updateLastKnownUrl(page);
        }
      } catch {}
    };
    const onClose = () => {
      removeListener(page, 'close', onClose);
      removeListener(page, 'framenavigated', onFrameNavigated);
      pageListeners.delete(page);
      checkForLastPage();
    };

    page.on('close', onClose);
    page.on('framenavigated', onFrameNavigated);
    pageListeners.set(page, { onClose, onFrameNavigated });
    updateLastKnownUrl(page);
  };

  const onPage = (page) => bindPage(page);
  const onContextClose = () => {
    contextClosed = true;
    void requestExit('context-closed');
  };
  const onDisconnected = () => void requestExit('disconnected');

  const disposeListeners = () => {
    removeListener(context, 'page', onPage);
    removeListener(context, 'close', onContextClose);
    removeListener(browser, 'disconnected', onDisconnected);

    for (const [page, listeners] of pageListeners) {
      removeListener(page, 'close', listeners.onClose);
      removeListener(page, 'framenavigated', listeners.onFrameNavigated);
    }
    pageListeners.clear();

    for (const [signal, listener] of signalListeners) {
      removeListener(signalEmitter, signal, listener);
    }
    signalListeners.clear();
  };

  const browserIsConnected = () => {
    if (contextClosed) return false;
    try {
      return typeof browser.isConnected !== 'function' || browser.isConnected();
    } catch {
      return false;
    }
  };

  const persistCachedSnapshot = async () => {
    if (!latestCaptured || latestPersisted?.snapshot === latestCaptured) return;

    try {
      const result = await writeSnapshot(handle, latestCaptured);
      latestPersisted = {
        snapshot: latestCaptured,
        result,
        persistedAt: new Date().toISOString(),
      };
      lastCheckpointError = null;
    } catch (error) {
      safeNotifyCheckpointError(error);
    }
  };

  const finalize = async (reason, details = {}) => {
    acceptingCheckpoints = false;
    if (checkpointTimer) {
      clearInterval(checkpointTimer);
      checkpointTimer = null;
    }
    disposeListeners();

    await drainCheckpoints();

    let finalCaptureError = null;
    let finalSnapshot = null;
    const canCaptureFresh = [
      'last-page-closed',
      'readline-closed',
      'signal',
      'command-error',
    ].includes(reason) && browserIsConnected();

    if (hasPersistenceTarget && canCaptureFresh) {
      const previousSnapshot = latestCaptured;
      try {
        await performCheckpoint();
        finalSnapshot = latestCaptured;
      } catch (error) {
        finalCaptureError = error;
        if (latestCaptured !== previousSnapshot) finalSnapshot = latestCaptured;
      }
    }

    if (hasPersistenceTarget) {
      await persistCachedSnapshot();
    }

    const finalSnapshotPersisted = Boolean(
      finalSnapshot && latestPersisted?.snapshot === finalSnapshot,
    );
    if (finalSnapshotPersisted) finalCaptureError = null;
    const persistenceIncomplete = Boolean(
      hasPersistenceTarget && canCaptureFresh && !finalSnapshotPersisted,
    );

    let fatalPersistenceError = null;
    if (hasPersistenceTarget && !latestPersisted) {
      fatalPersistenceError = finalCaptureError || lastCheckpointError?.error || new PersistenceError(
        'Browser closed before authentication state could be saved',
      );
    }

    const cleanup = await close(handle, { persist: false });
    const cleanupErrors = cleanup?.cleanupErrors || [];
    const result = {
      reason,
      signal: details.signal || null,
      exitCode: details.signal
        ? SIGNAL_EXIT_CODES[details.signal] || 1
        : persistenceIncomplete ? 8
          : cleanupErrors.length > 0 ? 1 : 0,
      persistence: latestPersisted?.result?.results || null,
      persistedAt: latestPersisted?.persistedAt || null,
      usedCheckpointFallback: Boolean(
        hasPersistenceTarget && (!canCaptureFresh || !finalSnapshotPersisted),
      ),
      persistenceIncomplete,
      finalCaptureError,
      cleanup,
      cleanupErrors,
    };

    if (fatalPersistenceError && cleanupErrors.length > 0) {
      const targets = cleanupErrors.map(({ target }) => target).join(', ');
      const combinedError = new PersistenceError(
        `${fatalPersistenceError.message}; browser cleanup also failed (${targets})`,
        {
          cause: fatalPersistenceError,
          cleanupFailures: cleanupErrors,
          failures: fatalPersistenceError.failures,
          results: fatalPersistenceError.results,
          snapshotMetadata: fatalPersistenceError.snapshotMetadata,
        },
      );
      throw attachLifecycleResult(combinedError, result);
    }
    if (fatalPersistenceError) {
      throw attachLifecycleResult(fatalPersistenceError, result);
    }
    return result;
  };

  requestExit = (reason, details = {}) => {
    if (finalization) return finalization;

    phase = 'finalizing';
    finalization = finalize(reason, details)
      .then((result) => {
        phase = 'closed';
        completion.resolve(result);
        return result;
      })
      .catch((error) => {
        phase = 'closed';
        completion.reject(error);
        throw error;
      });

    // Event callbacks intentionally do not await this promise. Attach a handler
    // here so a later wait() remains the single place that observes failure.
    finalization.catch(() => {});
    return finalization;
  };

  const start = () => {
    if (phase !== 'idle') return;
    phase = 'running';

    context.on('page', onPage);
    context.once('close', onContextClose);
    browser.once('disconnected', onDisconnected);
    for (const page of context.pages()) bindPage(page);

    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
      const listener = () => void requestExit('signal', { signal });
      signalEmitter.once(signal, listener);
      signalListeners.set(signal, listener);
    }

    if (hasPersistenceTarget) {
      void requestCheckpoint().catch(() => {});
      checkpointTimer = setInterval(() => {
        void requestCheckpoint().catch(() => {});
      }, interval);
      checkpointTimer.unref?.();
    }

    if (!browserIsConnected()) {
      void requestExit('disconnected');
    } else if (getOpenPages().length === 0) {
      void requestExit('last-page-closed');
    }
  };

  return {
    start,
    wait() {
      start();
      return completion.promise;
    },
    requestExit,
    checkpoint: requestCheckpoint,
    get phase() {
      return phase;
    },
    getState() {
      return {
        phase,
        hasPersistenceTarget,
        persistedAt: latestPersisted?.persistedAt || null,
        lastCheckpointError: lastCheckpointError?.error || null,
      };
    },
  };
}

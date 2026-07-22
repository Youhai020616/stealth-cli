import { closeBrowser } from '../browser.js';
import {
  StealthError,
  formatCleanupFailures,
  safeTextForTerminal,
} from '../errors.js';
import { log } from '../output.js';

function setFailureExitCode(code) {
  if (!process.exitCode || process.exitCode === 0) process.exitCode = code;
}

/**
 * Close a command-owned browser and surface persistence/cleanup failures to
 * shell callers without changing the best-effort SDK closeBrowser contract.
 */
export async function closeBrowserForCli(handle, opts = {}) {
  const logger = opts.log || log;
  const result = await closeBrowser(handle);

  if (result.persistenceError) {
    const details = result.persistenceError instanceof StealthError
      ? result.persistenceError.format()
      : safeTextForTerminal(
        result.persistenceError.message || String(result.persistenceError),
      );
    logger.warn(`Browser state was not fully saved: ${details}`);
    const errorCode = result.persistenceError.code;
    setFailureExitCode(Number.isInteger(errorCode) && errorCode >= 1 && errorCode <= 255
      ? errorCode
      : 8);
  }
  if (result.cleanupErrors.length > 0) {
    logger.warn(formatCleanupFailures(
      result.cleanupErrors,
      'Browser cleanup was incomplete',
    ));
    setFailureExitCode(1);
  }

  return result;
}

import { closeBrowser } from '../browser.js';
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
    setFailureExitCode(result.persistenceError.code || 8);
  }
  if (result.cleanupErrors.length > 0) {
    const targets = result.cleanupErrors.map(({ target }) => target).join(', ');
    logger.warn(`Browser cleanup was incomplete (${targets})`);
    setFailureExitCode(1);
  }

  return result;
}

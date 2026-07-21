/**
 * stealth open [url] - Open a headed browser for human authentication
 */

import ora from 'ora';
import {
  closeBrowser,
  launchBrowser,
  navigate,
  waitForReady,
} from '../browser.js';
import {
  createBrowserLifecycle,
  createLaunchSignalGuard,
  DEFAULT_CHECKPOINT_INTERVAL,
} from '../browser-lifecycle.js';
import { StealthError, handleError } from '../errors.js';
import { log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';

function reportLifecycleResult(result, hasPersistenceTarget) {
  if (result.signal) {
    log.info(`Received ${result.signal}; browser state finalized before exit`);
  }

  if (hasPersistenceTarget && result.usedCheckpointFallback) {
    const suffix = result.persistedAt
      ? ` (latest durable checkpoint: ${result.persistedAt})`
      : '';
    log.warn(`Browser closed before a final live snapshot; restored the latest checkpoint${suffix}`);
  } else if (hasPersistenceTarget && result.persistedAt) {
    const profileCount = result.persistence?.profile?.cookies;
    const sessionCount = result.persistence?.session?.cookies;
    const counts = [profileCount, sessionCount].filter(Number.isInteger);
    const count = counts.length > 0 ? Math.max(...counts) : 0;
    log.success(`Authentication state saved (${count} cookies)`);
  }

  if (result.cleanupErrors?.length > 0) {
    const targets = result.cleanupErrors.map(({ target }) => target).join(', ');
    log.warn(`Browser cleanup was incomplete (${targets})`);
  } else {
    log.success('Browser closed');
  }
  if (result.exitCode) process.exitCode = result.exitCode;
  return result;
}

/**
 * Run the headed browser flow. Exported for focused command tests.
 */
export async function runOpen(positionalUrl, opts) {
  if (positionalUrl && opts.url && positionalUrl !== opts.url) {
    throw new StealthError('Provide the URL either as an argument or with --url, not both', {
      code: 2,
    });
  }

  const targetUrl = opts.url || positionalUrl || null;
  const hasPersistenceTarget = Boolean(opts.profile || opts.session);
  const spinner = ora('Launching headed stealth browser...').start();
  let handle;
  let lifecycle;
  let lastCheckpointWarning = null;
  const signalGuard = createLaunchSignalGuard();

  try {
    handle = await launchBrowser({
      headless: false,
      forceDirect: true,
      handleSignals: false,
      proxy: opts.proxy,
      profile: opts.profile,
      session: opts.session,
      locale: opts.locale,
    });

    lifecycle = createBrowserLifecycle(handle, {
      checkpointInterval: opts.checkpointInterval,
      onCheckpointError(error) {
        if (error.message !== lastCheckpointWarning) {
          lastCheckpointWarning = error.message;
          log.warn(`State checkpoint failed; it will be retried: ${error.message}`);
        }
      },
    });
    signalGuard.transferTo(lifecycle);

    if (opts.cookies && lifecycle.phase === 'running') {
      const { loadCookies } = await import('../cookies.js');
      const result = await loadCookies(handle.context, opts.cookies);
      log.info(result.message);
    }

    if (targetUrl && lifecycle.phase === 'running') {
      try {
        spinner.text = `Opening ${targetUrl}...`;
        await navigate(handle, targetUrl);
        if (lifecycle.phase === 'running') {
          await waitForReady(handle.page);
        }
      } catch (error) {
        if (lifecycle.phase === 'running') throw error;
      }
    }

    spinner.stop();
    if (lifecycle.phase === 'running') {
      log.success('Headed browser is ready');
      log.info('Close all browser windows when authentication is complete.');
      if (hasPersistenceTarget) {
        log.dim(`  State checkpoints every ${opts.checkpointInterval}ms`);
      }
    }

    const result = await lifecycle.wait();
    return reportLifecycleResult(result, hasPersistenceTarget);
  } catch (error) {
    spinner.stop();
    signalGuard.dispose();
    const pendingSignal = signalGuard.pendingSignal;

    if (lifecycle) {
      try {
        await lifecycle.requestExit('command-error');
      } catch (cleanupError) {
        if (cleanupError !== error) {
          log.warn(`Cleanup after failure was incomplete: ${cleanupError.message}`);
        }
      }
    } else if (handle) {
      const cleanup = await closeBrowser(handle);
      if (cleanup.cleanupErrors.length > 0) {
        const targets = cleanup.cleanupErrors.map(({ target }) => target).join(', ');
        log.warn(`Browser cleanup after launch failure was incomplete (${targets})`);
      }
    }

    if (pendingSignal && !lifecycle) {
      throw new StealthError(`Interrupted by ${pendingSignal}`, {
        code: signalGuard.exitCode,
      });
    }
    throw error;
  }
}

export function registerOpen(program) {
  program
    .command('open')
    .description('Open a headed browser until all browser windows are closed')
    .argument('[url]', 'Initial URL to open')
    .option('--url <url>', 'Initial URL to open (alternative to positional URL)')
    .option('--profile <name>', 'Use a browser profile and persist cookies')
    .option('--session <name>', 'Use/restore a named session')
    .option('--proxy <proxy>', 'Proxy server (http://user:pass@host:port)')
    .option('--cookies <file>', 'Load cookies from a Netscape-format file')
    .option('--locale <locale>', 'Browser locale')
    .option(
      '--checkpoint-interval <ms>',
      'Authentication-state checkpoint interval in milliseconds',
      String(DEFAULT_CHECKPOINT_INTERVAL),
    )
    .action(async (url, commandOpts) => {
      const opts = resolveOpts(commandOpts);
      try {
        await runOpen(url, opts);
      } catch (error) {
        process.exitCode = handleError(error, { log, exit: false });
      }
    });
}

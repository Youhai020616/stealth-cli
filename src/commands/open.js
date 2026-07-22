/**
 * stealth open [url] - Open a headed browser for human authentication
 */

import { InvalidArgumentError } from 'commander';
import ora from 'ora';
import {
  launchBrowser,
  navigate,
  waitForReady,
} from '../browser.js';
import {
  createBrowserLifecycle,
  createLaunchSignalGuard,
  DEFAULT_CHECKPOINT_INTERVAL,
} from '../browser-lifecycle.js';
import { StealthError, handleError, safeUrlForDisplay } from '../errors.js';
import { log } from '../output.js';
import { closeBrowserForCli } from '../utils/close-browser-cli.js';
import { resolveOpts } from '../utils/resolve-opts.js';

const MIN_CHECKPOINT_INTERVAL = 250;
const MAX_CHECKPOINT_INTERVAL = 60_000;

export function parseCheckpointInterval(value) {
  const interval = Number(value);
  if (
    !Number.isInteger(interval) ||
    interval < MIN_CHECKPOINT_INTERVAL ||
    interval > MAX_CHECKPOINT_INTERVAL
  ) {
    const error = new InvalidArgumentError(
      `checkpoint interval must be an integer from ${MIN_CHECKPOINT_INTERVAL} to ${MAX_CHECKPOINT_INTERVAL}`,
    );
    error.exitCode = 2;
    throw error;
  }
  return interval;
}

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
  const checkpointInterval = parseCheckpointInterval(
    opts.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
  );
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
      restoreSessionUrl: !targetUrl,
    });

    lifecycle = createBrowserLifecycle(handle, {
      checkpointInterval,
      onCheckpointError(error) {
        if (error.message !== lastCheckpointWarning) {
          lastCheckpointWarning = error.message;
          log.warn(`State checkpoint failed; it will be retried: ${error.message}`);
        }
      },
    });
    signalGuard.transferTo(lifecycle);

    if (opts.cookies && lifecycle.phase === 'running') {
      try {
        const { loadCookies } = await import('../cookies.js');
        const result = await loadCookies(handle.context, opts.cookies);
        if (lifecycle.phase === 'running') log.info(result.message);
      } catch (error) {
        if (lifecycle.phase === 'running') throw error;
      }
    }

    if (targetUrl && lifecycle.phase === 'running') {
      try {
        spinner.text = `Opening ${safeUrlForDisplay(targetUrl)}...`;
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
        log.dim(`  State checkpoints every ${checkpointInterval}ms`);
      } else {
        log.warn('No --profile or --session was provided; authentication state will not be saved');
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
        const result = await lifecycle.requestExit('command-error');
        if (result.reason !== 'command-error') {
          return reportLifecycleResult(result, hasPersistenceTarget);
        }
      } catch (cleanupError) {
        if (cleanupError !== error) {
          log.warn(`Cleanup after failure was incomplete: ${cleanupError.message}`);
        }
      }
    } else if (handle) {
      await closeBrowserForCli(handle, { log });
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
      `Authentication-state checkpoint interval (${MIN_CHECKPOINT_INTERVAL}-${MAX_CHECKPOINT_INTERVAL}ms)`,
      parseCheckpointInterval,
      DEFAULT_CHECKPOINT_INTERVAL,
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

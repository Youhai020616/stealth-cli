/**
 * stealth monitor <url> - Monitor a page for changes
 */

import ora from 'ora';
import chalk from 'chalk';
import { launchBrowser, closeBrowser, navigate, evaluate, waitForReady } from '../browser.js';
import { randomDelay } from '../humanize.js';
import { log } from '../output.js';

export function registerMonitor(program) {
  program
    .command('monitor')
    .description('Monitor a page for changes')
    .argument('<url>', 'URL to monitor')
    .option('-s, --selector <selector>', 'CSS selector to watch (default: body)')
    .option('-i, --interval <seconds>', 'Check interval in seconds', '60')
    .option('-n, --count <n>', 'Max checks (0 = infinite)', '0')
    .option('--attr <attribute>', 'Watch an attribute instead of text')
    .option('--contains <text>', 'Alert when page contains this text')
    .option('--not-contains <text>', 'Alert when page no longer contains this text')
    .option('--json', 'Output changes as JSON')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--profile <name>', 'Use a browser profile')
    .option('--proxy-rotate', 'Rotate proxy from pool')
    .option('--no-headless', 'Show browser window')
    .action(async (url, opts) => {
      const interval = parseInt(opts.interval) * 1000;
      const maxChecks = parseInt(opts.count);
      const selector = opts.selector || 'body';

      log.info(`Monitoring ${url}`);
      log.dim(`  Selector: ${selector}`);
      log.dim(`  Interval: ${opts.interval}s`);
      if (maxChecks > 0) log.dim(`  Max checks: ${maxChecks}`);
      console.log();

      let handle;
      let previousValue = null;
      let checkCount = 0;
      let changeCount = 0;

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
          proxyRotate: opts.proxyRotate,
          profile: opts.profile,
        });

        if (handle.isDaemon) {
          log.error('Monitor requires direct mode');
          process.exit(1);
        }

        // Main monitoring loop
        while (true) {
          checkCount++;
          const ts = new Date().toISOString();

          try {
            await navigate(handle, url, { retries: 1 });
            await waitForReady(handle.page, { timeout: 5000 });

            // Extract current value
            let currentValue;
            if (opts.attr) {
              currentValue = await handle.page.$eval(selector, (el, attr) => el.getAttribute(attr), opts.attr)
                .catch(() => null);
            } else {
              currentValue = await handle.page.$eval(selector, (el) => el.textContent?.trim())
                .catch(() => null);
            }

            // Text contains check
            if (opts.contains) {
              const found = currentValue?.includes(opts.contains);
              if (found) {
                changeCount++;
                const msg = `[${ts}] ✓ FOUND: "${opts.contains}"`;
                if (opts.json) {
                  console.log(JSON.stringify({ event: 'found', text: opts.contains, url, timestamp: ts, check: checkCount }));
                } else {
                  console.log(chalk.green(msg));
                }
              } else {
                if (!opts.json) process.stderr.write(chalk.dim(`[${ts}] Check #${checkCount} — not found\r`));
              }
            }
            // Text not-contains check
            else if (opts.notContains) {
              const found = currentValue?.includes(opts.notContains);
              if (!found) {
                changeCount++;
                const msg = `[${ts}] ✓ DISAPPEARED: "${opts.notContains}"`;
                if (opts.json) {
                  console.log(JSON.stringify({ event: 'disappeared', text: opts.notContains, url, timestamp: ts, check: checkCount }));
                } else {
                  console.log(chalk.yellow(msg));
                }
              } else {
                if (!opts.json) process.stderr.write(chalk.dim(`[${ts}] Check #${checkCount} — still present\r`));
              }
            }
            // Diff check
            else {
              if (previousValue === null) {
                previousValue = currentValue;
                if (!opts.json) {
                  log.info(`[${ts}] Initial snapshot captured (${currentValue?.length || 0} chars)`);
                }
              } else if (currentValue !== previousValue) {
                changeCount++;

                if (opts.json) {
                  console.log(JSON.stringify({
                    event: 'changed',
                    url,
                    selector,
                    previous: previousValue?.slice(0, 500),
                    current: currentValue?.slice(0, 500),
                    timestamp: ts,
                    check: checkCount,
                    changeNumber: changeCount,
                  }));
                } else {
                  console.log(chalk.yellow(`\n[${ts}] CHANGE #${changeCount} detected!`));
                  console.log(chalk.dim('  Previous:'), (previousValue || '').slice(0, 200));
                  console.log(chalk.cyan('  Current: '), (currentValue || '').slice(0, 200));
                  console.log();
                }

                previousValue = currentValue;
              } else {
                if (!opts.json) process.stderr.write(chalk.dim(`[${ts}] Check #${checkCount} — no change\r`));
              }
            }
          } catch (err) {
            log.warn(`Check #${checkCount} failed: ${err.message}`);
          }

          // Check if we should stop
          if (maxChecks > 0 && checkCount >= maxChecks) {
            break;
          }

          // Wait for next check (with jitter)
          await randomDelay(interval * 0.9, interval * 1.1);
        }

        console.log();
        log.success(`Monitoring complete: ${checkCount} checks, ${changeCount} changes`);
      } catch (err) {
        log.error(`Monitor failed: ${err.message}`);
        process.exit(1);
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

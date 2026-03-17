/**
 * stealth batch <file> - Execute commands for a list of URLs
 */

import fs from 'fs';
import ora from 'ora';
import {
  launchBrowser, closeBrowser, navigate, getTextContent,
  getTitle, takeScreenshot, waitForReady,
} from '../browser.js';
import { navigateWithRetry } from '../retry.js';
import { randomDelay } from '../humanize.js';
import { formatOutput, log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';

export function registerBatch(program) {
  program
    .command('batch')
    .description('Process a list of URLs in batch')
    .argument('<file>', 'File containing URLs (one per line)')
    .option('-c, --command <cmd>', 'Command to run: browse, screenshot, extract', 'browse')
    .option('-o, --output <dir>', 'Output directory for results', '.')
    .option('-f, --format <format>', 'Output format: json, jsonl, text', 'jsonl')
    .option('--delay <ms>', 'Delay between URLs (ms)', '1000')
    .option('--concurrency <n>', 'Max parallel operations (reuses single browser)', '1')
    .option('-s, --selector <selector>', 'CSS selector for extract mode')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--profile <name>', 'Use a browser profile')
    .option('--proxy-rotate', 'Rotate proxy from pool')
    .option('--no-headless', 'Show browser window')
    .option('--retries <n>', 'Max retries per URL', '2')
    .option('--skip-errors', 'Continue on errors instead of stopping')
    .action(async (file, opts) => {
      opts = resolveOpts(opts);
      // Read URLs from file
      if (!fs.existsSync(file)) {
        log.error(`File not found: ${file}`);
        process.exit(1);
      }

      const urls = fs.readFileSync(file, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.startsWith('http'));

      if (urls.length === 0) {
        log.error('No valid URLs found in file');
        process.exit(1);
      }

      log.info(`Batch processing ${urls.length} URLs (command: ${opts.command})`);

      const spinner = ora('Launching stealth browser...').start();
      let handle;
      const results = [];
      let success = 0;
      let failed = 0;

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
          proxyRotate: opts.proxyRotate,
          profile: opts.profile,
        });

        // Ensure output directory exists for screenshot mode
        if (opts.command === 'screenshot') {
          fs.mkdirSync(opts.output, { recursive: true });
        }

        // Create output stream for jsonl mode
        let outputStream;
        if (opts.format === 'jsonl' && opts.command !== 'screenshot') {
          const outFile = `${opts.output}/batch-${Date.now()}.jsonl`;
          outputStream = fs.createWriteStream(outFile);
          log.dim(`  Output: ${outFile}`);
        }

        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          spinner.text = `[${i + 1}/${urls.length}] ${opts.command}: ${url.slice(0, 50)}...`;

          try {
            if (handle.isDaemon) {
              await navigate(handle, url, { retries: parseInt(opts.retries) });
            } else {
              await navigateWithRetry(handle.page, url, {
                maxRetries: parseInt(opts.retries),
              });
              await waitForReady(handle.page, { timeout: 3000 });
            }

            let result;

            switch (opts.command) {
              case 'browse': {
                const title = await getTitle(handle);
                const content = await getTextContent(handle);
                result = {
                  url,
                  title,
                  content: content.slice(0, 5000),
                  timestamp: new Date().toISOString(),
                };
                break;
              }

              case 'screenshot': {
                // Generate filename from URL
                const filename = url
                  .replace(/https?:\/\//, '')
                  .replace(/[^a-zA-Z0-9]/g, '_')
                  .slice(0, 80) + '.png';
                const filepath = `${opts.output}/${filename}`;

                await takeScreenshot(handle, { path: filepath });
                result = { url, screenshot: filepath, timestamp: new Date().toISOString() };
                break;
              }

              case 'extract': {
                const selector = opts.selector || 'body';
                let data;
                if (handle.isDaemon) {
                  const { evaluate } = await import('../browser.js');
                  data = await evaluate(handle, `document.querySelector('${selector}')?.textContent?.trim() || ''`);
                } else {
                  data = await handle.page.$eval(selector, (el) => el.textContent?.trim()).catch(() => '');
                }
                result = {
                  url,
                  selector,
                  data,
                  timestamp: new Date().toISOString(),
                };
                break;
              }

              default:
                throw new Error(`Unknown command: ${opts.command}`);
            }

            // Output result
            if (outputStream) {
              outputStream.write(JSON.stringify(result) + '\n');
            } else if (opts.command !== 'screenshot') {
              console.log(opts.format === 'jsonl' ? JSON.stringify(result) : formatOutput(result, opts.format));
            }

            results.push(result);
            success++;
          } catch (err) {
            failed++;
            log.warn(`[${i + 1}] Failed: ${url} — ${err.message}`);

            if (!opts.skipErrors) {
              throw err;
            }
          }

          // Delay between URLs
          if (i < urls.length - 1) {
            const delay = parseInt(opts.delay);
            await randomDelay(delay * 0.8, delay * 1.2);
          }
        }

        if (outputStream) outputStream.end();

        spinner.stop();
        log.success(`Batch complete: ${success} succeeded, ${failed} failed, ${urls.length} total`);
      } catch (err) {
        spinner.stop();
        log.error(`Batch failed: ${err.message}`);
        log.dim(`  Completed: ${success}/${urls.length}`);
        process.exit(1);
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

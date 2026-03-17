/**
 * stealth crawl <url> - Crawl pages recursively with anti-detection
 */

import ora from 'ora';
import { launchBrowser, closeBrowser, getTextContent, evaluate, waitForReady } from '../browser.js';
import { navigateWithRetry } from '../retry.js';
import { randomDelay, humanScroll } from '../humanize.js';
import { formatOutput, log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';

export function registerCrawl(program) {
  program
    .command('crawl')
    .description('Crawl pages recursively with anti-detection')
    .argument('<url>', 'Starting URL')
    .option('-d, --depth <n>', 'Maximum crawl depth', '1')
    .option('-l, --limit <n>', 'Maximum pages to crawl', '10')
    .option('--same-origin', 'Only follow same-origin links (default: true)', true)
    .option('--delay <ms>', 'Delay between requests (ms)', '1000')
    .option('-f, --format <format>', 'Output format: json, jsonl, text', 'jsonl')
    .option('-o, --output <file>', 'Output file (default: stdout)')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--cookies <file>', 'Load cookies from Netscape-format file')
    .option('--no-headless', 'Show browser window')
    .option('--include <pattern>', 'Only crawl URLs matching this pattern (regex)')
    .option('--exclude <pattern>', 'Skip URLs matching this pattern (regex)')
    .option('--humanize', 'Enable human behavior simulation')
    .option('--retries <n>', 'Max retries per page')
    .option('--profile <name>', 'Use a browser profile')
    .option('--proxy-rotate', 'Rotate proxy from pool')
    .action(async (startUrl, opts) => {
      opts = resolveOpts(opts);
      const spinner = ora('Launching stealth browser...').start();
      let handle;

      const maxDepth = parseInt(opts.depth);
      const maxPages = parseInt(opts.limit);
      const delay = parseInt(opts.delay);
      const maxRetries = parseInt(opts.retries);
      const includeRegex = opts.include ? new RegExp(opts.include) : null;
      const excludeRegex = opts.exclude ? new RegExp(opts.exclude) : null;

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
          proxyRotate: opts.proxyRotate,
          profile: opts.profile,
        });

        // Crawl requires direct mode (page access)
        if (handle.isDaemon) {
          log.warn('Crawl uses direct mode (daemon does not support multi-page crawling)');
        }

        if (opts.cookies && handle.context) {
          const { loadCookies } = await import('../cookies.js');
          await loadCookies(handle.context, opts.cookies);
        }

        const startOrigin = new URL(startUrl).origin;
        const visited = new Set();
        const queue = [{ url: startUrl, depth: 0 }];
        const results = [];
        let outputStream;

        if (opts.output) {
          const { createWriteStream } = await import('fs');
          outputStream = createWriteStream(opts.output);
        }

        const writeResult = (result) => {
          const line = opts.format === 'jsonl'
            ? JSON.stringify(result)
            : formatOutput(result, opts.format);

          if (outputStream) {
            outputStream.write(line + '\n');
          } else {
            console.log(line);
          }
          results.push(result);
        };

        while (queue.length > 0 && results.length < maxPages) {
          const { url, depth } = queue.shift();

          if (visited.has(url)) continue;
          visited.add(url);

          if (includeRegex && !includeRegex.test(url)) continue;
          if (excludeRegex && excludeRegex.test(url)) continue;

          spinner.text = `[${results.length + 1}/${maxPages}] Crawling: ${url.slice(0, 60)}...`;

          try {
            // Navigate with retry
            await navigateWithRetry(handle.page, url, {
              timeout: 30000,
              maxRetries,
            });
            await waitForReady(handle.page, { timeout: 3000 });

            const title = await handle.page.title().catch(() => '');
            const text = await getTextContent(handle);

            const result = {
              url: handle.page.url(),
              title,
              content: text.slice(0, 5000),
              depth,
              timestamp: new Date().toISOString(),
            };

            writeResult(result);

            // Extract links for next depth
            if (depth < maxDepth) {
              const links = await handle.page.evaluate(() => {
                return Array.from(document.querySelectorAll('a[href]'))
                  .map((a) => a.href)
                  .filter((href) => href && href.startsWith('http'));
              });

              for (const link of links) {
                if (visited.has(link)) continue;

                if (opts.sameOrigin) {
                  try {
                    if (new URL(link).origin !== startOrigin) continue;
                  } catch { continue; }
                }

                queue.push({ url: link, depth: depth + 1 });
              }
            }

            // Human-like delay between pages
            if (delay > 0) {
              if (opts.humanize) {
                // Human mode: scroll + random delay
                await humanScroll(handle.page, { scrolls: 1 });
                await randomDelay(delay * 0.8, delay * 1.5);
              } else {
                // Standard: fixed delay + small jitter
                const jitter = delay + Math.random() * delay * 0.3;
                await handle.page.waitForTimeout(jitter);
              }
            }
          } catch (err) {
            log.warn(`Failed to crawl ${url}: ${err.message}`);
          }
        }

        if (outputStream) outputStream.end();

        spinner.stop();
        log.success(`Crawl complete: ${results.length} pages crawled`);
        log.dim(`  Start: ${startUrl}`);
        log.dim(`  Depth: ${maxDepth}, Visited: ${visited.size}`);
        if (opts.output) log.dim(`  Output: ${opts.output}`);
      } catch (err) {
        spinner.stop();
        log.error(`Crawl failed: ${err.message}`);
        process.exit(1);
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

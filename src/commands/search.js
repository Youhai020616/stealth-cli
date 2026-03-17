/**
 * stealth search <engine> <query> - Search with anti-detection
 */

import ora from 'ora';
import {
  launchBrowser, closeBrowser, navigate, getSnapshot,
  getTextContent, getUrl, waitForReady,
} from '../browser.js';
import { expandMacro, getSupportedEngines } from '../macros.js';
import { getExtractorByEngine } from '../extractors/index.js';
import * as googleExtractor from '../extractors/google.js';
import { humanScroll, randomDelay, warmup } from '../humanize.js';
import { formatOutput, log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';
import { handleError } from '../errors.js';

export function registerSearch(program) {
  program
    .command('search')
    .description('Search the web with anti-detection')
    .argument('<engine>', `Search engine: ${getSupportedEngines().join(', ')}`)
    .argument('<query>', 'Search query')
    .option('-f, --format <format>', 'Output format: text, json, snapshot')
    .option('-n, --num <n>', 'Max results to extract', '10')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--no-headless', 'Show browser window')
    .option('--humanize', 'Simulate human behavior (auto for Google)')
    .option('--warmup', 'Visit a random site before searching (helps bypass detection)')
    .option('--retries <n>', 'Max retries on failure')
    .option('--also-ask', 'Include "People also ask" questions (Google only)')
    .option('--profile <name>', 'Use a browser profile')
    .option('--session <name>', 'Use/restore a named session')
    .option('--proxy-rotate', 'Rotate proxy from pool')
    .action(async (engine, query, opts) => {
      opts = resolveOpts(opts);
      const url = expandMacro(engine, query);

      if (!url) {
        log.error(`Unknown engine: "${engine}"`);
        log.info(`Supported: ${getSupportedEngines().join(', ')}`);
        process.exit(1);
      }

      const spinner = ora(`Searching ${engine} for "${query}"...`).start();
      let handle;

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
          proxyRotate: opts.proxyRotate,
          profile: opts.profile,
          session: opts.session,
        });

        const isGoogle = engine.toLowerCase() === 'google';
        const extractor = getExtractorByEngine(engine);

        // --- Google: full anti-detection search flow ---
        if (isGoogle && !handle.isDaemon) {
          // Optional warmup: visit a random site first
          if (opts.warmup) {
            spinner.text = 'Warming up browser...';
            await warmup(handle.page);
          }

          // Simulate human search: homepage → type → enter
          spinner.text = 'Navigating to Google...';
          const success = await googleExtractor.humanSearch(handle.page, query);

          if (!success) {
            // Fallback: direct URL navigation
            spinner.text = 'Fallback: direct navigation...';
            await navigate(handle, url, { retries: opts.retries });
          }

          await waitForReady(handle.page, { timeout: 5000 });
          await randomDelay(500, 1200);
          await humanScroll(handle.page, { scrolls: 1 });

          // Check for block
          const currentUrl = handle.page.url();
          if (googleExtractor.isBlocked(currentUrl)) {
            spinner.stop();
            log.warn('Google detected automation and blocked the request');
            log.dim('  Try: --proxy <proxy> or --warmup flag');
            log.dim('  Or use a different engine: stealth search duckduckgo "..."');

            if (opts.format === 'json') {
              console.log(formatOutput({
                engine, query, url: currentUrl,
                blocked: true, results: [], count: 0,
                timestamp: new Date().toISOString(),
              }, 'json'));
            }
            return;
          }
        }
        // --- Other engines: direct navigation ---
        else {
          spinner.text = `Navigating to ${engine}...`;
          await navigate(handle, url, {
            humanize: opts.humanize,
            retries: opts.retries,
          });

          if (!handle.isDaemon) {
            await waitForReady(handle.page, { timeout: 4000 });
          }
        }

        spinner.stop();

        const currentUrl = await getUrl(handle);

        // --- Output ---
        if (opts.format === 'snapshot') {
          const snapshot = await getSnapshot(handle);
          console.log(snapshot);
        } else if (opts.format === 'json') {
          let results = [];
          let alsoAsk = [];

          if (!handle.isDaemon) {
            results = await extractor.extractResults(handle.page, opts.num);

            // Google "People also ask"
            if (isGoogle && opts.alsoAsk) {
              alsoAsk = await googleExtractor.extractPeopleAlsoAsk(handle.page);
            }
          } else {
            const text = await getTextContent(handle);
            results = [{ title: 'Raw text (daemon mode)', content: text.slice(0, 5000) }];
          }

          const output = {
            engine,
            query,
            url: currentUrl,
            results,
            count: results.length,
            timestamp: new Date().toISOString(),
          };

          if (alsoAsk.length > 0) {
            output.peopleAlsoAsk = alsoAsk;
          }

          console.log(formatOutput(output, 'json'));
        } else {
          const text = await getTextContent(handle);
          console.log(text);
        }

        log.success(`Search complete: ${currentUrl}`);
      } catch (err) {
        spinner.stop();
        handleError(err, { log });
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

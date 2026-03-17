/**
 * stealth browse <url> - Visit a URL and print page content
 */

import ora from 'ora';
import {
  launchBrowser, closeBrowser, navigate, getSnapshot,
  getTextContent, getTitle, getUrl, evaluate, waitForReady,
} from '../browser.js';
import { formatOutput, log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';

export function registerBrowse(program) {
  program
    .command('browse')
    .description('Visit a URL and print page content')
    .argument('<url>', 'URL to visit')
    .option('-f, --format <format>', 'Output format: text, json, markdown, snapshot')
    .option('-w, --wait <ms>', 'Wait time after page load (ms)', '2000')
    .option('--proxy <proxy>', 'Proxy server (http://user:pass@host:port)')
    .option('--cookies <file>', 'Load cookies from Netscape-format file')
    .option('--no-headless', 'Show browser window')
    .option('--locale <locale>', 'Browser locale')
    .option('--user-agent', 'Print the browser user-agent')
    .option('--humanize', 'Enable human behavior simulation')
    .option('--retries <n>', 'Max retries on failure')
    .option('--profile <name>', 'Use a browser profile')
    .option('--session <name>', 'Use/restore a named session')
    .option('--proxy-rotate', 'Rotate proxy from pool')
    .action(async (url, opts) => {
      opts = resolveOpts(opts);
      const spinner = ora('Launching stealth browser...').start();
      let handle;

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
          proxyRotate: opts.proxyRotate,
          profile: opts.profile,
          session: opts.session,
          locale: opts.locale,
        });

        // Load cookies if provided (direct mode only)
        if (opts.cookies && !handle.isDaemon) {
          const { loadCookies } = await import('../cookies.js');
          const result = await loadCookies(handle.context, opts.cookies);
          spinner.text = `Loaded ${result.count} cookies`;
        }

        spinner.text = `Navigating to ${url}...`;
        await navigate(handle, url, {
          humanize: opts.humanize,
          retries: parseInt(opts.retries),
        });

        if (!handle.isDaemon) {
          await waitForReady(handle.page, { timeout: parseInt(opts.wait) });
        }

        spinner.stop();

        // Print user-agent if requested
        if (opts.userAgent) {
          const ua = await evaluate(handle, 'navigator.userAgent');
          log.info(`User-Agent: ${ua}`);
        }

        // Get page content based on format
        let output;

        if (opts.format === 'snapshot') {
          output = await getSnapshot(handle);
        } else if (opts.format === 'json') {
          const title = await getTitle(handle);
          const currentUrl = await getUrl(handle);
          const ua = await evaluate(handle, 'navigator.userAgent');
          const text = await getTextContent(handle);
          output = formatOutput({
            url: currentUrl,
            title,
            userAgent: ua,
            content: text.slice(0, 10000),
            timestamp: new Date().toISOString(),
          }, 'json');
        } else {
          output = await getTextContent(handle);
        }

        console.log(output);

        const currentUrl = await getUrl(handle);
        log.success(`Done: ${currentUrl}`);
      } catch (err) {
        spinner.stop();
        log.error(`Browse failed: ${err.message}`);
        process.exit(1);
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

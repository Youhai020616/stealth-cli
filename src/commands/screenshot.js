/**
 * stealth screenshot <url> - Take a screenshot of a page
 */

import ora from 'ora';
import { launchBrowser, closeBrowser, navigate, takeScreenshot, getUrl, waitForReady } from '../browser.js';
import { log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';
import { handleError } from '../errors.js';

export function registerScreenshot(program) {
  program
    .command('screenshot')
    .description('Take a screenshot of a page')
    .argument('<url>', 'URL to screenshot')
    .option('-o, --output <file>', 'Output file path', 'screenshot.png')
    .option('--full', 'Capture full page (not just viewport)')
    .option('--width <px>', 'Viewport width', '1280')
    .option('--height <px>', 'Viewport height', '720')
    .option('--wait <ms>', 'Wait time after page load (ms)', '2000')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--cookies <file>', 'Load cookies from Netscape-format file')
    .option('--no-headless', 'Show browser window')
    .option('--quality <n>', 'JPEG quality (1-100), only for .jpg output')
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
          viewport: {
            width: opts.width,
            height: opts.height,
          },
        });

        // Load cookies (direct mode only)
        if (opts.cookies && !handle.isDaemon) {
          const { loadCookies } = await import('../cookies.js');
          await loadCookies(handle.context, opts.cookies);
        }

        spinner.text = `Navigating to ${url}...`;
        await navigate(handle, url, {
          humanize: opts.humanize,
          retries: opts.retries,
        });

        if (!handle.isDaemon) {
          await waitForReady(handle.page, { timeout: opts.wait });
        }

        spinner.text = 'Taking screenshot...';

        if (handle.isDaemon) {
          // Daemon mode: get base64 and write to file
          await takeScreenshot(handle, { path: opts.output, fullPage: opts.full || false });
        } else {
          // Direct mode: native screenshot
          const screenshotOpts = {
            path: opts.output,
            fullPage: opts.full || false,
          };

          if (opts.output.endsWith('.jpg') || opts.output.endsWith('.jpeg')) {
            screenshotOpts.type = 'jpeg';
            if (opts.quality) screenshotOpts.quality = opts.quality;
          } else {
            screenshotOpts.type = 'png';
          }

          await handle.page.screenshot(screenshotOpts);
        }

        spinner.stop();
        const currentUrl = await getUrl(handle);
        log.success(`Screenshot saved: ${opts.output}`);
        log.dim(`  URL: ${currentUrl}`);
        log.dim(`  Size: ${opts.width}x${opts.height}${opts.full ? ' (full page)' : ''}`);
      } catch (err) {
        spinner.stop();
        handleError(err, { log });
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

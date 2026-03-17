/**
 * stealth pdf <url> - Save a page as PDF
 */

import ora from 'ora';
import { launchBrowser, closeBrowser, navigate, waitForReady } from '../browser.js';
import { log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';
import { handleError } from '../errors.js';

export function registerPdf(program) {
  program
    .command('pdf')
    .description('Save a page as PDF')
    .argument('<url>', 'URL to convert')
    .option('-o, --output <file>', 'Output file path', 'page.pdf')
    .option('--format <size>', 'Paper size: A4, Letter, Legal, A3', 'A4')
    .option('--landscape', 'Landscape orientation')
    .option('--margin <px>', 'Margin in pixels (all sides)', '20')
    .option('--no-background', 'Omit background graphics')
    .option('--scale <n>', 'Scale factor (0.1-2.0)', '1')
    .option('--header <text>', 'Header template (HTML)')
    .option('--footer <text>', 'Footer template (HTML)')
    .option('--pages <range>', 'Page range (e.g. "1-3", "1,3,5")')
    .option('--wait <ms>', 'Wait time after page load (ms)', '2000')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--cookies <file>', 'Load cookies from Netscape-format file')
    .option('--profile <name>', 'Use a browser profile')
    .option('--no-headless', 'Show browser window')
    .option('--retries <n>', 'Max retries on failure')
    .action(async (url, opts) => {
      opts = resolveOpts(opts);
      const spinner = ora('Launching stealth browser...').start();
      let handle;

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
          profile: opts.profile,
        });

        if (handle.isDaemon) {
          spinner.stop();
          log.error('PDF generation requires direct mode (daemon does not support it)');
          log.dim('  Tip: stop daemon first or use --profile to force direct mode');
          process.exit(1);
        }

        if (opts.cookies) {
          const { loadCookies } = await import('../cookies.js');
          await loadCookies(handle.context, opts.cookies);
        }

        spinner.text = `Navigating to ${url}...`;
        await navigate(handle, url, { retries: opts.retries });
        await waitForReady(handle.page, { timeout: opts.wait });

        spinner.text = 'Generating PDF...';

        // Firefox/Camoufox doesn't support page.pdf() — use print-to-PDF via CDP
        // Fallback: take a full-page screenshot and convert context
        try {
          await handle.page.pdf({
            path: opts.output,
            format: opts.format,
            landscape: opts.landscape || false,
            printBackground: opts.background !== false,
            scale: parseFloat(opts.scale),
            margin: { top: `${opts.margin}px`, right: `${opts.margin}px`, bottom: `${opts.margin}px`, left: `${opts.margin}px` },
          });
        } catch {
          // Firefox fallback: emulate print media and take full screenshot
          // This creates a high-quality image, not a true PDF
          spinner.text = 'Firefox detected — using screenshot-based PDF...';

          const outputFile = opts.output.endsWith('.pdf')
            ? opts.output.replace(/\.pdf$/, '.png')
            : opts.output + '.png';

          await handle.page.screenshot({
            path: outputFile,
            fullPage: true,
            type: 'png',
          });

          log.warn('Firefox/Camoufox does not support native PDF generation');
          log.dim(`  Full-page screenshot saved instead: ${outputFile}`);
          log.dim('  Tip: Use a tool like "img2pdf" to convert: img2pdf screenshot.png -o page.pdf');

          spinner.stop();
          return;
        }

        spinner.stop();

        const { statSync } = await import('fs');
        const size = statSync(opts.output).size;
        const sizeKB = (size / 1024).toFixed(1);

        log.success(`PDF saved: ${opts.output} (${sizeKB} KB)`);
        log.dim(`  URL:    ${handle.page.url()}`);
        log.dim(`  Format: ${opts.format}${opts.landscape ? ' landscape' : ''}`);
      } catch (err) {
        spinner.stop();
        handleError(err, { log });
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

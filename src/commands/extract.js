/**
 * stealth extract <url> - Extract structured data from a page
 */

import ora from 'ora';
import {
  launchBrowser, closeBrowser, navigate, getTitle,
  getUrl, evaluate, waitForReady,
} from '../browser.js';
import { formatOutput, log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';
import { handleError } from '../errors.js';

export function registerExtract(program) {
  program
    .command('extract')
    .description('Extract structured data from a page')
    .argument('<url>', 'URL to extract from')
    .option('-s, --selector <selector>', 'CSS selector to extract', 'body')
    .option('-a, --attr <attribute>', 'Extract attribute instead of text (e.g. href, src)')
    .option('--all', 'Extract all matching elements (not just the first)')
    .option('--links', 'Extract all links from the page')
    .option('--images', 'Extract all image URLs from the page')
    .option('--meta', 'Extract meta tags (title, description, og tags)')
    .option('--headers', 'Extract all headings (h1-h6)')
    .option('-f, --format <format>', 'Output format: json, text, markdown', 'json')
    .option('--wait <ms>', 'Wait time after page load (ms)', '2000')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--cookies <file>', 'Load cookies from Netscape-format file')
    .option('--no-headless', 'Show browser window')
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
        });

        if (opts.cookies && !handle.isDaemon) {
          const { loadCookies } = await import('../cookies.js');
          await loadCookies(handle.context, opts.cookies);
        }

        spinner.text = `Navigating to ${url}...`;
        await navigate(handle, url, {
          humanize: opts.humanize,
          retries: parseInt(opts.retries),
        });

        if (!handle.isDaemon) {
          await waitForReady(handle.page, { timeout: parseInt(opts.wait) });
        }

        spinner.text = 'Extracting data...';
        spinner.stop();

        let result;
        const evalFn = (expr) => evaluate(handle, expr);

        if (opts.links) {
          result = await evalFn(`(() => {
            const links = [];
            document.querySelectorAll('a[href]').forEach(a => {
              const href = a.href;
              const text = a.textContent?.trim().slice(0, 200) || '';
              if (href && href.startsWith('http')) links.push({ url: href, text });
            });
            return links;
          })()`);
        } else if (opts.images) {
          result = await evalFn(`(() => {
            const images = [];
            document.querySelectorAll('img[src]').forEach(img => {
              images.push({
                src: img.src,
                alt: img.alt || '',
                width: img.naturalWidth || img.width || 0,
                height: img.naturalHeight || img.height || 0,
              });
            });
            return images;
          })()`);
        } else if (opts.meta) {
          result = await evalFn(`(() => {
            const getMeta = (name) => {
              const el = document.querySelector('meta[name="' + name + '"]')
                || document.querySelector('meta[property="' + name + '"]');
              return el?.getAttribute('content') || '';
            };
            return {
              title: document.title || '',
              description: getMeta('description'),
              keywords: getMeta('keywords'),
              ogTitle: getMeta('og:title'),
              ogDescription: getMeta('og:description'),
              ogImage: getMeta('og:image'),
              ogUrl: getMeta('og:url'),
              canonical: document.querySelector('link[rel="canonical"]')?.href || '',
            };
          })()`);
        } else if (opts.headers) {
          result = await evalFn(`(() => {
            const headings = [];
            document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
              headings.push({ level: parseInt(h.tagName[1]), text: h.textContent?.trim() || '' });
            });
            return headings;
          })()`);
        } else {
          const selector = opts.selector;
          const attr = opts.attr;
          const all = opts.all;
          result = await evalFn(`(() => {
            const elements = ${all}
              ? Array.from(document.querySelectorAll('${selector}'))
              : [document.querySelector('${selector}')].filter(Boolean);
            return elements.map(el => {
              if ('${attr || ''}') return el.getAttribute('${attr || ''}');
              return el.textContent?.trim() || '';
            });
          })()`);
        }

        const title = await getTitle(handle);
        const currentUrl = await getUrl(handle);

        const output = formatOutput({
          url: currentUrl,
          title,
          data: result,
          count: Array.isArray(result) ? result.length : 1,
          timestamp: new Date().toISOString(),
        }, opts.format);

        console.log(output);
        log.success(`Extracted from: ${currentUrl}`);
      } catch (err) {
        spinner.stop();
        handleError(err, { log });
      } finally {
        if (handle) await closeBrowser(handle);
      }
    });
}

/**
 * stealth interactive - Interactive REPL mode for browsing
 */

import { createInterface } from 'readline';
import ora from 'ora';
import chalk from 'chalk';
import {
  launchBrowser, closeBrowser, navigate, getSnapshot,
  getTextContent, getUrl, getTitle, evaluate, takeScreenshot, waitForReady,
} from '../browser.js';
import { expandMacro, getSupportedEngines } from '../macros.js';
import { humanClick, humanType, humanScroll, randomDelay } from '../humanize.js';
import { log } from '../output.js';
import { resolveOpts } from '../utils/resolve-opts.js';

const HELP_TEXT = `
${chalk.bold('Navigation:')}
  ${chalk.cyan('goto <url>')}            Navigate to a URL
  ${chalk.cyan('search <engine> <q>')}   Search (${getSupportedEngines().slice(0, 5).join(', ')}...)
  ${chalk.cyan('back')}                  Go back
  ${chalk.cyan('forward')}               Go forward
  ${chalk.cyan('reload')}                Reload page

${chalk.bold('Inspection:')}
  ${chalk.cyan('snapshot')}              Accessibility snapshot
  ${chalk.cyan('text')}                  Page text content
  ${chalk.cyan('title')}                 Page title
  ${chalk.cyan('url')}                   Current URL
  ${chalk.cyan('links')}                 List all links
  ${chalk.cyan('screenshot [file]')}     Take a screenshot

${chalk.bold('Interaction:')}
  ${chalk.cyan('click <selector>')}      Click an element
  ${chalk.cyan('hclick <selector>')}     Human-like click (mouse movement)
  ${chalk.cyan('type <sel> <text>')}     Type text into element
  ${chalk.cyan('htype <sel> <text>')}    Human-like typing (variable speed)
  ${chalk.cyan('scroll [up|down] [n]')}  Scroll page
  ${chalk.cyan('eval <js>')}             Evaluate JavaScript
  ${chalk.cyan('wait <ms>')}             Wait for milliseconds

${chalk.bold('Other:')}
  ${chalk.cyan('help')}                  Show this help
  ${chalk.cyan('exit')}                  Exit
`;

export function registerInteractive(program) {
  program
    .command('interactive')
    .alias('repl')
    .description('Interactive browser REPL mode')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--cookies <file>', 'Load cookies from Netscape-format file')
    .option('--no-headless', 'Show browser window')
    .option('--url <url>', 'Initial URL to open')
    .action(async (opts) => {
      opts = resolveOpts(opts);
      const spinner = ora('Launching stealth browser...').start();
      let handle;

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
        });

        if (opts.cookies && !handle.isDaemon) {
          const { loadCookies } = await import('../cookies.js');
          const result = await loadCookies(handle.context, opts.cookies);
          log.info(result.message);
        }

        if (opts.url) {
          await navigate(handle, opts.url);
          if (!handle.isDaemon) {
            await waitForReady(handle.page);
          }
        }

        spinner.stop();

        console.log(chalk.bold('\n🦊 Stealth Browser Interactive Mode'));
        console.log(chalk.dim('Type "help" for commands, "exit" to quit.\n'));

        if (opts.url) {
          const currentUrl = await getUrl(handle);
          log.info(`Current page: ${currentUrl}`);
        }

        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
          prompt: chalk.green('stealth> '),
        });

        rl.prompt();

        rl.on('line', async (line) => {
          const input = line.trim();
          if (!input) { rl.prompt(); return; }

          const [cmd, ...args] = input.split(/\s+/);
          const argStr = args.join(' ');

          try {
            switch (cmd.toLowerCase()) {
              case 'goto': case 'go': case 'navigate': {
                if (!argStr) { log.warn('Usage: goto <url>'); break; }
                const s = ora(`Navigating...`).start();
                await navigate(handle, argStr);
                if (!handle.isDaemon) await waitForReady(handle.page);
                s.stop();
                log.success(`→ ${await getUrl(handle)}`);
                break;
              }

              case 'search': {
                if (args.length < 2) { log.warn('Usage: search <engine> <query>'); break; }
                const engine = args[0];
                const query = args.slice(1).join(' ');
                const url = expandMacro(engine, query);
                if (!url) { log.error(`Unknown engine. Try: ${getSupportedEngines().join(', ')}`); break; }
                const s = ora(`Searching ${engine}...`).start();
                await navigate(handle, url);
                if (!handle.isDaemon) await waitForReady(handle.page);
                s.stop();
                log.success(`→ ${await getUrl(handle)}`);
                break;
              }

              case 'click': {
                if (!argStr) { log.warn('Usage: click <selector>'); break; }
                if (handle.isDaemon) { log.warn('click requires direct mode'); break; }
                await handle.page.click(argStr, { timeout: 5000 });
                await waitForReady(handle.page, { timeout: 2000 });
                log.success('Clicked');
                break;
              }

              case 'hclick': {
                if (!argStr) { log.warn('Usage: hclick <selector>'); break; }
                if (handle.isDaemon) { log.warn('hclick requires direct mode'); break; }
                await humanClick(handle.page, argStr);
                await waitForReady(handle.page, { timeout: 2000 });
                log.success('Human-clicked');
                break;
              }

              case 'type': {
                if (args.length < 2) { log.warn('Usage: type <selector> <text>'); break; }
                if (handle.isDaemon) { log.warn('type requires direct mode'); break; }
                await handle.page.fill(args[0], args.slice(1).join(' '));
                log.success(`Typed: "${args.slice(1).join(' ')}"`);
                break;
              }

              case 'htype': {
                if (args.length < 2) { log.warn('Usage: htype <selector> <text>'); break; }
                if (handle.isDaemon) { log.warn('htype requires direct mode'); break; }
                await humanType(handle.page, args[0], args.slice(1).join(' '));
                log.success(`Human-typed: "${args.slice(1).join(' ')}"`);
                break;
              }

              case 'scroll': {
                if (handle.isDaemon) { log.warn('scroll requires direct mode'); break; }
                const direction = args[0] || 'down';
                const scrolls = parseInt(args[1]) || 2;
                await humanScroll(handle.page, { direction, scrolls });
                log.success(`Scrolled ${direction}`);
                break;
              }

              case 'snapshot': {
                const snapshot = await getSnapshot(handle);
                console.log(snapshot);
                break;
              }

              case 'text': {
                const text = await getTextContent(handle);
                console.log(text);
                break;
              }

              case 'title': {
                console.log(await getTitle(handle));
                break;
              }

              case 'url': {
                console.log(await getUrl(handle));
                break;
              }

              case 'links': {
                const links = await evaluate(handle, `
                  Array.from(document.querySelectorAll('a[href]'))
                    .filter(a => a.href.startsWith('http'))
                    .slice(0, 30)
                    .map(a => ({ text: a.textContent?.trim().slice(0, 60), url: a.href }))
                `);
                if (links) {
                  links.forEach((l, i) =>
                    console.log(`${chalk.dim(`${i + 1}.`)} ${l.text || '(no text)'}\n   ${chalk.cyan(l.url)}`)
                  );
                  log.dim(`Total: ${links.length} links shown`);
                }
                break;
              }

              case 'screenshot': {
                const file = argStr || 'screenshot.png';
                await takeScreenshot(handle, { path: file });
                log.success(`Screenshot saved: ${file}`);
                break;
              }

              case 'back': {
                if (handle.isDaemon) { log.warn('back requires direct mode'); break; }
                await handle.page.goBack({ timeout: 10000 });
                log.success(`← ${handle.page.url()}`);
                break;
              }

              case 'forward': {
                if (handle.isDaemon) { log.warn('forward requires direct mode'); break; }
                await handle.page.goForward({ timeout: 10000 });
                log.success(`→ ${handle.page.url()}`);
                break;
              }

              case 'reload': {
                if (handle.isDaemon) { log.warn('reload requires direct mode'); break; }
                await handle.page.reload({ timeout: 30000 });
                log.success('Reloaded');
                break;
              }

              case 'eval': case 'js': {
                if (!argStr) { log.warn('Usage: eval <javascript>'); break; }
                const result = await evaluate(handle, argStr);
                console.log(result);
                break;
              }

              case 'wait': {
                const ms = parseInt(argStr) || 1000;
                await randomDelay(ms, ms);
                log.success(`Waited ${ms}ms`);
                break;
              }

              case 'help': case '?': {
                console.log(HELP_TEXT);
                break;
              }

              case 'exit': case 'quit': case 'q': {
                rl.close();
                return;
              }

              default:
                log.warn(`Unknown command: ${cmd}. Type "help" for commands.`);
            }
          } catch (err) {
            log.error(`${err.message}`);
          }

          rl.prompt();
        });

        rl.on('close', async () => {
          await closeBrowser(handle);
          log.success('Bye! 🦊');
          process.exit(0);
        });
      } catch (err) {
        spinner.stop();
        log.error(`Failed to start: ${err.message}`);
        if (handle) await closeBrowser(handle);
        process.exit(1);
      }
    });
}

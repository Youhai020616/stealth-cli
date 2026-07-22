/**
 * stealth interactive - Interactive REPL mode for browsing
 */

import { createInterface } from "readline";
import ora from "ora";
import chalk from "chalk";
import {
  launchBrowser,
  closeBrowser,
  navigate,
  getSnapshot,
  getA11ySnapshot,
  getTextContent,
  getUrl,
  getTitle,
  evaluate,
  takeScreenshot,
  waitForReady,
  clickRef,
  typeRef,
} from "../browser.js";
import {
  createBrowserLifecycle,
  createLaunchSignalGuard,
  createLifecyclePersistenceCleanupFailure,
} from "../browser-lifecycle.js";
import { expandMacro, getSupportedEngines } from "../macros.js";
import {
  humanClick,
  humanType,
  humanScroll,
  randomDelay,
} from "../humanize.js";
import { log } from "../output.js";
import { resolveOpts } from "../utils/resolve-opts.js";
import {
  PersistenceError,
  StealthError,
  attachCleanupFailures,
  formatCleanupFailures,
  handleError,
} from "../errors.js";
import { closeBrowserForCli } from "../utils/close-browser-cli.js";

function describeUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return 'current page';
  }
}

const HELP_TEXT = `
${chalk.bold("Navigation:")}
  ${chalk.cyan("goto <url>")}            Navigate to a URL
  ${chalk.cyan("search <engine> <q>")}   Search (${getSupportedEngines().slice(0, 5).join(", ")}...)
  ${chalk.cyan("back")}                  Go back
  ${chalk.cyan("forward")}               Go forward
  ${chalk.cyan("reload")}                Reload page

${chalk.bold("Inspection:")}
  ${chalk.cyan("snapshot")}              Accessibility snapshot
  ${chalk.cyan("a11y")}                  A11y tree with refs (for agents)
  ${chalk.cyan("text")}                  Page text content
  ${chalk.cyan("title")}                 Page title
  ${chalk.cyan("url")}                   Current URL
  ${chalk.cyan("links")}                 List all links
  ${chalk.cyan("screenshot [file]")}     Take a screenshot

${chalk.bold("Interaction:")}
  ${chalk.cyan("click <selector>")}      Click an element (CSS selector)
  ${chalk.cyan("click @<ref>")}          Click element by ref from a11y snapshot
  ${chalk.cyan("hclick <selector>")}     Human-like click (mouse movement)
  ${chalk.cyan("type <sel> <text>")}     Type text into element (CSS selector)
  ${chalk.cyan("type @<ref> <text>")}    Type into element by ref
  ${chalk.cyan("htype <sel> <text>")}    Human-like typing (variable speed)
  ${chalk.cyan("scroll [up|down] [n]")}  Scroll page
  ${chalk.cyan("eval <js>")}             Evaluate JavaScript
  ${chalk.cyan("wait <ms>")}             Wait for milliseconds

${chalk.bold("Other:")}
  ${chalk.cyan("help")}                  Show this help
  ${chalk.cyan("exit")}                  Exit
`;

export function registerInteractive(program) {
  program
    .command("interactive")
    .alias("repl")
    .description("Interactive browser REPL mode")
    .option("--proxy <proxy>", "Proxy server")
    .option("--cookies <file>", "Load cookies from Netscape-format file")
    .option("--no-headless", "Show browser window")
    .option("--url <url>", "Initial URL to open")
    .option("--profile <name>", "Use a browser profile")
    .option("--session <name>", "Use/restore a named session")
    .action(async (opts) => {
      opts = resolveOpts(opts);
      const spinner = ora("Launching stealth browser...").start();
      let handle;
      let lifecycle;
      let rl;
      let cleanupIncomplete = false;
      let lastCheckpointWarning = null;
      const signalGuard = createLaunchSignalGuard();
      const applyLifecycleResult = (result) => {
        if (result.usedCheckpointFallback && result.persistedAt) {
          log.warn(
            `Browser closed before a final live snapshot; using checkpoint from ${result.persistedAt}`,
          );
        }
        if (result.persistenceIncomplete) {
          const persistenceFailure = createLifecyclePersistenceCleanupFailure(result);
          if (persistenceFailure) log.warn(persistenceFailure.error.format());
        }
        if (result.cleanupErrors?.length > 0) {
          cleanupIncomplete = true;
          log.warn(formatCleanupFailures(
            result.cleanupErrors,
            "Browser cleanup was incomplete",
          ));
        }
        if (result.exitCode) process.exitCode = result.exitCode;
      };

      try {
        handle = await launchBrowser({
          headless: opts.headless,
          proxy: opts.proxy,
          profile: opts.profile,
          session: opts.session,
          forceDirect: opts.headless === false || Boolean(opts.cookies),
          handleSignals: false,
          restoreSessionUrl: !opts.url,
        });

        if (!handle.isDaemon) {
          lifecycle = createBrowserLifecycle(handle, {
            onCheckpointError(error) {
              if (error.message !== lastCheckpointWarning) {
                lastCheckpointWarning = error.message;
                log.warn(`State checkpoint failed; it will be retried: ${error.message}`);
              }
            },
          });
          signalGuard.transferTo(lifecycle);
        } else {
          signalGuard.dispose();
        }

        if (opts.cookies && !handle.isDaemon && lifecycle.phase === "running") {
          try {
            const { loadCookies } = await import("../cookies.js");
            const result = await loadCookies(handle.context, opts.cookies);
            if (lifecycle.phase === "running") log.info(result.message);
          } catch (error) {
            if (lifecycle.phase === "running") throw error;
          }
        }

        if (opts.url && (!lifecycle || lifecycle.phase === "running")) {
          try {
            await navigate(handle, opts.url);
            if (!handle.isDaemon && lifecycle.phase === "running") {
              await waitForReady(handle.page);
            }
          } catch (error) {
            if (!lifecycle || lifecycle.phase === "running") throw error;
          }
        }

        if (lifecycle && lifecycle.phase !== "running") {
          spinner.stop();
          const result = await lifecycle.wait();
          applyLifecycleResult(result);
          log.success("Bye! 🦊");
          return;
        }

        spinner.stop();

        console.log(chalk.bold("\n🦊 Stealth Browser Interactive Mode"));
        console.log(chalk.dim('Type "help" for commands, "exit" to quit.\n'));

        if (opts.url) {
          const currentUrl = await getUrl(handle);
          log.info(`Current page: ${describeUrl(currentUrl)}`);
        }

        rl = createInterface({
          input: process.stdin,
          output: process.stderr,
          prompt: chalk.green("stealth> "),
        });

        rl.prompt();

        rl.on("line", async (line) => {
          const input = line.trim();
          if (!input) {
            rl.prompt();
            return;
          }

          const [cmd, ...args] = input.split(/\s+/);
          const argStr = args.join(" ");

          try {
            switch (cmd.toLowerCase()) {
              case "goto":
              case "go":
              case "navigate": {
                if (!argStr) {
                  log.warn("Usage: goto <url>");
                  break;
                }
                const s = ora(`Navigating...`).start();
                await navigate(handle, argStr);
                if (!handle.isDaemon) await waitForReady(handle.page);
                s.stop();
                log.success(`→ ${await getUrl(handle)}`);
                break;
              }

              case "search": {
                if (args.length < 2) {
                  log.warn("Usage: search <engine> <query>");
                  break;
                }
                const engine = args[0];
                const query = args.slice(1).join(" ");
                const url = expandMacro(engine, query);
                if (!url) {
                  log.error(
                    `Unknown engine. Try: ${getSupportedEngines().join(", ")}`,
                  );
                  break;
                }
                const s = ora(`Searching ${engine}...`).start();
                await navigate(handle, url);
                if (!handle.isDaemon) await waitForReady(handle.page);
                s.stop();
                log.success(`→ ${await getUrl(handle)}`);
                break;
              }

              case "click": {
                if (!argStr) {
                  log.warn("Usage: click <selector> or click @<ref>");
                  break;
                }
                if (argStr.startsWith("@")) {
                  const ref = argStr.slice(1);
                  await clickRef(handle, ref);
                  log.success(`Clicked ref @${ref}`);
                } else {
                  if (handle.isDaemon) {
                    log.warn(
                      "CSS selector click requires direct mode. Use @ref instead.",
                    );
                    break;
                  }
                  await handle.page.click(argStr, { timeout: 5000 });
                  log.success("Clicked");
                }
                if (!handle.isDaemon)
                  await waitForReady(handle.page, { timeout: 2000 });
                break;
              }

              case "hclick": {
                if (!argStr) {
                  log.warn("Usage: hclick <selector>");
                  break;
                }
                if (handle.isDaemon) {
                  log.warn("hclick requires direct mode");
                  break;
                }
                await humanClick(handle.page, argStr);
                await waitForReady(handle.page, { timeout: 2000 });
                log.success("Human-clicked");
                break;
              }

              case "type": {
                if (args.length < 2) {
                  log.warn(
                    "Usage: type <selector> <text> or type @<ref> <text>",
                  );
                  break;
                }
                const target = args[0];
                const typedText = args.slice(1).join(" ");
                if (target.startsWith("@")) {
                  const ref = target.slice(1);
                  await typeRef(handle, ref, typedText);
                  log.success(`Typed "${typedText}" into ref @${ref}`);
                } else {
                  if (handle.isDaemon) {
                    log.warn(
                      "CSS selector type requires direct mode. Use @ref instead.",
                    );
                    break;
                  }
                  await handle.page.fill(target, typedText);
                  log.success(`Typed: "${typedText}"`);
                }
                break;
              }

              case "htype": {
                if (args.length < 2) {
                  log.warn("Usage: htype <selector> <text>");
                  break;
                }
                if (handle.isDaemon) {
                  log.warn("htype requires direct mode");
                  break;
                }
                await humanType(handle.page, args[0], args.slice(1).join(" "));
                log.success(`Human-typed: "${args.slice(1).join(" ")}"`);
                break;
              }

              case "scroll": {
                if (handle.isDaemon) {
                  log.warn("scroll requires direct mode");
                  break;
                }
                const direction = args[0] || "down";
                const scrolls = parseInt(args[1]) || 2;
                await humanScroll(handle.page, { direction, scrolls });
                log.success(`Scrolled ${direction}`);
                break;
              }

              case "snapshot": {
                const snapshot = await getSnapshot(handle);
                console.log(snapshot);
                break;
              }

              case "a11y": {
                const { tree, totalRefs } = await getA11ySnapshot(handle);
                console.log(tree);
                log.dim(
                  `${totalRefs} interactive elements (use click @ref or type @ref to interact)`,
                );
                break;
              }

              case "text": {
                const text = await getTextContent(handle);
                console.log(text);
                break;
              }

              case "title": {
                console.log(await getTitle(handle));
                break;
              }

              case "url": {
                console.log(await getUrl(handle));
                break;
              }

              case "links": {
                const links = await evaluate(
                  handle,
                  `
                  Array.from(document.querySelectorAll('a[href]'))
                    .filter(a => a.href.startsWith('http'))
                    .slice(0, 30)
                    .map(a => ({ text: a.textContent?.trim().slice(0, 60), url: a.href }))
                `,
                );
                if (links) {
                  links.forEach((l, i) =>
                    console.log(
                      `${chalk.dim(`${i + 1}.`)} ${l.text || "(no text)"}\n   ${chalk.cyan(l.url)}`,
                    ),
                  );
                  log.dim(`Total: ${links.length} links shown`);
                }
                break;
              }

              case "screenshot": {
                const file = argStr || "screenshot.png";
                await takeScreenshot(handle, { path: file });
                log.success(`Screenshot saved: ${file}`);
                break;
              }

              case "back": {
                if (handle.isDaemon) {
                  log.warn("back requires direct mode");
                  break;
                }
                await handle.page.goBack({ timeout: 10000 });
                log.success(`← ${handle.page.url()}`);
                break;
              }

              case "forward": {
                if (handle.isDaemon) {
                  log.warn("forward requires direct mode");
                  break;
                }
                await handle.page.goForward({ timeout: 10000 });
                log.success(`→ ${handle.page.url()}`);
                break;
              }

              case "reload": {
                if (handle.isDaemon) {
                  log.warn("reload requires direct mode");
                  break;
                }
                await handle.page.reload({ timeout: 30000 });
                log.success("Reloaded");
                break;
              }

              case "eval":
              case "js": {
                if (!argStr) {
                  log.warn("Usage: eval <javascript>");
                  break;
                }
                const result = await evaluate(handle, argStr);
                console.log(result);
                break;
              }

              case "wait": {
                const ms = parseInt(argStr) || 1000;
                await randomDelay(ms, ms);
                log.success(`Waited ${ms}ms`);
                break;
              }

              case "help":
              case "?": {
                console.log(HELP_TEXT);
                break;
              }

              case "exit":
              case "quit":
              case "q": {
                rl.close();
                return;
              }

              default:
                log.warn(`Unknown command: ${cmd}. Type "help" for commands.`);
            }
          } catch (err) {
            log.error(`${err.message}`);
          }

          if (!lifecycle || lifecycle.phase === "running") rl.prompt();
        });

        const readlineClosed = new Promise((resolve) => rl.once("close", resolve));

        if (lifecycle) {
          void readlineClosed
            .then(() => lifecycle.requestExit("readline-closed"))
            .catch(() => {});

          const result = await lifecycle.wait();
          rl.close();
          await readlineClosed;
          applyLifecycleResult(result);
        } else {
          await readlineClosed;
          await closeBrowser(handle);
        }

        if (cleanupIncomplete) {
          log.warn("Interactive browser exited with cleanup errors");
        } else {
          log.success("Bye! 🦊");
        }
      } catch (caughtError) {
        let err = caughtError;
        spinner.stop();
        signalGuard.dispose();
        if (rl) rl.close();

        const inheritedCleanupFailures = Array.isArray(err.cleanupFailures)
          ? err.cleanupFailures
          : [];
        const cleanupFailures = [...inheritedCleanupFailures];
        if (lifecycle) {
          try {
            const result = await lifecycle.requestExit("command-error");
            if (result.reason !== "command-error") {
              applyLifecycleResult(result);
              return;
            }
            const persistenceFailure = createLifecyclePersistenceCleanupFailure(result);
            if (persistenceFailure) {
              cleanupFailures.push(persistenceFailure);
            } else {
              cleanupFailures.push(...(result.cleanupErrors || []));
            }
          } catch (lifecycleError) {
            if (lifecycleError !== err) {
              if (lifecycleError instanceof PersistenceError) {
                cleanupFailures.push({ target: "persistence", error: lifecycleError });
              } else {
                cleanupFailures.push(...(
                  lifecycleError.cleanupFailures?.length > 0
                    ? lifecycleError.cleanupFailures
                    : [{ target: "lifecycle", error: lifecycleError }]
                ));
              }
            }
          }
        } else if (handle) {
          const cleanup = await closeBrowserForCli(handle, { log });
          cleanupFailures.push(...(cleanup.cleanupErrors || []));
        }
        attachCleanupFailures(
          err,
          cleanupFailures.slice(inheritedCleanupFailures.length),
        );
        const handledError = signalGuard.pendingSignal && !lifecycle
          ? attachCleanupFailures(
            new StealthError(`Interrupted by ${signalGuard.pendingSignal}`, {
              code: signalGuard.exitCode,
              cause: err,
            }),
            cleanupFailures,
          )
          : err;
        process.exitCode = handleError(handledError, { log, exit: false });
      }
    });
}

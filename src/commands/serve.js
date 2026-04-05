/**
 * stealth serve - Start an HTTP API server for external integrations
 *
 * Exposes stealth-cli capabilities as a REST API, compatible with
 * AI agents and other tools.
 */

import http from "http";
import crypto from "crypto";
import { log } from "../output.js";
import {
  createBrowser,
  createContext,
  extractPageText,
} from "../utils/browser-factory.js";
import { buildA11yTree, clickByRef, typeByRef } from "../a11y.js";

export function registerServe(program) {
  program
    .command("serve")
    .description("Start HTTP API server for AI agents and external tools")
    .option("-p, --port <port>", "Port number", "9377")
    .option("--host <host>", "Host to bind to", "127.0.0.1")
    .option("--proxy <proxy>", "Default proxy for all requests")
    .option("--no-headless", "Show browser window")
    .option(
      "--token <token>",
      "API token for authentication (auto-generated if not set)",
    )
    .option(
      "--no-auth",
      "Disable authentication (only recommended on localhost)",
    )
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const host = opts.host;
      const apiToken = opts.token || crypto.randomBytes(24).toString("hex");

      log.info("Starting stealth API server...");

      // Launch browser
      const browser = await createBrowser({ headless: opts.headless });

      // Page pool
      const pages = new Map(); // id → { page, context, lastUsed }
      const MAX_TABS = 20;
      let idCounter = 0;

      async function createPage() {
        // Evict oldest tab if limit reached
        if (pages.size >= MAX_TABS) {
          let oldestId = null;
          let oldestTime = Infinity;
          for (const [id, entry] of pages) {
            if (entry.lastUsed < oldestTime) {
              oldestTime = entry.lastUsed;
              oldestId = id;
            }
          }
          if (oldestId) {
            const old = pages.get(oldestId);
            await old.context.close().catch(() => {});
            pages.delete(oldestId);
          }
        }

        const context = await createContext(browser);
        const page = await context.newPage();
        const id = `tab-${++idCounter}`;
        pages.set(id, { page, context, lastUsed: Date.now() });
        return { id, page, context };
      }

      function getPage(id) {
        const entry = pages.get(id);
        if (!entry) return null;
        entry.lastUsed = Date.now();
        return entry;
      }

      // Parse JSON body
      function parseBody(req) {
        return new Promise((resolve) => {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            try {
              resolve(body ? JSON.parse(body) : {});
            } catch {
              resolve({});
            }
          });
        });
      }

      // JSON response helper
      function json(res, data, status = 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      }

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${host}:${port}`);
        const route = url.pathname;
        const method = req.method;

        try {
          const body = method === "POST" ? await parseBody(req) : {};

          // --- Health (no auth required) ---
          if (route === "/health") {
            return json(res, {
              ok: true,
              engine: "camoufox",
              pages: pages.size,
            });
          }

          // --- Auth check ---
          if (opts.auth !== false) {
            const authHeader = req.headers["authorization"];
            const token = authHeader
              ? authHeader.replace(/^Bearer\s+/i, "")
              : "";
            if (token !== apiToken) {
              return json(
                res,
                {
                  error:
                    'Unauthorized. Use: -H "Authorization: Bearer <token>"',
                },
                401,
              );
            }
          }

          // --- Create tab ---
          if (route === "/tabs" && method === "POST") {
            const { url: targetUrl } = body;
            const { id, page } = await createPage();
            if (targetUrl) {
              await page.goto(targetUrl, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
              });
            }
            return json(res, { ok: true, id, url: page.url() });
          }

          // --- List tabs ---
          if (route === "/tabs" && method === "GET") {
            const tabs = [];
            for (const [id, entry] of pages) {
              tabs.push({
                id,
                url: entry.page.url(),
                title: await entry.page.title().catch(() => ""),
              });
            }
            return json(res, { tabs });
          }

          // Tab-specific routes
          const tabMatch = route.match(/^\/tabs\/([^/]+)\/(.+)$/);
          if (tabMatch) {
            const [, tabId, action] = tabMatch;
            const entry = getPage(tabId);
            if (!entry) return json(res, { error: "Tab not found" }, 404);
            const { page } = entry;

            switch (action) {
              case "navigate": {
                const { url: navUrl } = body;
                await page.goto(navUrl, {
                  waitUntil: "domcontentloaded",
                  timeout: 30000,
                });
                return json(res, { ok: true, url: page.url() });
              }

              case "snapshot": {
                const snapshot = await page
                  .locator("body")
                  .ariaSnapshot({ timeout: 8000 })
                  .catch(() => "");
                return json(res, { ok: true, snapshot, url: page.url() });
              }

              case "text": {
                const text = await page.evaluate(extractPageText);
                return json(res, { ok: true, text, url: page.url() });
              }

              case "screenshot": {
                const buffer = await page.screenshot({ type: "png" });
                return json(res, {
                  ok: true,
                  data: buffer.toString("base64"),
                  mimeType: "image/png",
                });
              }

              case "click": {
                const { selector } = body;
                await page.click(selector, { timeout: 5000 });
                return json(res, { ok: true, url: page.url() });
              }

              case "type": {
                const { selector, text } = body;
                await page.fill(selector, text);
                return json(res, { ok: true });
              }

              case "evaluate": {
                const { expression } = body;
                const result = await page.evaluate(expression);
                return json(res, { ok: true, result });
              }

              case "a11y-snapshot": {
                const result = await buildA11yTree(page);
                return json(res, { ok: true, ...result, url: page.url() });
              }

              case "click-ref": {
                const { ref } = body;
                await clickByRef(page, ref);
                return json(res, { ok: true, url: page.url() });
              }

              case "type-ref": {
                const { ref, text, slowly, submit } = body;
                await typeByRef(page, ref, text, { slowly, submit });
                return json(res, { ok: true });
              }

              case "close": {
                await entry.context.close().catch(() => {});
                pages.delete(tabId);
                return json(res, { ok: true });
              }

              default:
                return json(res, { error: `Unknown action: ${action}` }, 400);
            }
          }

          // --- Close tab by DELETE ---
          const deleteMatch = route.match(/^\/tabs\/([^/]+)$/);
          if (deleteMatch && method === "DELETE") {
            const entry = getPage(deleteMatch[1]);
            if (entry) {
              await entry.context.close().catch(() => {});
              pages.delete(deleteMatch[1]);
            }
            return json(res, { ok: true });
          }

          // --- Shutdown ---
          if (route === "/shutdown" && method === "POST") {
            json(res, { ok: true, message: "Shutting down" });
            setTimeout(async () => {
              for (const [, e] of pages)
                await e.context.close().catch(() => {});
              await browser.close().catch(() => {});
              process.exit(0);
            }, 200);
            return;
          }

          json(res, { error: "Not found" }, 404);
        } catch (err) {
          json(res, { error: err.message }, 500);
        }
      });

      // Cleanup stale tabs every minute
      setInterval(() => {
        const now = Date.now();
        for (const [id, entry] of pages) {
          if (now - entry.lastUsed > 10 * 60 * 1000) {
            entry.context.close().catch(() => {});
            pages.delete(id);
          }
        }
      }, 60000);

      server.listen(port, host, () => {
        log.success(`Stealth API server running on http://${host}:${port}`);
        if (opts.auth !== false) {
          log.info(`API Token: ${apiToken}`);
          log.dim(`  Use: curl -H "Authorization: Bearer ${apiToken}" ...`);
        } else {
          log.warn("Authentication disabled (--no-auth)");
        }
        log.dim("  Endpoints:");
        log.dim("    GET  /health                    — Server status");
        log.dim("    POST /tabs                      — Create tab { url }");
        log.dim("    GET  /tabs                      — List tabs");
        log.dim("    POST /tabs/:id/navigate         — Navigate { url }");
        log.dim(
          "    GET  /tabs/:id/snapshot          — Accessibility snapshot",
        );
        log.dim("    GET  /tabs/:id/text              — Page text");
        log.dim("    GET  /tabs/:id/screenshot        — Screenshot (base64)");
        log.dim("    POST /tabs/:id/click             — Click { selector }");
        log.dim(
          "    POST /tabs/:id/type              — Type { selector, text }",
        );
        log.dim(
          "    POST /tabs/:id/evaluate          — Eval JS { expression }",
        );
        log.dim("    GET  /tabs/:id/a11y-snapshot     — A11y tree with refs");
        log.dim("    POST /tabs/:id/click-ref          — Click by ref { ref }");
        log.dim(
          "    POST /tabs/:id/type-ref           — Type by ref { ref, text }",
        );
        log.dim("    DELETE /tabs/:id                 — Close tab");
        log.dim("    POST /shutdown                   — Stop server");
      });

      // Graceful shutdown
      process.on("SIGINT", async () => {
        log.info("Shutting down...");
        for (const [, e] of pages) await e.context.close().catch(() => {});
        await browser.close().catch(() => {});
        server.close();
        process.exit(0);
      });
    });
}

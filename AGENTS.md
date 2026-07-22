# stealth-cli

Anti-detection browser CLI and SDK, powered by Camoufox (Firefox) + Playwright.

IMPORTANT: `camoufox-js` is a niche library with limited training data. Always read `src/browser.js` for actual API usage before writing code. Do NOT guess its API.

## Project Structure

```
bin/stealth.js           — CLI entry (Commander)
src/
  index.js               — SDK public API (re-exports all modules)
  browser.js             — Core: launch/close/navigate + state snapshots via camoufox-js
  browser-lifecycle.js   — Headed browser lifetime, signals, and durable checkpoints
  daemon.js              — Background browser server (unix socket ~/.stealth/daemon.sock)
  client.js              — HTTP client for daemon communication
  daemon-entry.js        — Daemon process entrypoint
  config.js              — Global config (~/.stealth/config.json)
  profiles.js            — Browser identity profiles ($STEALTH_HOME/profiles; default ~/.stealth/profiles/)
  session.js             — Session persistence (cookies + state under $STEALTH_HOME/sessions)
  cookies.js             — Netscape cookie file parser
  proxy-pool.js          — Proxy rotation pool
  humanize.js            — Human behavior simulation (scroll, mouse, type)
  retry.js               — Retry with exponential backoff
  macros.js              — Search engine URL templates
  output.js              — Output formatting (text/json/jsonl/markdown) + log helpers
  errors.js              — Error hierarchy with exit codes (used by all commands via handleError)
  mcp-server.js          — MCP server (stdio JSON-RPC) for AI agents
  utils/
    browser-factory.js   — Shared browser bootstrap (getHostOS, createBrowser, TEXT_EXTRACT_SCRIPT)
    close-browser-cli.js — CLI close wrapper that surfaces persistence and cleanup failures
    json-file.js         — Atomic owner-only writes for profile/session auth state
    resolve-opts.js      — Merge global config + CLI opts (used by all core commands)
    state-lock.js        — Single-writer profile/session locks held for browser lifetime
    storage-paths.js     — STEALTH_HOME profile/session/lock paths + strict state-name validation
  extractors/
    index.js             — Extractor registry (by engine name or URL)
    base.js              — Generic fallback extractor
    google.js            — Google search result extractor
    bing.js              — Bing extractor
    duckduckgo.js        — DuckDuckGo extractor
    github.js            — GitHub extractor
    youtube.js           — YouTube extractor
  commands/              — Commander subcommands (one file per command)
tests/
  unit/                  — Unit tests (no browser, no network)
  e2e/                   — E2E tests (real browser)
  fixtures/              — Test data (cookies.txt, urls.txt)
```

## Key Architecture Decisions

- **Two modes**: Direct mode (new browser per command) vs Daemon mode (reuse background browser via unix socket HTTP server)
- `browser.js` detects daemon automatically; headed, stateful, proxied, or `forceDirect` launches always bypass it
- `open` and direct `interactive` own SIGINT/SIGTERM/SIGHUP handling so state is checkpointed before shutdown
- Named profile/session browser state is lowercase-canonical and single-writer; browser lifetimes and standalone mutations use the same lease protocol
- State locks fail closed after crashes and are never auto-removed; users must verify ownership before removing the exact stale lock path reported by the CLI
- A session-only launch restores its linked profile; invalid state names, malformed state, or a missing linked profile fail before browser launch
- SDK `closeBrowser()` remains best-effort and retryable for incomplete cleanup, while CLI commands surface close-time persistence failures with a non-zero exit status
- All browser launch goes through `camoufox-js` `launchOptions()` → `playwright-core` `firefox.launch()`. Never use `chromium.launch()` or `playwright` (non-core)
- `STEALTH_HOME` overrides profile, session, and lock storage; config, proxy-pool, and daemon paths still use `~/.stealth`
- Daemon socket: `~/.stealth/daemon.sock`, PID: `~/.stealth/daemon.pid`

## camoufox-js API (DO NOT GUESS)

```js
import { launchOptions } from 'camoufox-js';  // Only named export used
import { firefox } from 'playwright-core';      // Only firefox, never chromium

const options = await launchOptions({
  headless: true,
  os: 'macos',        // 'macos' | 'windows' | 'linux'
  humanize: true,
  enable_cache: true,
  proxy: proxyObj,     // { server, username?, password? } | undefined
  geoip: !!proxy,
});
const browser = await firefox.launch(options);
```

- `launchOptions()` is async — always await
- Returns a Playwright launch options object, pass directly to `firefox.launch()`
- Proxy format: `{ server: 'http://host:port', username?, password? }`

## Error Handling

Custom error hierarchy in `src/errors.js`. Exit codes:
- 0=success, 1=general, 2=args, 3=browser launch, 4=navigation, 5=extraction, 6=timeout, 7=proxy, 8=profile/session/persistence error
- All errors extend `StealthError` with `.code`, `.hint`, `.format()`
- Use specific error classes: `BrowserLaunchError`, `BrowserCleanupError`, `NavigationError`, `ExtractionError`, `TimeoutError`, `ProxyError`, `ProfileError`, `PersistenceError`, `BlockedError`
- `handleError(err)` prints message + hint and calls `process.exit(code)`

## Coding Conventions

- ESM only (`"type": "module"`). Never use `require()`
- No TypeScript — plain JavaScript with JSDoc comments
- CLI framework: Commander. Do NOT switch to yargs/meow/oclif
- Output: `log.info/success/warn/error/dim` from `output.js` writes to stderr. Structured data goes to stdout
- `--format` flag: `text` (default), `json`, `jsonl`, `markdown`
- New commands go in `src/commands/<name>.js`, export a `register<Name>(program)` function, register in `bin/stealth.js`
- New extractors go in `src/extractors/<engine>.js`, export `name`, `canHandle(url)`, `extractResults(page, max)`, register in `extractors/index.js`

## Commands

```bash
npm test                    # Run all tests (vitest)
npm run test:unit           # Unit tests only
npm run test:e2e            # E2E tests only (needs browser)
node bin/stealth.js <cmd>   # Run CLI
npx camoufox-js fetch       # Download/update Camoufox browser
```

## Dependencies (DO NOT ADD ALTERNATIVES)

- `camoufox-js` — Anti-detection browser engine. No alternatives
- `playwright-core` — Browser automation. Not `playwright` (which bundles browsers)
- `commander` — CLI framework
- `chalk` — Terminal colors
- `ora` — Spinners
- `vitest` — Test runner (devDep)

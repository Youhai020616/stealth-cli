# stealth-cli

Anti-detection browser CLI and SDK, powered by Camoufox (Firefox) + Playwright.

IMPORTANT: `camoufox-js` is a niche library with limited training data. Always read `src/browser.js` for actual API usage before writing code. Do NOT guess its API.

## Project Structure

```
bin/stealth.js           — CLI entry (Commander)
src/
  index.js               — SDK public API (re-exports all modules)
  browser.js             — Core: launch/close/navigate via camoufox-js
  daemon.js              — Background browser server (unix socket ~/.stealth/daemon.sock)
  client.js              — HTTP client for daemon communication
  daemon-entry.js        — Daemon process entrypoint
  config.js              — Global config (~/.stealth/config.json)
  profiles.js            — Browser identity profiles (~/.stealth/profiles/)
  session.js             — Session persistence (cookies + state)
  cookies.js             — Netscape cookie file parser
  proxy-pool.js          — Proxy rotation pool
  humanize.js            — Human behavior simulation (scroll, mouse, type)
  retry.js               — Retry with exponential backoff
  macros.js              — Search engine URL templates
  output.js              — Output formatting (text/json/jsonl/markdown) + log helpers
  errors.js              — Error hierarchy with exit codes
  mcp-server.js          — MCP server (stdio JSON-RPC) for AI agents
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
- `browser.js` detects daemon automatically — if running, all commands route through HTTP client; otherwise launch a new browser
- All browser launch goes through `camoufox-js` `launchOptions()` → `playwright-core` `firefox.launch()`. Never use `chromium.launch()` or `playwright` (non-core)
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
- 0=success, 1=general, 2=args, 3=browser launch, 4=navigation, 5=extraction, 6=timeout, 7=proxy, 8=profile
- All errors extend `StealthError` with `.code`, `.hint`, `.format()`
- Use specific error classes: `BrowserLaunchError`, `NavigationError`, `ExtractionError`, `TimeoutError`, `ProxyError`, `ProfileError`, `BlockedError`
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

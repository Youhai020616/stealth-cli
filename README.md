<div align="center">
  <h1>🦊 stealth-cli</h1>
  <p><strong>Anti-detection browser CLI powered by Camoufox</strong></p>
  <p>Browse, search, scrape, and crawl the web with C++ level fingerprint spoofing.<br/>Bypasses Cloudflare, Google, and most bot detection systems.</p>
  <p>
    <a href="https://www.npmjs.com/package/stealth-cli"><img src="https://img.shields.io/npm/v/stealth-cli?color=blue" alt="npm version" /></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
    <a href="https://camoufox.com"><img src="https://img.shields.io/badge/engine-Camoufox-red" alt="Camoufox" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-green" alt="Node" />
    <img src="https://img.shields.io/badge/tests-201%20passing-brightgreen" alt="Tests" />
  </p>
</div>

<p align="center">
  <img src="./demo.gif" alt="stealth-cli demo" width="720">
</p>

---

## Why

Headless Chrome gets fingerprinted. Playwright gets blocked. Stealth plugins become the fingerprint.

**stealth-cli** uses [Camoufox](https://camoufox.com) — a Firefox fork that patches fingerprint generation at the **C++ implementation level**. No JavaScript shims, no wrappers, no tells. The browser reports spoofed values natively.

Wrap that in a developer-friendly CLI with 17 commands, and you get a tool that both humans and AI agents can use.

### How it compares

| Approach | Detection Risk | Why |
|----------|:---:|------|
| Puppeteer + stealth plugin | 🔴 High | JS-level patches are detectable; Chromium TLS fingerprint is a giveaway |
| Playwright + custom args | 🟡 Medium | Better, but `navigator.webdriver` workarounds are fragile |
| undetected-chromedriver | 🟡 Medium | Patches Chrome binary, but still Chromium-based fingerprint |
| **stealth-cli (Camoufox)** | 🟢 Low | Firefox fork with C++ native spoofing; no JS shims to detect |

## Install

```bash
npm install -g stealth-cli
```

> First run downloads the Camoufox browser binary (~300MB). Subsequent runs are instant.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/Youhai020616/stealth-cli.git
cd stealth-cli
npm install        # Installs deps + downloads Camoufox browser
npm link           # Makes 'stealth' command globally available
```

</details>

## Quick Start

```bash
stealth browse https://example.com                          # Visit a page
stealth screenshot https://example.com -o page.png          # Screenshot
stealth search google "best coffee beans" -f json           # Search Google
stealth extract https://example.com --links                 # Extract links
stealth crawl https://example.com -d 2 -l 50 -o out.jsonl  # Crawl
stealth profile create work --preset us-laptop              # Create a saved identity once
stealth open https://example.com --profile work              # Human login flow
stealth interactive --url https://example.com               # REPL mode
```

## How Anti-Detection Works

```
stealth-cli (Node.js CLI)
  └── camoufox-js (npm binding)
       └── Camoufox (C++ Firefox fork)
            └── Fingerprint spoofing at the native level
```

| Fingerprint Vector | Approach |
|---|---|
| `navigator.hardwareConcurrency` | Spoofed in C++ |
| `navigator.webdriver` | Always `false` |
| WebGL renderer / vendor | Spoofed in C++ |
| AudioContext fingerprint | Spoofed in C++ |
| Canvas fingerprint | Spoofed in C++ |
| Screen geometry | Spoofed in C++ |
| WebRTC leak | Built-in protection |
| TLS fingerprint | Firefox native (not Chromium) |

No JavaScript shims. No detectable wrappers. The browser natively reports spoofed values.

## Commands

### Core (12)

| Command | Description |
|---------|-------------|
| `browse <url>` | Visit URL, print content (text/json/snapshot/markdown) |
| `screenshot <url>` | Screenshot (PNG/JPEG, full page, custom viewport) |
| `search <engine> <query>` | Search 14 engines with anti-detection |
| `extract <url>` | Extract links, images, meta, headings, CSS selectors |
| `crawl <url>` | Recursive crawling with depth/filter/delay control |
| `open [url]` | Headed browser for human authentication; exits when all windows close |
| `interactive` | Stdin-driven REPL with 20+ commands (goto, click, type, eval...) |
| `pdf <url>` | Save page as PDF |
| `batch <file>` | Batch process URLs from file |
| `monitor <url>` | Watch for changes (price drops, stock alerts) |
| `fingerprint` | Check fingerprint & anti-detection status |
| `serve` | HTTP API server with Bearer token auth |

### Management (5)

| Command | Description |
|---------|-------------|
| `daemon start/stop/status` | Background browser (~1s vs ~6s startup) |
| `profile create/list/delete` | Persistent identities (8 presets + random) |
| `proxy add/list/test` | Proxy pool with rotation & health checking |
| `config set/get/list/reset` | Global defaults (~/.stealth/config.json) |
| `mcp` | MCP server for Claude Desktop / Cursor |

---

## Usage Examples

### Browse

```bash
stealth browse https://example.com                       # Text output
stealth browse https://example.com -f json               # JSON with metadata
stealth browse https://example.com -f snapshot            # Accessibility tree
stealth browse https://example.com --humanize             # Human behavior simulation
stealth profile create work --preset us-desktop           # Create a saved identity once
stealth browse https://example.com --profile work         # Reuse the saved identity
stealth browse https://example.com --proxy http://proxy:8080
```

### Search

Google uses a special anti-detection flow: visits homepage → types query with human-like timing → presses Enter.

```bash
stealth search google "web scraping tools" -f json       # Auto-humanized
stealth search google "query" -f json --warmup           # Visit random site first
stealth search duckduckgo "privacy browser" -f json
stealth search youtube "tutorial" -f json                # Video metadata
stealth search github "camoufox" -f json                 # Repo results
```

**14 engines:** google · bing · duckduckgo · youtube · github · amazon · reddit · wikipedia · twitter · linkedin · tiktok · stackoverflow · npmjs · yelp

### Extract

```bash
stealth extract https://example.com --links              # All links
stealth extract https://example.com --images             # All images
stealth extract https://example.com --meta               # Title, description, OG
stealth extract https://example.com --headers            # h1-h6 headings
stealth extract https://example.com -s ".price" --all    # CSS selector
stealth extract https://example.com -s "a" -a "href" --all  # Attributes
```

### Crawl

```bash
stealth crawl https://example.com -d 2 -l 50            # Depth 2, max 50 pages
stealth crawl https://example.com -o results.jsonl       # Save to file
stealth crawl https://example.com --include "blog"       # URL regex filter
stealth crawl https://example.com --delay 2000 --humanize
stealth crawl https://example.com --proxy-rotate         # Rotate per page
```

### Monitor

```bash
stealth monitor https://shop.com/item -s ".price" -i 60  # Check every 60s
stealth monitor https://shop.com/item --contains "In Stock"
stealth monitor https://example.com --not-contains "Sold Out"
```

### Headed Browser for Human Authentication

```bash
# Create the identity once, then open a browser that lives until its windows close
stealth profile create work --preset us-laptop
stealth open https://example.com/login --profile work

# Named sessions can be checkpointed at the same time
stealth open --url https://example.com/login --profile work --session login-flow
```

`open` is always headed and always uses a direct browser, even when the daemon is running. It ignores stdin, checkpoints cookies every second, performs a final live save when the last page closes, and gracefully handles `SIGHUP`, `SIGINT`, and `SIGTERM` on POSIX systems. If the browser process exits before a final live capture, the latest durable checkpoint is retained and a warning is printed. `--checkpoint-interval` accepts integer values from `250` through `60000` ms (default: `1000`).

### Interactive REPL

```bash
stealth interactive --url https://example.com
stealth interactive --no-headless --profile work --session debugging

stealth> goto https://google.com
stealth> click "button.submit"
stealth> hclick "a.link"              # Human-like click (bezier curve)
stealth> type "input[name=q]" hello
stealth> htype "input[name=q]" hello  # Human-like typing (variable speed)
stealth> scroll down 3
stealth> text / snapshot / links      # Inspect page
stealth> screenshot page.png
stealth> eval document.title
stealth> exit
```

---

## Key Features

### Daemon Mode

Keep a browser alive in the background for instant command execution.

```bash
stealth daemon start                   # Start background browser
stealth browse https://example.com     # ~1.2s (vs ~6s cold start)
stealth daemon stop                    # Shut down (auto-stops after 5min idle)
```

### Browser Profiles

Persistent identities with unique fingerprints. Cookies auto-save between sessions.

```bash
stealth profile create work --preset us-desktop
stealth profile create rand1 --random

stealth browse https://example.com --profile work
# → Fingerprint: Windows, en-US, America/New_York

# Human-assisted login; cookies are checkpointed while the browser is open
stealth open https://example.com/login --profile work
```

**8 presets:** `us-desktop` · `us-laptop` · `uk-desktop` · `de-desktop` · `jp-desktop` · `cn-desktop` · `mobile-ios` · `mobile-android`

### Session Persistence

```bash
# Link a named session to the existing work profile
stealth browse https://example.com --session my-task --profile work
# → Cookies + URL + history saved

# Session-only open restores the linked work profile and the saved URL
stealth open --session my-task

# An explicit initial URL skips the session's saved URL
stealth open https://other.com --session my-task
```

When `--profile` and `--session` are combined, the profile is the canonical cookie source and the session restores URL/history metadata. A session already linked to a different profile is rejected instead of merging two identities. When only `--session` is supplied, a linked profile is restored automatically. For `open` and `interactive`, an explicit initial URL takes precedence: stealth-cli skips the saved session URL before navigating to the requested URL.

> **Behavior/security change:** Profile and session names may contain only ASCII letters, numbers, underscores, and hyphens (`[A-Za-z0-9_-]+`) and are stored as lowercase canonical names. Existing mixed-case filenames are resolved case-insensitively; if an older release sanitized a name such as `work.prod`, use the basename shown by `stealth profile list` or `stealth session list` (for example, `work_prod`). If a session links to a profile that no longer exists, startup fails before the browser launches instead of silently falling back to a different identity.

Named profile and session browser state is single-writer. Browser lifetimes and standalone create/save/delete operations all participate in the same lock protocol, so concurrent mutation fails instead of mixing identities. Lock files are never removed automatically after a crash: when the recorded owner is no longer running, stealth-cli prints the exact lock path and requires explicit removal after you confirm no process still owns that state. Profile and session JSON files contain authentication material; writes are atomic, directories use owner-only permissions (`0700`), and files use `0600` on supported POSIX platforms.

By default, profiles, sessions, and their locks live under `~/.stealth`. Set `STEALTH_HOME` to relocate those paths together. The configured state root and child paths must not be symlinks. Configuration (`config.json`), proxy-pool (`proxies.json`), and daemon socket/PID paths remain under `~/.stealth` in the current source. A hard browser crash can only preserve state captured by the most recent checkpoint; `open` defaults to a one-second interval.

### Proxy Pool

```bash
stealth proxy add http://proxy1:8080 --label us --region US
stealth proxy add http://proxy2:8080 --label eu --region EU
stealth proxy test                                   # Health check
stealth browse https://example.com --proxy-rotate    # Auto-rotate
```

GeoIP: Camoufox auto-matches locale, timezone, and geolocation to proxy exit IP.

### Humanize Mode

Simulate human behavior patterns to avoid behavioral detection:

```bash
stealth browse https://example.com --humanize
stealth search google "query" --humanize --warmup
```

- Gaussian-distributed delays between actions
- Bézier-curve mouse movements
- Variable typing speed
- Random scroll patterns

### Global Configuration

Set defaults so you don't repeat flags:

```bash
stealth config set locale zh-CN
stealth config set humanize true
stealth config set retries 3
stealth config set format json
stealth config list
```

All core commands respect global config. CLI flags always override.

### Pipe-Friendly

stdout = data, stderr = status. Compose with Unix tools:

```bash
stealth browse https://api.example.com -f json | jq '.title'
stealth search google "query" -f json | jq '.results[].url'
stealth extract https://example.com --links -f json | jq '.data[].url'
```

---

## Integrations

### HTTP API Server

Run stealth-cli as a service for programmatic access:

```bash
stealth serve --port 9377
# → Prints auto-generated API token on startup

curl localhost:9377/health                                          # No auth

curl -X POST localhost:9377/tabs \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'                               # Create tab

curl localhost:9377/tabs/tab-1/text -H 'Authorization: Bearer <token>'  # Get text
```

**Options:** `--token <custom>` · `--no-auth` (localhost only) · `--host 0.0.0.0`

**Endpoints:** `/health` · `/tabs` (POST/GET) · `/tabs/:id/navigate` · `/tabs/:id/text` · `/tabs/:id/snapshot` · `/tabs/:id/screenshot` · `/tabs/:id/click` · `/tabs/:id/type` · `/tabs/:id/evaluate` · `/tabs/:id` (DELETE) · `/shutdown`

### MCP Server (Claude Desktop / Cursor)

Add stealth browsing capabilities to your AI coding assistant:

```json
{
  "mcpServers": {
    "stealth": {
      "command": "stealth",
      "args": ["mcp"]
    }
  }
}
```

**7 tools:** `stealth_browse` · `stealth_screenshot` · `stealth_search` · `stealth_extract` · `stealth_click` · `stealth_type` · `stealth_evaluate`

### SDK (Library Mode)

Use stealth-cli programmatically in your Node.js applications. The `work` profile must be created first, either with `stealth profile create work --preset us-desktop` or the SDK's `createProfile('work', { preset: 'us-desktop' })` API.

```javascript
import { launchBrowser, closeBrowser, navigate, getTextContent } from 'stealth-cli';

const handle = await launchBrowser({ profile: 'work', humanize: true });
await navigate(handle, 'https://example.com');
const text = await getTextContent(handle);
await closeBrowser(handle);
```

---

## Error Handling

stealth-cli provides structured errors with contextual hints:

```
✖ Failed to navigate to https://example.com
  Hint: Page load timed out. Try --wait <ms> or --retries <n>

✖ Google detected automation and blocked the request
  Hint: Try: --proxy <proxy>, --warmup, --humanize, or use a different engine

✖ Profile "work" not found
  Hint: Create with: stealth profile create work
```

Exit codes: `0` success · `1` general error · `2` invalid arguments · `3` browser launch · `4` navigation/blocked · `5` extraction · `6` timeout · `7` proxy · `8` profile/session/persistence

## Common Options

Option availability varies by command; run `stealth <command> --help` for the exact set.

| Option | Description |
|--------|-------------|
| `--proxy <url>` | Use proxy server |
| `--proxy-rotate` | Rotate through proxy pool |
| `--profile <name>` | Use saved browser identity |
| `--session <name>` | Persist/restore browsing session |
| `--cookies <file>` | Import Netscape-format cookie file |
| `--humanize` | Simulate human behavior |
| `--retries <n>` | Max retries on failure |
| `--no-headless` | Show browser window on commands that default to headless |
| `--checkpoint-interval <ms>` | `open` authentication-state checkpoint interval (`250`–`60000`; default: `1000`) |
| `-f, --format` | Output format: text, json, jsonl, snapshot, markdown |

## Project Stats

```
Version:     0.6.1
Commands:    17
Tests:       201 passing (23 test files)
Source:      8,066 lines (45 JavaScript files under `src/`)
Extractors:  6 (Google, Bing, DuckDuckGo, YouTube, GitHub, generic)
Presets:     8 browser profiles
Engine:      Camoufox (C++ Firefox fork)
License:     MIT
```

## Contributing

Contributions welcome! Some areas where help is appreciated:

- **New extractors** — Add structured parsing for more search engines/sites
- **Profile presets** — More realistic browser fingerprint configurations
- **Bug reports** — Especially sites that still detect stealth-cli
- **Documentation** — Usage guides, tutorials, examples

Please open an issue to discuss larger changes before submitting a PR.

## Star History

<a href="https://star-history.com/#Youhai020616/stealth-cli&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Youhai020616/stealth-cli&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Youhai020616/stealth-cli&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Youhai020616/stealth-cli&type=Date" />
  </picture>
</a>

## 🔗 Ecosystem

| Project | Description |
|---------|-------------|
| [AgentMind](https://github.com/Youhai020616/Agentmind) | Self-learning memory system for AI agents |
| [stealth-x](https://github.com/Youhai020616/stealth-x) | Anti-detection X/Twitter automation (built on stealth-cli) |
| [dy-cli](https://github.com/Youhai020616/douyin) | Douyin/TikTok CLI |
| [xiaohongshu](https://github.com/Youhai020616/xiaohongshu) | Xiaohongshu automation |
| [freepost](https://github.com/Youhai020616/freepost-saas) | AI social media management |

## Acknowledgments

- [Camoufox](https://camoufox.com) — The Firefox fork that makes this possible
- [Playwright](https://playwright.dev) — Browser automation framework

## License

[MIT](./LICENSE)

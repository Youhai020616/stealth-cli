<div align="center">
  <h1>🦊 stealth-cli</h1>
  <p><strong>Anti-detection browser CLI powered by Camoufox</strong></p>
  <p>Browse, search, scrape, and crawl the web with C++ level fingerprint spoofing.<br/>Bypasses Cloudflare, Google, and most bot detection systems.</p>
  <p>
    <a href="https://www.npmjs.com/package/stealth-cli"><img src="https://img.shields.io/npm/v/stealth-cli?color=blue" alt="npm version" /></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
    <a href="https://camoufox.com"><img src="https://img.shields.io/badge/engine-Camoufox-red" alt="Camoufox" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node" />
    <img src="https://img.shields.io/badge/tests-151%20passing-brightgreen" alt="Tests" />
  </p>
</div>

---

## Why

Headless Chrome gets fingerprinted. Playwright gets blocked. Stealth plugins become the fingerprint.

**stealth-cli** uses [Camoufox](https://camoufox.com) — a Firefox fork that patches fingerprint generation at the **C++ implementation level**. No JavaScript shims, no wrappers, no tells. The browser reports spoofed values natively.

Wrap that in a developer-friendly CLI with 16 commands, and you get a tool that both humans and AI agents can use.

## Install

```bash
npm install -g stealth-cli
```

> First run downloads the Camoufox browser binary (~300MB). Subsequent runs are instant.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/user/stealth-cli.git
cd stealth-cli
npm install        # Installs deps + downloads Camoufox browser
npm link           # Makes 'stealth' command globally available
```

</details>

## Quick Start

```bash
stealth browse https://example.com                       # Visit a page
stealth screenshot https://example.com -o page.png       # Screenshot
stealth search google "best coffee beans" -f json        # Search Google
stealth extract https://example.com --links              # Extract links
stealth crawl https://example.com -d 2 -l 50 -o out.jsonl  # Crawl
stealth interactive --url https://example.com            # REPL mode
```

## Commands

### Core (11)

| Command | Description |
|---------|-------------|
| `browse <url>` | Visit URL, print content (text/json/snapshot/markdown) |
| `screenshot <url>` | Screenshot (PNG/JPEG, full page, custom viewport) |
| `search <engine> <query>` | Search 14 engines with anti-detection |
| `extract <url>` | Extract links, images, meta, headings, CSS selectors |
| `crawl <url>` | Recursive crawling with depth/filter/delay control |
| `interactive` | REPL with 20+ commands (goto, click, type, eval...) |
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
stealth browse https://example.com --profile us-desktop   # Saved identity
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

**14 engines:** google, bing, duckduckgo, youtube, github, amazon, reddit, wikipedia, twitter, linkedin, tiktok, stackoverflow, npmjs, yelp

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

### Interactive REPL

```bash
stealth interactive --url https://example.com

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
```

**8 presets:** `us-desktop` · `us-laptop` · `uk-desktop` · `de-desktop` · `jp-desktop` · `cn-desktop` · `mobile-ios` · `mobile-android`

### Session Persistence

```bash
stealth browse https://example.com --session my-task --profile work
# → Cookies + URL + history saved

stealth browse https://other.com --session my-task
# → Auto-restores cookies and last URL
```

### Proxy Pool

```bash
stealth proxy add http://proxy1:8080 --label us --region US
stealth proxy add http://proxy2:8080 --label eu --region EU
stealth proxy test                                   # Health check
stealth browse https://example.com --proxy-rotate    # Auto-rotate
```

GeoIP: Camoufox auto-matches locale, timezone, and geolocation to proxy exit IP.

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

stdout = data, stderr = status:

```bash
stealth browse https://api.example.com -f json | jq '.title'
stealth search google "query" -f json | jq '.results[].url'
stealth extract https://example.com --links -f json | jq '.data[].url'
```

---

## Integrations

### HTTP API Server

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

```javascript
import { launchBrowser, closeBrowser, navigate, getTextContent } from 'stealth-cli';

const handle = await launchBrowser({ profile: 'us-desktop', humanize: true });
await navigate(handle, 'https://example.com');
const text = await getTextContent(handle);
await closeBrowser(handle);
```

---

## How Anti-Detection Works

```
stealth-cli
  └── camoufox-js (npm)
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

Exit codes: `0` success · `3` browser launch · `4` navigation/blocked · `5` extraction · `7` proxy · `8` profile

## Common Options

Available on all core commands:

| Option | Description |
|--------|-------------|
| `--proxy <url>` | Use proxy server |
| `--proxy-rotate` | Rotate through proxy pool |
| `--profile <name>` | Use saved browser identity |
| `--session <name>` | Persist/restore browsing session |
| `--cookies <file>` | Import Netscape-format cookie file |
| `--humanize` | Simulate human behavior |
| `--retries <n>` | Max retries on failure |
| `--no-headless` | Show browser window |
| `-f, --format` | Output format: text, json, jsonl, snapshot, markdown |

## Project Stats

```
Version:     0.6.0
Commands:    16
Tests:       151 passing (18 test files)
Source:      5,900 lines (39 source files)
Extractors:  6 (Google, Bing, DuckDuckGo, YouTube, GitHub, generic)
Presets:     8 browser profiles
Engine:      Camoufox (C++ Firefox fork)
License:     MIT
```

## License

MIT

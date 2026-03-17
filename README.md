<div align="center">
  <h1>🦊 stealth-cli</h1>
  <p><strong>Anti-detection browser CLI powered by Camoufox</strong></p>
  <p>Browse, search, scrape, and crawl the web with C++ level fingerprint spoofing.<br/>Bypasses Cloudflare, Google, and most bot detection systems.</p>
  <p>
    <a href="https://www.npmjs.com/package/stealth-cli"><img src="https://img.shields.io/npm/v/stealth-cli?color=blue" alt="npm version" /></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
    <a href="https://camoufox.com"><img src="https://img.shields.io/badge/engine-Camoufox-red" alt="Camoufox" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node" />
    <img src="https://img.shields.io/badge/tests-90%20passing-brightgreen" alt="Tests" />
  </p>
</div>

---

## Demo

<p align="center">
  <img src="demo.gif" alt="stealth-cli demo" width="800" />
</p>

## Why

Headless Chrome gets fingerprinted. Playwright gets blocked. Stealth plugins become the fingerprint.

**stealth-cli** uses [Camoufox](https://camoufox.com) — a Firefox fork that patches fingerprint generation at the **C++ implementation level**. No JavaScript shims, no wrappers, no tells. The browser reports spoofed values natively.

Wrap that in a developer-friendly CLI with 16 commands, and you get a tool that both humans and AI agents can use.

## Install

```bash
# From npm (recommended)
npm install -g stealth-cli

# From source
git clone https://github.com/user/stealth-cli.git
cd stealth-cli
npm install        # Installs deps + downloads Camoufox browser (~300MB)
npm link           # Makes 'stealth' command globally available
```

> First run downloads the Camoufox browser binary (~300MB). Subsequent runs are instant.

## Quick Start

```bash
# Browse a page with anti-detection
stealth browse https://example.com

# Take a screenshot
stealth screenshot https://example.com -o page.png

# Search Google without getting blocked
stealth search google "best coffee beans" -f json

# Extract all links from a page
stealth extract https://example.com --links

# Crawl a site
stealth crawl https://example.com --depth 2 --limit 50 -o results.jsonl

# Interactive browsing (REPL)
stealth interactive --url https://example.com
```

## Commands

### Core (11 commands)

| Command | Description |
|---------|-------------|
| `stealth browse <url>` | Visit URL, print page content (text/json/snapshot) |
| `stealth screenshot <url>` | Take a screenshot (PNG/JPEG, full page, custom size) |
| `stealth search <engine> <query>` | Search with anti-detection (14 engines) |
| `stealth extract <url>` | Extract links, images, meta, headings, CSS selectors |
| `stealth crawl <url>` | Recursive crawling with depth/filter/delay control |
| `stealth interactive` | Interactive REPL with 20+ browsing commands |
| `stealth pdf <url>` | Save page as PDF / full-page screenshot |
| `stealth batch <file>` | Batch process URLs from a file |
| `stealth monitor <url>` | Watch a page for changes (price drops, stock alerts) |
| `stealth fingerprint` | Check browser fingerprint & anti-detection status |
| `stealth serve` | Start HTTP API server for external integrations |

### Management (5 commands)

| Command | Description |
|---------|-------------|
| `stealth daemon start/stop/status` | Background browser for instant startup (~1s vs ~6s) |
| `stealth profile create/list/delete` | Persistent browser identities (8 presets + random) |
| `stealth proxy add/list/test` | Proxy pool with rotation and health checking |
| `stealth config set/get/list/reset` | Global defaults (~/.stealth/config.json) |
| `stealth mcp` | MCP server for Claude Desktop / Cursor |

---

## Usage

### Browse

```bash
stealth browse https://example.com                      # Text output
stealth browse https://example.com -f json              # JSON with metadata
stealth browse https://example.com -f snapshot           # Accessibility tree
stealth browse https://example.com --humanize            # Human behavior simulation
stealth browse https://example.com --profile us-desktop  # Use saved identity
stealth browse https://example.com --proxy http://proxy:8080
```

### Screenshot

```bash
stealth screenshot https://example.com -o page.png
stealth screenshot https://example.com --full            # Full page
stealth screenshot https://example.com --width 1920 --height 1080
```

### Search

14 supported engines with structured result extraction.

Google uses a special anti-detection flow: visits homepage → types query → presses Enter (not direct URL).

```bash
stealth search google "web scraping tools" -f json       # Auto-humanized
stealth search google "query" -f json --warmup           # Extra: visit random site first
stealth search duckduckgo "privacy browser" -f json
stealth search bing "anti-detect browser" -f json
stealth search youtube "tutorial" -f json                # Video metadata
stealth search github "camoufox" -f json                 # Repo results
stealth search amazon "mechanical keyboard" -f json
```

**All 14 engines:** google, bing, duckduckgo, youtube, github, amazon, reddit, wikipedia, twitter, linkedin, tiktok, stackoverflow, npmjs, yelp

### Extract

```bash
stealth extract https://example.com --links              # All links
stealth extract https://example.com --images             # All images
stealth extract https://example.com --meta               # Title, description, OG tags
stealth extract https://example.com --headers            # h1-h6 headings
stealth extract https://example.com -s ".price" --all    # CSS selector
stealth extract https://example.com -s "a" -a "href" --all  # Attributes
```

### Crawl

```bash
stealth crawl https://example.com -d 2 -l 50             # Depth 2, max 50 pages
stealth crawl https://example.com -o results.jsonl        # Save to file
stealth crawl https://example.com --include "blog"        # URL regex filter
stealth crawl https://example.com --exclude "login|admin"
stealth crawl https://example.com --delay 2000 --humanize # Human-like crawling
stealth crawl https://example.com --proxy-rotate          # Rotate through proxy pool
```

### Monitor

Watch pages for changes — ideal for price tracking, stock alerts, content monitoring.

```bash
stealth monitor https://shop.com/item -s ".price" -i 60  # Check price every 60s
stealth monitor https://shop.com/item --contains "In Stock"
stealth monitor https://example.com --not-contains "Sold Out"
stealth monitor https://example.com --json -n 10          # JSON output, 10 checks max
```

### Batch

```bash
echo "https://example.com
https://github.com
https://httpbin.org/ip" > urls.txt

stealth batch urls.txt -c browse --skip-errors            # Browse all
stealth batch urls.txt -c screenshot -o ./screenshots/    # Screenshot all
stealth batch urls.txt -c extract -s "h1"                 # Extract from all
```

### Fingerprint

```bash
stealth fingerprint                   # Show current browser fingerprint
stealth fingerprint --check           # Run anti-detection tests (CreepJS, WebDriver)
stealth fingerprint --compare 3       # Launch 3 times, compare if fingerprints vary
stealth fingerprint --profile jp-desktop --json
```

### Interactive REPL

```bash
stealth interactive --url https://example.com

stealth> goto https://google.com
stealth> search duckduckgo hello world
stealth> click "button.submit"
stealth> hclick "a.link"              # Human-like click (mouse movement)
stealth> type "input[name=q]" hello
stealth> htype "input[name=q]" hello  # Human-like typing (variable speed)
stealth> scroll down 3
stealth> text                         # Page text
stealth> snapshot                     # Accessibility tree
stealth> links                        # All links
stealth> screenshot page.png
stealth> eval document.title          # Run JavaScript
stealth> back / forward / reload
stealth> exit
```

---

## Daemon Mode

Keep a browser alive in the background. Commands reuse it instantly.

```bash
stealth daemon start                   # Start background browser
stealth browse https://example.com     # ~1.2s (vs ~6s cold start)
stealth browse https://other.com       # ~1.2s
stealth daemon status                  # Check status
stealth daemon stop                    # Shut down (auto-stops after 5min idle)
```

## Browser Profiles

Persistent browser identities with unique fingerprints. Cookies auto-save between sessions.

```bash
stealth profile create work --preset us-desktop
stealth profile create japan --preset jp-desktop
stealth profile create rand1 --random               # Random fingerprint
stealth profile list
stealth profile presets                              # Show all 8 presets

# Use profile — fingerprint + cookies auto-applied
stealth browse https://example.com --profile work
# → User-Agent: Windows, locale: en-US, timezone: America/New_York
```

**Presets:** `us-desktop` · `us-laptop` · `uk-desktop` · `de-desktop` · `jp-desktop` · `cn-desktop` · `mobile-ios` · `mobile-android`

## Session Persistence

Save and restore browsing sessions (cookies + last URL + history).

```bash
stealth browse https://example.com --session my-task --profile work
# → Cookies saved, URL remembered

# Later: auto-restores cookies and navigates to last URL
stealth browse https://other.com --session my-task
```

## Proxy Support

```bash
# Single proxy
stealth browse https://example.com --proxy http://user:pass@host:port

# Proxy pool with rotation
stealth proxy add http://proxy1:8080 --label us --region US
stealth proxy add http://proxy2:8080 --label eu --region EU
stealth proxy test                                   # Test all proxies
stealth proxy list                                   # List with status
stealth browse https://example.com --proxy-rotate    # Auto-rotate
stealth crawl https://example.com --proxy-rotate     # Rotate per page
```

GeoIP: When using a proxy, Camoufox auto-matches locale, timezone, and geolocation to the proxy's exit IP.

## Pipe-Friendly

stdout = data, stderr = status. Perfect for Unix pipes:

```bash
stealth browse https://api.example.com -f json | jq '.title'
stealth search google "query" -f json | jq '.results[].url'
stealth extract https://example.com --links -f json | jq '.data[].url'
stealth crawl https://example.com -o - | wc -l
```

## HTTP API Server

```bash
stealth serve --port 9377
# → API Token: a1b2c3...  (auto-generated, printed on startup)

# Create tab + browse (token required)
curl -X POST localhost:9377/tabs \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'

# Get page text
curl localhost:9377/tabs/tab-1/text -H 'Authorization: Bearer <token>'

# Health check (no auth needed)
curl localhost:9377/health

# Disable auth (localhost only)
stealth serve --no-auth

# Custom token
stealth serve --token my-secret-token

# All endpoints: /health, /tabs, /tabs/:id/navigate, /tabs/:id/snapshot,
#   /tabs/:id/text, /tabs/:id/screenshot, /tabs/:id/click, /tabs/:id/type,
#   /tabs/:id/evaluate, /tabs/:id/close, /shutdown
```

## As a Library (SDK)

```javascript
import { launchBrowser, closeBrowser, navigate, getTextContent } from 'stealth-cli';

const handle = await launchBrowser({
  profile: 'us-desktop',
  humanize: true,
});

await navigate(handle, 'https://example.com');
const text = await getTextContent(handle);
console.log(text);

await closeBrowser(handle);
```

## Configuration

Set global defaults so you don't repeat flags:

```bash
stealth config set locale zh-CN          # Default Chinese locale
stealth config set humanize true         # Always simulate human behavior
stealth config set retries 3             # Default 3 retries
stealth config set format json           # Default JSON output
stealth config list                      # Show all settings
stealth config reset                     # Reset to defaults
```

Stored at `~/.stealth/config.json`.

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

No JavaScript shims. No detectable wrappers. The browser reports spoofed values natively.

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
| `--retries <n>` | Max retries on failure (default: 2) |
| `--no-headless` | Show browser window |
| `-f, --format` | Output format: text, json, jsonl, snapshot, markdown |

## Project Stats

```
Version:     0.5.1
Commands:    16
Tests:       90 passing
Source:      5,800+ lines
Files:       47
Extractors:  6 (Google, Bing, DuckDuckGo, YouTube, GitHub, generic)
Presets:     8 browser profiles
Engine:      Camoufox (C++ Firefox fork)
License:     MIT
```

## License

MIT

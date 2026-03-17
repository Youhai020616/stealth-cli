# 🦊 stealth-cli

Anti-detection browser CLI powered by [Camoufox](https://camoufox.com). Browse, screenshot, search, extract, crawl — all with C++ level fingerprint spoofing. Zero JavaScript shims, undetectable by design.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)

## Features

- 🛡️ **C++ level anti-detection** — Camoufox patches Firefox at native level, not JS shims
- 🔍 **14 search engines** — Google, Bing, DuckDuckGo, YouTube, GitHub, and more
- 🕷️ **Recursive crawler** — Depth control, regex filters, delay, output to JSONL
- 📸 **Screenshots & PDF** — Full page, viewport, custom resolution
- 🧲 **Data extraction** — Links, images, meta, headings, CSS selectors
- 🎭 **Browser profiles** — Persistent fingerprint identities with cookie storage
- 🔄 **Proxy rotation** — Pool management with health checking
- 🤖 **Human simulation** — Bezier mouse curves, natural typing, scroll patterns
- 👻 **Daemon mode** — Background browser for instant command execution
- 🧩 **MCP server** — Plug into Claude Desktop, Cursor, and other AI agents
- 📦 **SDK mode** — Import as a library in your own Node.js projects

## Install

```bash
git clone https://github.com/Youhai020616/stealth-cli.git
cd stealth-cli
npm install        # Installs deps + downloads Camoufox browser (~300MB)
npm link           # Makes 'stealth' command available globally
```

## Quick Start

```bash
# Browse a page
stealth browse https://example.com

# Screenshot
stealth screenshot https://example.com -o page.png

# Search with anti-detection
stealth search google "best coffee beans" -f json

# Extract structured data
stealth extract https://example.com --links --format json

# Crawl a site
stealth crawl https://example.com --depth 2 --limit 50 -o results.jsonl

# Interactive REPL
stealth interactive --url https://example.com
```

## Commands

### Core

| Command | Description |
|---------|-------------|
| `stealth browse <url>` | Visit URL, print page content |
| `stealth screenshot <url>` | Take a screenshot |
| `stealth pdf <url>` | Save page as PDF |
| `stealth search <engine> <query>` | Search the web |
| `stealth extract <url>` | Extract structured data |
| `stealth crawl <url>` | Recursive crawling |
| `stealth interactive` | Interactive REPL |
| `stealth batch <file>` | Batch process URLs from file |
| `stealth monitor <url>` | Monitor page for changes |
| `stealth fingerprint` | Show browser fingerprint info |

### Management

| Command | Description |
|---------|-------------|
| `stealth daemon start` | Start background browser |
| `stealth daemon stop` | Stop background browser |
| `stealth daemon status` | Show daemon status |
| `stealth profile create <name>` | Create browser identity |
| `stealth profile list` | List all profiles |
| `stealth proxy add <url>` | Add proxy to pool |
| `stealth proxy list` | List proxies |
| `stealth proxy test` | Test proxy connectivity |
| `stealth config set <key> <val>` | Set default config |
| `stealth mcp` | Start MCP server for AI agents |

---

### `stealth browse <url>`

```bash
stealth browse https://example.com                      # Text content
stealth browse https://example.com -f json              # JSON output
stealth browse https://example.com -f snapshot           # Accessibility tree
stealth browse https://example.com --proxy http://proxy:8080
stealth browse https://example.com --cookies cookies.txt
stealth browse https://example.com --profile us-desktop  # Use saved profile
stealth browse https://example.com --humanize            # Human behavior
```

### `stealth screenshot <url>`

```bash
stealth screenshot https://example.com                   # → screenshot.png
stealth screenshot https://example.com -o page.jpg       # JPEG output
stealth screenshot https://example.com --full             # Full page
stealth screenshot https://example.com --width 1920 --height 1080
```

### `stealth search <engine> <query>`

**Supported engines:** google, bing, duckduckgo, youtube, github, stackoverflow, npmjs, amazon, reddit, wikipedia, twitter, linkedin, tiktok, yelp

```bash
stealth search google "web scraping tools" -f json
stealth search github "camoufox" --max 20
stealth search duckduckgo "privacy browser" -f markdown
```

### `stealth extract <url>`

```bash
stealth extract https://example.com --links              # All links
stealth extract https://example.com --images             # All images
stealth extract https://example.com --meta               # Meta & OG tags
stealth extract https://example.com --headers            # h1-h6 headings
stealth extract https://example.com -s ".price" --all    # CSS selector
stealth extract https://example.com -s "a" -a "href"     # Attributes
```

### `stealth crawl <url>`

```bash
stealth crawl https://example.com -d 2 -l 50             # Depth 2, max 50
stealth crawl https://example.com --delay 2000            # 2s between pages
stealth crawl https://example.com --include "blog"        # URL regex filter
stealth crawl https://example.com --exclude "login|admin"
stealth crawl https://example.com -o results.jsonl        # Save to file
```

### `stealth interactive`

Interactive REPL for manual browsing.

```bash
stealth interactive                                # Start empty
stealth interactive --url https://example.com      # Start with a page
stealth interactive --no-headless                  # Show browser window
```

REPL commands: `goto`, `search`, `click`, `type`, `snapshot`, `text`, `links`, `screenshot`, `back`, `forward`, `eval`, `help`, `exit`

## Daemon Mode

Keep a browser alive in the background for instant reuse. No cold start.

```bash
stealth daemon start                   # Start background browser
stealth browse https://example.com     # ← Uses daemon automatically
stealth daemon status                  # Check status
stealth daemon stop                    # Shut down
```

The daemon auto-shuts down after 5 minutes of idle time.

## Browser Profiles

Create persistent browser identities with unique fingerprints, cookies, and proxy settings.

```bash
# Create from preset
stealth profile create mybot --preset us-desktop
stealth profile create jpbot --preset jp-desktop

# Create with random fingerprint
stealth profile create random1 --random

# Use profile
stealth browse https://example.com --profile mybot

# Cookies are auto-saved between sessions
stealth profile list
```

**Available presets:** `us-desktop`, `us-laptop`, `uk-desktop`, `de-desktop`, `jp-desktop`, `cn-desktop`, `mobile-ios`, `mobile-android`

## Proxy Support

```bash
# Single proxy
stealth browse https://example.com --proxy http://user:pass@host:port

# Proxy pool rotation
stealth proxy add http://proxy1:8080
stealth proxy add http://proxy2:8080
stealth proxy add socks5://proxy3:1080
stealth browse https://example.com --proxy-rotate    # Auto-rotate

# Test proxies
stealth proxy test
```

When a proxy is used, Camoufox automatically matches locale, timezone, and geolocation to the proxy's exit IP via GeoIP.

## MCP Server (AI Agent Integration)

Use stealth-cli as a tool in Claude Desktop, Cursor, or any MCP-compatible AI agent.

```bash
stealth mcp    # Start MCP server (stdio)
```

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stealth": {
      "command": "node",
      "args": ["/path/to/stealth-cli/bin/stealth.js", "mcp"]
    }
  }
}
```

**Available MCP tools:** `stealth_browse`, `stealth_screenshot`, `stealth_search`, `stealth_extract`, `stealth_click`, `stealth_type`, `stealth_evaluate`

## Pipe-Friendly

stdout = data, stderr = status messages. Perfect for piping:

```bash
# Parse with jq
stealth browse https://api.example.com -f json | jq '.title'

# Chain commands
stealth extract https://example.com --links -f json \
  | jq '.[].url' \
  | xargs -I {} stealth screenshot {} -o {}.png

# Batch from file
cat urls.txt | xargs -I {} stealth browse {} -f json > output.jsonl
```

## As a Library (SDK)

```javascript
import {
  launchBrowser, closeBrowser, navigate,
  getTextContent, takeScreenshot
} from 'stealth-cli';

const handle = await launchBrowser({
  headless: true,
  proxy: 'http://proxy:8080',
  profile: 'us-desktop',
  humanize: true,
});

await navigate(handle, 'https://example.com');
const text = await getTextContent(handle);
const screenshot = await takeScreenshot(handle, { path: 'page.png' });

await closeBrowser(handle);
```

## How Anti-Detection Works

stealth-cli uses [Camoufox](https://github.com/daijro/camoufox), a Firefox fork that patches fingerprint generation at the **C++ level**:

| Fingerprint Vector | Approach |
|---|---|
| `navigator.hardwareConcurrency` | Spoofed in C++ |
| WebGL renderer / vendor | Spoofed in C++ |
| AudioContext fingerprint | Spoofed in C++ |
| Canvas fingerprint | Spoofed in C++ |
| Screen geometry | Spoofed in C++ |
| WebRTC leak | Built-in protection |
| TLS fingerprint | Firefox native (not Chromium) |

**No JavaScript shims. No detectable wrappers.** The browser reports spoofed values natively.

## Configuration

```bash
stealth config set headless false      # Show browser window by default
stealth config set proxy http://p:8080 # Default proxy
stealth config set humanize true       # Always simulate human behavior
stealth config set format json         # Default output format
stealth config set retries 3           # Default retry count
```

Config stored at `~/.stealth/config.json`.

## License

MIT

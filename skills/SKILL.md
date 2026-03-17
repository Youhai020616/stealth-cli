# stealth-cli

Anti-detection browser CLI powered by Camoufox. Browse the web, search, extract data, take screenshots, and crawl pages — all with C++ level fingerprint spoofing that bypasses Cloudflare, Google, and most bot detection systems.

## When to use

- User needs to browse a website that blocks automated tools
- User needs to scrape data from protected pages
- User needs to search Google/Bing/DuckDuckGo without being blocked
- User needs screenshots of pages behind anti-bot protection
- User needs to monitor a page for changes
- User needs to extract structured data (links, images, meta tags)
- User needs to crawl a site with anti-detection

## Prerequisites

```bash
cd ~/Desktop/stealth-cli
npm install    # installs deps + downloads Camoufox (~300MB first time)
```

## Commands

### Browse a page

```bash
# Text output (default)
stealth browse https://example.com

# JSON output with metadata
stealth browse https://example.com -f json

# With proxy
stealth browse https://example.com --proxy http://user:pass@host:port

# With saved profile identity
stealth browse https://example.com --profile us-desktop
```

### Screenshot

```bash
stealth screenshot https://example.com -o page.png
stealth screenshot https://example.com --full -o full.png    # full page
stealth screenshot https://example.com --width 1920 --height 1080
```

### Search (bypasses anti-bot)

```bash
# Google (auto-humanized: visits homepage, types query, presses enter)
stealth search google "web scraping tools" -f json

# Other engines
stealth search duckduckgo "query" -f json
stealth search bing "query" -f json
stealth search youtube "query" -f json
stealth search github "query" -f json

# With warmup (visit random site first to build browsing history)
stealth search google "query" -f json --warmup

# Supported: google, duckduckgo, bing, youtube, github, amazon,
#   reddit, wikipedia, twitter, linkedin, tiktok, stackoverflow,
#   npmjs, yelp
```

### Extract data

```bash
# Extract all links
stealth extract https://example.com --links

# Extract meta tags (title, description, og:*)
stealth extract https://example.com --meta

# Extract all headings
stealth extract https://example.com --headers

# Extract by CSS selector
stealth extract https://example.com -s ".product-title" --all

# Extract image URLs
stealth extract https://example.com --images
```

### Crawl

```bash
# Crawl 2 levels deep, max 20 pages
stealth crawl https://example.com -d 2 -l 20

# Save to file
stealth crawl https://example.com -o results.jsonl

# Filter URLs
stealth crawl https://example.com --include "blog" --exclude "login"

# With delay between pages
stealth crawl https://example.com --delay 2000
```

### Monitor for changes

```bash
# Watch for any change (check every 60s)
stealth monitor https://example.com/price -s ".price" -i 60

# Alert when text appears
stealth monitor https://example.com --contains "In Stock"

# Alert when text disappears
stealth monitor https://example.com --not-contains "Sold Out"

# JSON output for piping
stealth monitor https://example.com --json -n 10
```

### Batch processing

```bash
# Create a URL list file
echo "https://example.com\nhttps://httpbin.org/ip" > urls.txt

# Browse all URLs
stealth batch urls.txt -c browse --skip-errors

# Screenshot all URLs
stealth batch urls.txt -c screenshot -o ./screenshots/
```

### Browser fingerprint check

```bash
# Show current fingerprint
stealth fingerprint

# Run anti-detection tests
stealth fingerprint --check

# Compare fingerprints across multiple launches
stealth fingerprint --compare 3
```

### Profile management (persistent identities)

```bash
# Create from preset
stealth profile create work --preset us-desktop
stealth profile create jp --preset jp-desktop

# Create random
stealth profile create random1 --random

# List profiles
stealth profile list

# Use profile (auto-saves cookies on exit)
stealth browse https://example.com --profile work

# Available presets: us-desktop, us-laptop, uk-desktop, de-desktop,
#   jp-desktop, cn-desktop, mobile-ios, mobile-android
```

### Session persistence

```bash
# Save/restore browsing session (cookies + last URL)
stealth browse https://example.com --session my-task

# Next time: auto-restores cookies and navigates to last URL
stealth browse https://other.com --session my-task
```

### Proxy pool

```bash
stealth proxy add http://user:pass@host:port --label us-east
stealth proxy list
stealth proxy test          # test all proxies

# Auto-rotate through pool
stealth browse https://example.com --proxy-rotate
stealth crawl https://example.com --proxy-rotate
```

### Daemon mode (fast startup)

```bash
stealth daemon start        # launch background browser
stealth browse https://...  # instant (~1s vs ~6s cold start)
stealth daemon status
stealth daemon stop
```

### HTTP API server

```bash
stealth serve --port 9377

# Then call via HTTP:
curl -X POST http://localhost:9377/tabs -d '{"url":"https://example.com"}'
curl http://localhost:9377/tabs/tab-1/text
curl http://localhost:9377/tabs/tab-1/screenshot
```

### Interactive REPL

```bash
stealth interactive --url https://example.com

# Commands: goto, search, click, hclick, type, htype, scroll,
#   snapshot, text, title, url, links, screenshot, back, forward,
#   reload, eval, wait, help, exit
```

## Output format

All commands support `--format` or `-f`:
- `text` — human-readable (default)
- `json` — structured JSON
- `jsonl` — one JSON object per line
- `snapshot` — accessibility tree snapshot
- `markdown` — markdown formatted

stdout contains data, stderr contains status messages. Pipe-friendly:

```bash
stealth search google "query" -f json | jq '.results[].url'
stealth extract https://example.com --links -f json | jq '.[].url'
```

## Common options (all commands)

| Option | Description |
|--------|-------------|
| `--proxy <url>` | Use proxy server |
| `--proxy-rotate` | Rotate through proxy pool |
| `--profile <name>` | Use saved browser profile |
| `--session <name>` | Persist/restore session |
| `--cookies <file>` | Import Netscape cookie file |
| `--humanize` | Enable human behavior simulation |
| `--retries <n>` | Max retries on failure |
| `--no-headless` | Show browser window |

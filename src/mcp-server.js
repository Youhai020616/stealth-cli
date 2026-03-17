/**
 * MCP (Model Context Protocol) Server for stealth-cli
 *
 * Allows AI agents (Claude Desktop, Cursor, etc.) to use stealth-cli
 * as a tool via the MCP protocol over stdio.
 *
 * Usage:
 *   stealth mcp                     — start MCP server (stdio transport)
 *
 * MCP config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "stealth": {
 *         "command": "node",
 *         "args": ["~/Desktop/stealth-cli/bin/stealth.js", "mcp"]
 *       }
 *     }
 *   }
 */

import { createRequire } from 'module';
import { createBrowser, createContext, TEXT_EXTRACT_SCRIPT } from './utils/browser-factory.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

// --- MCP Protocol Implementation (stdio JSON-RPC) ---

class McpServer {
  constructor() {
    this.browser = null;
    this.contexts = new Map(); // key → { context, page }
    this.tools = this._defineTools();
  }

  _defineTools() {
    return [
      {
        name: 'stealth_browse',
        description: 'Visit a URL with anti-detection and return page content. Bypasses Cloudflare and bot detection.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to visit' },
            format: { type: 'string', enum: ['text', 'snapshot'], default: 'text', description: 'Output format' },
          },
          required: ['url'],
        },
      },
      {
        name: 'stealth_screenshot',
        description: 'Take a screenshot of a page with anti-detection. Returns base64 PNG.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to screenshot' },
            fullPage: { type: 'boolean', default: false, description: 'Capture full page' },
          },
          required: ['url'],
        },
      },
      {
        name: 'stealth_search',
        description: 'Search the web with anti-detection. Supports Google, DuckDuckGo, Bing, YouTube, GitHub. Returns structured results.',
        inputSchema: {
          type: 'object',
          properties: {
            engine: { type: 'string', enum: ['google', 'duckduckgo', 'bing', 'youtube', 'github'], description: 'Search engine' },
            query: { type: 'string', description: 'Search query' },
            maxResults: { type: 'number', default: 10, description: 'Max results to return' },
          },
          required: ['engine', 'query'],
        },
      },
      {
        name: 'stealth_extract',
        description: 'Extract structured data from a page: links, images, meta tags, headings, or CSS selector content.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to extract from' },
            type: { type: 'string', enum: ['links', 'images', 'meta', 'headers', 'selector'], description: 'What to extract' },
            selector: { type: 'string', description: 'CSS selector (when type=selector)' },
          },
          required: ['url', 'type'],
        },
      },
      {
        name: 'stealth_click',
        description: 'Click an element on the current page by CSS selector.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector to click' },
          },
          required: ['selector'],
        },
      },
      {
        name: 'stealth_type',
        description: 'Type text into an input element on the current page.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector of input' },
            text: { type: 'string', description: 'Text to type' },
            pressEnter: { type: 'boolean', default: false, description: 'Press Enter after typing' },
          },
          required: ['selector', 'text'],
        },
      },
      {
        name: 'stealth_evaluate',
        description: 'Execute JavaScript in the current page context and return the result.',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'JavaScript expression to evaluate' },
          },
          required: ['expression'],
        },
      },
    ];
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await createBrowser();
    return this.browser;
  }

  async getPage(key = 'default') {
    if (this.contexts.has(key)) {
      const entry = this.contexts.get(key);
      try {
        await entry.page.evaluate('1');
        return entry;
      } catch {
        this.contexts.delete(key);
      }
    }
    await this.ensureBrowser();
    const context = await createContext(this.browser);
    const page = await context.newPage();
    const entry = { context, page };
    this.contexts.set(key, entry);
    return entry;
  }

  async handleToolCall(name, args) {
    const { page } = await this.getPage();

    switch (name) {
      case 'stealth_browse': {
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

        if (args.format === 'snapshot') {
          const snapshot = await page.locator('body').ariaSnapshot({ timeout: 8000 }).catch(() => '');
          return text(`URL: ${page.url()}\n\n${snapshot}`);
        }

        const content = await page.evaluate(TEXT_EXTRACT_SCRIPT);
        const title = await page.title().catch(() => '');
        return text(`Title: ${title}\nURL: ${page.url()}\n\n${content.slice(0, 15000)}`);
      }

      case 'stealth_screenshot': {
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const buffer = await page.screenshot({ type: 'png', fullPage: args.fullPage || false });
        return image(buffer.toString('base64'));
      }

      case 'stealth_search': {
        const { expandMacro } = await import('./macros.js');
        const { getExtractorByEngine } = await import('./extractors/index.js');

        const url = expandMacro(args.engine, args.query);
        if (!url) return text(`Unknown engine: ${args.engine}`);

        const isGoogle = args.engine === 'google';

        if (isGoogle) {
          await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(1000);
          try {
            await page.fill('textarea[name="q"], input[name="q"]', args.query);
            await page.keyboard.press('Enter');
          } catch {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          }
        } else {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const extractor = getExtractorByEngine(args.engine);
        const results = await extractor.extractResults(page, args.maxResults || 10);

        return text(JSON.stringify({ engine: args.engine, query: args.query, url: page.url(), results, count: results.length }, null, 2));
      }

      case 'stealth_extract': {
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

        let data;
        switch (args.type) {
          case 'links':
            data = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).filter((a) => a.href.startsWith('http')).map((a) => ({ url: a.href, text: a.textContent?.trim().slice(0, 100) })));
            break;
          case 'images':
            data = await page.evaluate(() => Array.from(document.querySelectorAll('img[src]')).map((i) => ({ src: i.src, alt: i.alt })));
            break;
          case 'meta':
            data = await page.evaluate(() => ({ title: document.title, description: document.querySelector('meta[name="description"]')?.content || '', ogTitle: document.querySelector('meta[property="og:title"]')?.content || '', ogImage: document.querySelector('meta[property="og:image"]')?.content || '' }));
            break;
          case 'headers':
            data = await page.evaluate(() => Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({ level: parseInt(h.tagName[1]), text: h.textContent?.trim() })));
            break;
          case 'selector':
            data = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent?.trim()), args.selector || 'body');
            break;
          default:
            return text(`Unknown extract type: ${args.type}`);
        }

        return text(JSON.stringify({ url: page.url(), type: args.type, data }, null, 2));
      }

      case 'stealth_click': {
        await page.click(args.selector, { timeout: 5000 });
        await page.waitForTimeout(500);
        return text(`Clicked: ${args.selector}\nURL: ${page.url()}`);
      }

      case 'stealth_type': {
        await page.fill(args.selector, args.text);
        if (args.pressEnter) await page.keyboard.press('Enter');
        return text(`Typed "${args.text}" into ${args.selector}`);
      }

      case 'stealth_evaluate': {
        const result = await page.evaluate(args.expression);
        return text(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  }

  // MCP stdio message loop
  async run() {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }

      const { id, method, params } = request;

      try {
        let result;

        switch (method) {
          case 'initialize':
            result = {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'stealth-cli', version: PKG_VERSION },
            };
            break;

          case 'notifications/initialized':
            continue; // No response needed

          case 'tools/list':
            result = { tools: this.tools };
            break;

          case 'tools/call': {
            const { name, arguments: args } = params;
            const content = await this.handleToolCall(name, args || {});
            result = { content };
            break;
          }

          default:
            result = { error: { code: -32601, message: `Unknown method: ${method}` } };
        }

        if (id !== undefined) {
          this.send({ jsonrpc: '2.0', id, result });
        }
      } catch (err) {
        if (id !== undefined) {
          this.send({ jsonrpc: '2.0', id, error: { code: -1, message: err.message } });
        }
      }
    }

    // Cleanup on exit
    for (const [, entry] of this.contexts) {
      await entry.context.close().catch(() => {});
    }
    if (this.browser) await this.browser.close().catch(() => {});
  }

  send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }
}

// Helper: text content block
function text(content) {
  return [{ type: 'text', text: content }];
}

// Helper: image content block
function image(base64Data) {
  return [{ type: 'image', data: base64Data, mimeType: 'image/png' }];
}

export { McpServer };

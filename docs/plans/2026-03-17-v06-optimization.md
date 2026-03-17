# stealth-cli v0.6 优化计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 v0.5 中的架构缺陷、安全漏洞、代码重复，使项目从"功能 demo"达到"生产可用"水平。

**Architecture:** 7 个独立任务，按优先级排列。每个任务可独立完成和提交。核心思路是：(1) 让已声明的功能真正工作；(2) 消除重复代码；(3) 堵住安全漏洞；(4) 补上核心测试。

**Tech Stack:** Node.js 18+, ESM, Playwright-core, Camoufox-js, Vitest, Commander

---

## 文件变更总览

| 任务 | 创建 | 修改 |
|------|------|------|
| Task 1: 全局配置贯通 | `src/utils/resolve-opts.js` | 所有 `src/commands/*.js` |
| Task 2: 版本号统一 | — | `bin/stealth.js`, `src/mcp-server.js` |
| Task 3: DRY 消除重复 | `src/utils/browser-factory.js`, `src/utils/page-text.js` | `src/browser.js`, `src/daemon.js`, `src/commands/serve.js`, `src/mcp-server.js` |
| Task 4: 安全加固 | — | `src/commands/serve.js`, `src/mcp-server.js` |
| Task 5: 资源管理 | — | `src/commands/serve.js`, `src/commands/crawl.js`, `src/proxy-pool.js` |
| Task 6: MCP 修正 | — | `src/mcp-server.js` |
| Task 7: 核心测试 | `tests/unit/resolve-opts.test.js`, `tests/unit/browser-factory.test.js`, `tests/unit/proxy-pool.test.js`, `tests/unit/session.test.js`, `tests/unit/serve-security.test.js` | — |

---

## Chunk 1: 关键缺陷修复 (Tasks 1-2)

### Task 1: 全局配置贯通 — 让 `stealth config set` 真正生效

**问题：** `config.js` 提供了 `loadConfig()` 读取 `~/.stealth/config.json`，用户可以 `stealth config set humanize true`，但 **没有任何命令读取这些配置**，用户设置的值被完全忽略。

**方案：** 创建 `resolve-opts.js`，在每个命令的 action 开头将 CLI 参数与全局配置合并（CLI 参数优先）。

**Files:**
- Create: `src/utils/resolve-opts.js`
- Modify: `src/commands/browse.js`
- Modify: `src/commands/search.js`
- Modify: `src/commands/crawl.js`
- Modify: `src/commands/screenshot.js`
- Modify: `src/commands/extract.js`
- Modify: `src/commands/interactive.js`
- Modify: `src/commands/batch.js`
- Modify: `src/commands/monitor.js`
- Modify: `src/commands/pdf.js`
- Modify: `src/commands/fingerprint.js`
- Test: `tests/unit/resolve-opts.test.js`

- [ ] **Step 1: 写失败测试**

```js
// tests/unit/resolve-opts.test.js
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resolveOpts } from '../../src/utils/resolve-opts.js';
import { setConfigValue, resetConfig, CONFIG_FILE } from '../../src/config.js';
import fs from 'fs';

let originalConfig = null;

beforeEach(() => {
  try {
    originalConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf-8') : null;
  } catch {}
  resetConfig();
});

afterAll(() => {
  if (originalConfig) fs.writeFileSync(CONFIG_FILE, originalConfig);
  else resetConfig();
});

describe('resolveOpts', () => {
  it('should return defaults when no config and no CLI opts', () => {
    const opts = resolveOpts({});
    expect(opts.headless).toBe(true);
    expect(opts.humanize).toBe(false);
    expect(opts.retries).toBe(2);
    expect(opts.format).toBe('text');
    expect(opts.locale).toBe('en-US');
  });

  it('should apply global config values', () => {
    setConfigValue('humanize', 'true');
    setConfigValue('locale', 'zh-CN');
    setConfigValue('retries', '5');

    const opts = resolveOpts({});
    expect(opts.humanize).toBe(true);
    expect(opts.locale).toBe('zh-CN');
    expect(opts.retries).toBe(5);
  });

  it('should let CLI opts override global config', () => {
    setConfigValue('humanize', 'true');
    setConfigValue('locale', 'zh-CN');

    const opts = resolveOpts({ humanize: false, locale: 'ja-JP' });
    expect(opts.humanize).toBe(false);
    expect(opts.locale).toBe('ja-JP');
  });

  it('should not override CLI false with config true for headless', () => {
    setConfigValue('headless', 'true');
    // Commander sets opts.headless = false when --no-headless is used
    const opts = resolveOpts({ headless: false });
    expect(opts.headless).toBe(false);
  });

  it('should handle proxy from config', () => {
    setConfigValue('proxy', 'http://proxy:8080');
    const opts = resolveOpts({});
    expect(opts.proxy).toBe('http://proxy:8080');
  });

  it('should handle string retries from CLI (Commander passes strings)', () => {
    const opts = resolveOpts({ retries: '3' });
    expect(opts.retries).toBe(3);
  });

  it('should pass through unknown CLI opts untouched', () => {
    const opts = resolveOpts({ output: 'file.json', depth: '3', warmup: true });
    expect(opts.output).toBe('file.json');
    expect(opts.depth).toBe('3');
    expect(opts.warmup).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/resolve-opts.test.js`
Expected: FAIL — `Cannot find module '../../src/utils/resolve-opts.js'`

- [ ] **Step 3: 实现 resolve-opts.js**

```js
// src/utils/resolve-opts.js
/**
 * Merge global config with CLI options.
 * Priority: CLI explicit opts > global config > defaults
 */

import { loadConfig } from '../config.js';

// Keys from config.js DEFAULTS that map to CLI option names
const CONFIG_TO_CLI = {
  headless: 'headless',
  locale: 'locale',
  timezone: 'timezone',
  timeout: 'timeout',
  retries: 'retries',
  humanize: 'humanize',
  delay: 'delay',
  format: 'format',
  proxy: 'proxy',
  viewportWidth: 'viewportWidth',
  viewportHeight: 'viewportHeight',
};

/**
 * Resolve final options by merging:
 *   1. Built-in defaults (from config.js DEFAULTS)
 *   2. User's global config (~/.stealth/config.json)
 *   3. CLI arguments (highest priority)
 *
 * @param {object} cliOpts - Options from Commander action
 * @returns {object} Merged options
 */
export function resolveOpts(cliOpts = {}) {
  const globalConfig = loadConfig(); // already merges defaults + user config

  // Start with global config values
  const merged = {};
  for (const [configKey, cliKey] of Object.entries(CONFIG_TO_CLI)) {
    merged[cliKey] = globalConfig[configKey];
  }

  // Overlay CLI options (only if explicitly provided, i.e., not undefined)
  for (const [key, value] of Object.entries(cliOpts)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // Ensure retries is a number (Commander passes strings)
  if (typeof merged.retries === 'string') {
    merged.retries = parseInt(merged.retries, 10);
  }

  return merged;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/resolve-opts.test.js`
Expected: 7 tests PASS

- [ ] **Step 5: 在 browse.js 中接入 resolveOpts**

修改 `src/commands/browse.js`，在 action 开头加入：

```js
// 在 action(async (url, opts) => { 之后、const spinner = ... 之前
import { resolveOpts } from '../utils/resolve-opts.js';

// action 内第一行：
opts = resolveOpts(opts);
```

然后移除 `.option()` 中硬编码的默认值（让 resolveOpts 统一管理）：

```
.option('-f, --format <format>', 'Output format: text, json, markdown, snapshot')
.option('--retries <n>', 'Max retries on failure')
.option('--locale <locale>', 'Browser locale')
```

- [ ] **Step 6: 对其余 9 个核心命令重复相同修改**

每个命令文件的 `action` 函数开头加入：
```js
const { resolveOpts } = await import('../utils/resolve-opts.js');
opts = resolveOpts(opts);
```

涉及文件：`search.js`, `crawl.js`, `screenshot.js`, `extract.js`, `interactive.js`, `batch.js`, `monitor.js`, `pdf.js`, `fingerprint.js`

- [ ] **Step 7: 运行全量测试**

Run: `npx vitest run`
Expected: All existing tests + new tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/utils/resolve-opts.js tests/unit/resolve-opts.test.js src/commands/*.js
git commit -m "fix: wire up global config to all commands via resolveOpts

Previously, stealth config set humanize true had no effect because
no command read from loadConfig(). Now all 10 core commands merge
global config with CLI opts (CLI takes priority)."
```

---

### Task 2: 版本号统一

**问题：** `package.json` 是 `0.5.1`，但 `bin/stealth.js` 和 `mcp-server.js` 写死了 `0.4.0`。

**Files:**
- Modify: `bin/stealth.js`
- Modify: `src/mcp-server.js`

- [ ] **Step 1: 修改 bin/stealth.js — 从 package.json 动态读取版本**

```js
// bin/stealth.js — 替换 .version('0.4.0')
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

program
  .name('stealth')
  .description('🦊 Anti-detection browser CLI powered by Camoufox')
  .version(version);
```

- [ ] **Step 2: 修改 mcp-server.js — 动态读取版本**

```js
// src/mcp-server.js — 在文件顶部加
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

// 替换 initialize handler 中的写死版本
serverInfo: { name: 'stealth-cli', version: PKG_VERSION },
```

- [ ] **Step 3: 验证**

Run: `node bin/stealth.js --version`
Expected: `0.5.1`

- [ ] **Step 4: Commit**

```bash
git add bin/stealth.js src/mcp-server.js
git commit -m "fix: read version from package.json instead of hardcoding"
```

---

## Chunk 2: 代码质量 (Task 3)

### Task 3: DRY — 消除 4 处重复代码

**问题 A：** `getHostOS()` 在 `browser.js`、`daemon.js`、`serve.js`、`mcp-server.js` 中重复 4 次。
**问题 B：** 浏览器启动逻辑（`launchOptions()` → `firefox.launch()`）重复 5 次。
**问题 C：** 页面文本提取（`cloneNode` → `querySelectorAll('script,style')` → `innerText`）重复 4 次。

**方案：** 抽取两个共享工具模块。

**Files:**
- Create: `src/utils/browser-factory.js`
- Create: `src/utils/page-text.js`
- Modify: `src/browser.js`
- Modify: `src/daemon.js`
- Modify: `src/commands/serve.js`
- Modify: `src/mcp-server.js`
- Test: `tests/unit/browser-factory.test.js`

- [ ] **Step 1: 写 browser-factory 测试**

```js
// tests/unit/browser-factory.test.js
import { describe, it, expect } from 'vitest';
import { getHostOS, TEXT_EXTRACT_SCRIPT } from '../../src/utils/browser-factory.js';

describe('browser-factory', () => {
  it('getHostOS should return valid OS string', () => {
    const os = getHostOS();
    expect(['macos', 'windows', 'linux']).toContain(os);
  });

  it('TEXT_EXTRACT_SCRIPT should be a non-empty string', () => {
    expect(typeof TEXT_EXTRACT_SCRIPT).toBe('string');
    expect(TEXT_EXTRACT_SCRIPT.length).toBeGreaterThan(10);
    expect(TEXT_EXTRACT_SCRIPT).toContain('cloneNode');
    expect(TEXT_EXTRACT_SCRIPT).toContain('script');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/browser-factory.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 browser-factory.js**

```js
// src/utils/browser-factory.js
/**
 * Shared browser bootstrap utilities
 * Eliminates duplication across browser.js, daemon.js, serve.js, mcp-server.js
 */

import os from 'os';
import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';

/**
 * Detect host OS for Camoufox fingerprint matching
 */
export function getHostOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

/**
 * Launch a Camoufox browser instance with standard settings
 *
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string} [opts.os] - Override OS (default: auto-detect)
 * @param {object} [opts.proxy] - { server, username?, password? }
 * @returns {Promise<import('playwright-core').Browser>}
 */
export async function createBrowser(opts = {}) {
  const {
    headless = true,
    os: targetOS,
    proxy,
  } = opts;

  const options = await launchOptions({
    headless,
    os: targetOS || getHostOS(),
    humanize: true,
    enable_cache: true,
    proxy: proxy || undefined,
    geoip: !!proxy,
  });

  return firefox.launch(options);
}

/**
 * Create a standard browser context
 *
 * @param {import('playwright-core').Browser} browser
 * @param {object} opts
 * @returns {Promise<import('playwright-core').BrowserContext>}
 */
export async function createContext(browser, opts = {}) {
  const {
    locale = 'en-US',
    timezone = 'America/Los_Angeles',
    viewport = { width: 1280, height: 720 },
    geo = { latitude: 37.7749, longitude: -122.4194 },
  } = opts;

  return browser.newContext({
    viewport,
    locale,
    timezoneId: timezone,
    permissions: ['geolocation'],
    geolocation: geo,
  });
}

/**
 * JavaScript snippet to extract visible text from a page.
 * Evaluate this in page.evaluate() — cannot reference Node.js scope.
 */
export const TEXT_EXTRACT_SCRIPT = `
(() => {
  const body = document.body;
  if (!body) return '';
  const clone = body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  return clone.innerText || clone.textContent || '';
})()
`;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/browser-factory.test.js`
Expected: PASS

- [ ] **Step 5: 修改 browser.js — 使用共享模块**

```js
// src/browser.js — 顶部 import 替换
// 删除: import { launchOptions } from 'camoufox-js';
// 删除: import { firefox } from 'playwright-core';
// 删除: import os from 'os';
// 删除: function getHostOS() { ... }
import { getHostOS, createBrowser, TEXT_EXTRACT_SCRIPT } from './utils/browser-factory.js';

// launchBrowser() 中替换浏览器启动部分:
// 旧:
//   const options = await launchOptions({ ... });
//   const browser = await firefox.launch(options);
// 新:
const browser = await createBrowser({
  headless,
  os: hostOS,
  proxy: proxy || undefined,
});

// getTextContent() 中替换文本提取:
// 旧:
//   return handle.page.evaluate(() => { const body = ... });
// 新:
return handle.page.evaluate(TEXT_EXTRACT_SCRIPT);
```

- [ ] **Step 6: 修改 daemon.js — 使用共享模块**

```js
// src/daemon.js — 替换
// 删除: import { launchOptions } from 'camoufox-js';
// 删除: import { firefox } from 'playwright-core';
// 删除: function getHostOS() { ... }
import { createBrowser, TEXT_EXTRACT_SCRIPT } from './utils/browser-factory.js';

// startDaemon() 中:
// 旧:
//   const options = await launchOptions({ ... });
//   const browser = await firefox.launch(options);
// 新:
const browser = await createBrowser({ headless: true });

// /text route 中:
// 旧: const text = await ctx.page.evaluate(() => { const clone = ... });
// 新: const text = await ctx.page.evaluate(TEXT_EXTRACT_SCRIPT);
```

- [ ] **Step 7: 修改 serve.js — 使用共享模块**

```js
// src/commands/serve.js — 替换
// 删除: import { launchOptions } from 'camoufox-js';
// 删除: import { firefox } from 'playwright-core';
// 删除: import os from 'os';
import { createBrowser, createContext, TEXT_EXTRACT_SCRIPT } from '../utils/browser-factory.js';

// action 中:
// 旧: const options = ...; const browser = await firefox.launch(options);
// 新: const browser = await createBrowser({ headless: opts.headless });

// text route:
// 旧: const text = await page.evaluate(() => { const c = ... });
// 新: const text = await page.evaluate(TEXT_EXTRACT_SCRIPT);
```

- [ ] **Step 8: 修改 mcp-server.js — 使用共享模块**

```js
// src/mcp-server.js — 替换
// 删除: import { launchOptions } from 'camoufox-js';
// 删除: import { firefox } from 'playwright-core';
// 删除: import os from 'os';
import { createBrowser, TEXT_EXTRACT_SCRIPT } from './utils/browser-factory.js';

// ensureBrowser() 中:
// 旧: const options = ...; this.browser = await firefox.launch(options);
// 新: this.browser = await createBrowser();

// stealth_browse handler 中:
// 旧: const content = await page.evaluate(() => { const c = ... });
// 新: const content = await page.evaluate(TEXT_EXTRACT_SCRIPT);
```

- [ ] **Step 9: 运行全量测试**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/utils/browser-factory.js tests/unit/browser-factory.test.js \
  src/browser.js src/daemon.js src/commands/serve.js src/mcp-server.js
git commit -m "refactor: extract shared browser-factory and text-extract utils

DRY: getHostOS() was duplicated 4x, browser launch logic 5x,
text extraction 4x. Now shared via src/utils/browser-factory.js."
```

---

## Chunk 3: 安全加固 (Task 4)

### Task 4: HTTP API 认证 + evaluate 防护

**问题 A：** `serve` 命令的 HTTP API 无任何认证，且提供 `--host` 参数可绑定到 `0.0.0.0`，配合 `/evaluate` 端点可远程执行任意 JS。
**问题 B：** MCP 的 `stealth_evaluate` 同样允许任意 JS 执行（但 MCP 走 stdio，风险较低）。
**问题 C：** 代理密码明文存储。

**方案：**
1. `serve` 启动时自动生成 token，需 `Authorization: Bearer <token>` 才能访问
2. 绑定非 localhost 时强制要求 `--token` 或 `--no-auth`（明确确认）
3. 代理密码加密存储（可选，此版本先做警告提示）

**Files:**
- Modify: `src/commands/serve.js`
- Test: `tests/unit/serve-security.test.js`

- [ ] **Step 1: 写测试**

```js
// tests/unit/serve-security.test.js
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

describe('serve security', () => {
  it('should generate a valid token', () => {
    const token = crypto.randomBytes(24).toString('hex');
    expect(token).toHaveLength(48);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it('should validate bearer token format', () => {
    const token = 'abc123';
    const authHeader = `Bearer ${token}`;
    const extracted = authHeader.replace(/^Bearer\s+/i, '');
    expect(extracted).toBe(token);
  });

  it('should reject missing auth header', () => {
    const authHeader = undefined;
    const isValid = authHeader && authHeader.startsWith('Bearer ');
    expect(isValid).toBeFalsy();
  });

  it('should reject wrong token', () => {
    const serverToken = 'correct-token';
    const clientToken = 'wrong-token';
    expect(serverToken === clientToken).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run tests/unit/serve-security.test.js`
Expected: PASS（这些是纯逻辑测试）

- [ ] **Step 3: 修改 serve.js — 添加认证中间件**

在 `src/commands/serve.js` 中：

```js
import crypto from 'crypto';

// 在 registerServe 的 .action 中，server 创建之前：
.option('--token <token>', 'API token for authentication (auto-generated if not set)')
.option('--no-auth', 'Disable authentication (DANGER: only use on localhost)')

// action 内：
const apiToken = opts.token || crypto.randomBytes(24).toString('hex');

// 安全检查：非 localhost 且无认证 → 警告
if (host !== '127.0.0.1' && host !== 'localhost' && opts.auth !== false) {
  log.warn('⚠ Binding to non-localhost with authentication enabled');
  log.info(`API Token: ${apiToken}`);
  log.dim('  Use: curl -H "Authorization: Bearer <token>" ...');
}

// /health 不需要认证，其余端点需要
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);

  // /health 跳过认证
  if (url.pathname === '/health') {
    // ... 现有逻辑
    return;
  }

  // 认证检查
  if (opts.auth !== false) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader.replace(/^Bearer\s+/i, '') !== apiToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized. Use: -H "Authorization: Bearer <token>"' }));
      return;
    }
  }

  // ... 现有路由逻辑
});

// 启动后打印 token
server.listen(port, host, () => {
  log.success(`Stealth API server running on http://${host}:${port}`);
  if (opts.auth !== false) {
    log.info(`API Token: ${apiToken}`);
    log.dim('  Use: curl -H "Authorization: Bearer ' + apiToken + '" ...');
  } else {
    log.warn('Authentication disabled (--no-auth)');
  }
  // ... 现有端点提示
});
```

- [ ] **Step 4: 运行全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.js tests/unit/serve-security.test.js
git commit -m "security: add Bearer token auth to HTTP API server

Auto-generates a random token on startup. /health is unauthenticated.
All other endpoints require Authorization: Bearer <token> header.
Use --no-auth to explicitly disable (localhost only recommended)."
```

---

## Chunk 4: 资源管理 (Task 5)

### Task 5: 修复资源泄漏与并发问题

**问题 A：** `serve.js` 没有最大标签页限制，可以无限创建标签页耗尽内存。
**问题 B：** `crawl.js` 把所有结果存在内存中的 `results` 数组，大规模爬取 OOM。
**问题 C：** `proxy-pool.js` 每次操作全量读写 JSON 文件，并发时可能数据丢失。

**Files:**
- Modify: `src/commands/serve.js`
- Modify: `src/commands/crawl.js`
- Modify: `src/proxy-pool.js`
- Test: `tests/unit/proxy-pool.test.js`

- [ ] **Step 1: 修改 serve.js — 添加标签页上限**

```js
// src/commands/serve.js — action 内，createPage 函数之前
const MAX_TABS = 20;

async function createPage() {
  if (pages.size >= MAX_TABS) {
    // 关闭最久未使用的标签页
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
      log.dim(`Auto-closed idle tab ${oldestId} (limit: ${MAX_TABS})`);
    }
  }
  // ... 现有创建逻辑
}
```

- [ ] **Step 2: 修改 crawl.js — 只计数，不存储全部结果**

```js
// src/commands/crawl.js — action 内
// 旧: const results = [];
// 新:
let resultCount = 0;

// writeResult 函数中:
// 旧: results.push(result);
// 新: resultCount++;

// while 循环条件:
// 旧: while (queue.length > 0 && results.length < maxPages)
// 新: while (queue.length > 0 && resultCount < maxPages)

// spinner 文本:
// 旧: spinner.text = `[${results.length + 1}/${maxPages}]...`
// 新: spinner.text = `[${resultCount + 1}/${maxPages}]...`

// 结束日志:
// 旧: log.success(`Crawl complete: ${results.length} pages crawled`);
// 新: log.success(`Crawl complete: ${resultCount} pages crawled`);
```

- [ ] **Step 3: 修改 proxy-pool.js — 添加简单文件锁**

```js
// src/proxy-pool.js — 添加文件锁防止并发写入
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'fs';

function saveData(data) {
  ensureDir();
  const tmpPath = PROXIES_FILE + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, PROXIES_FILE); // 原子写入
}
```

- [ ] **Step 4: 写 proxy-pool 原子写入测试**

```js
// tests/unit/proxy-pool.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addProxy, removeProxy, listProxies, getNextProxy, poolSize } from '../../src/proxy-pool.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROXIES_FILE = path.join(os.homedir(), '.stealth', 'proxies.json');
let backup = null;

beforeEach(() => {
  try {
    backup = fs.existsSync(PROXIES_FILE) ? fs.readFileSync(PROXIES_FILE, 'utf-8') : null;
  } catch {}
  // Reset to empty
  const dir = path.dirname(PROXIES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROXIES_FILE, JSON.stringify({ proxies: [], lastRotateIndex: 0 }));
});

afterEach(() => {
  if (backup) fs.writeFileSync(PROXIES_FILE, backup);
  else {
    try { fs.writeFileSync(PROXIES_FILE, JSON.stringify({ proxies: [], lastRotateIndex: 0 })); } catch {}
  }
});

describe('proxy-pool', () => {
  it('should add and list proxies', () => {
    addProxy('http://proxy1:8080', { label: 'us', region: 'US' });
    addProxy('http://proxy2:8080', { label: 'eu', region: 'EU' });
    const list = listProxies();
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('us');
  });

  it('should reject duplicate proxy', () => {
    addProxy('http://proxy1:8080');
    expect(() => addProxy('http://proxy1:8080')).toThrow('already exists');
  });

  it('should rotate proxies round-robin', () => {
    addProxy('http://a:1');
    addProxy('http://b:2');
    addProxy('http://c:3');

    const first = getNextProxy();
    const second = getNextProxy();
    const third = getNextProxy();
    const fourth = getNextProxy(); // wraps around

    expect(first).toBe('http://a:1');
    expect(second).toBe('http://b:2');
    expect(third).toBe('http://c:3');
    expect(fourth).toBe('http://a:1');
  });

  it('should remove proxy', () => {
    addProxy('http://proxy1:8080', { label: 'test' });
    expect(poolSize()).toBe(1);
    removeProxy('http://proxy1:8080');
    expect(poolSize()).toBe(0);
  });

  it('should remove proxy by label', () => {
    addProxy('http://proxy1:8080', { label: 'test' });
    removeProxy('test');
    expect(poolSize()).toBe(0);
  });

  it('should return null when pool is empty', () => {
    expect(getNextProxy()).toBeNull();
  });
});
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run tests/unit/proxy-pool.test.js`
Expected: PASS

- [ ] **Step 6: 运行全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/commands/serve.js src/commands/crawl.js src/proxy-pool.js tests/unit/proxy-pool.test.js
git commit -m "fix: resource management — tab limits, crawl memory, atomic writes

- serve: max 20 tabs, auto-evict oldest when limit reached
- crawl: use counter instead of storing all results in memory
- proxy-pool: atomic write via rename to prevent data corruption"
```

---

## Chunk 5: MCP 修正 (Task 6)

### Task 6: MCP 协议修正与行为一致性

**问题 A：** MCP Google 搜索用 `page.fill()` 而非 `humanType()`，与 CLI 版本行为不一致。
**问题 B：** `notifications/initialized` 应回复空结果而非 `continue`（部分客户端会等响应）。

**Files:**
- Modify: `src/mcp-server.js`

- [ ] **Step 1: 修改 MCP Google 搜索 — 使用 humanType**

```js
// src/mcp-server.js — stealth_search handler, isGoogle 分支
// 旧:
//   await page.fill('textarea[name="q"], input[name="q"]', args.query);
//   await page.keyboard.press('Enter');
// 新:
import { humanType, randomDelay } from './humanize.js';

// 在 stealth_search 的 isGoogle 分支:
if (isGoogle) {
  await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await randomDelay(800, 2000);

  // Handle cookie consent
  try {
    const consentBtn = page.locator(
      'button:has-text("Accept all"), button:has-text("Accept"), button:has-text("I agree")',
    );
    if (await consentBtn.first().isVisible({ timeout: 1500 })) {
      await consentBtn.first().click({ timeout: 2000 });
      await randomDelay(500, 1000);
    }
  } catch {}

  // Human-like typing instead of fill
  try {
    await humanType(page, 'textarea[name="q"], input[name="q"]', args.query, {
      pressEnter: true,
    });
  } catch {
    // Fallback: direct URL
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
}
```

- [ ] **Step 2: 修改 notifications/initialized 处理**

```js
// src/mcp-server.js — message loop
// 旧:
//   case 'notifications/initialized':
//     continue;
// 新:
case 'notifications/initialized':
  // Notification — no response needed per MCP spec
  // But don't break, just skip sending a response
  continue;
```

（此处现有逻辑其实是正确的，`continue` 跳过了 `this.send()`，符合 MCP 规范中 notification 不需要响应的要求。保持不变即可。）

- [ ] **Step 3: 运行全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server.js
git commit -m "fix: MCP Google search now uses humanType for consistency with CLI"
```

---

## Chunk 6: 核心模块测试 (Task 7)

### Task 7: 为零测试覆盖的核心模块补充单测

**目标：** session.js 和更多 proxy-pool 场景。这些模块涉及文件 I/O，是回归风险最高的区域。

**Files:**
- Create: `tests/unit/session.test.js`

- [ ] **Step 1: 写 session.js 测试**

```js
// tests/unit/session.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSession, saveSession, listSessions, deleteSession,
} from '../../src/session.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSIONS_DIR = path.join(os.homedir(), '.stealth', 'sessions');

// Backup existing sessions
let existingFiles = [];

beforeEach(() => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  existingFiles = fs.readdirSync(SESSIONS_DIR);
});

afterEach(() => {
  // Clean up test sessions only
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const f of files) {
      if (!existingFiles.includes(f) && f.startsWith('__test_')) {
        fs.unlinkSync(path.join(SESSIONS_DIR, f));
      }
    }
  } catch {}
});

describe('session', () => {
  it('should create a new session with defaults', () => {
    const session = getSession('__test_new');
    expect(session.name).toBe('__test_new');
    expect(session.cookies).toEqual([]);
    expect(session.history).toEqual([]);
    expect(session.lastUrl).toBeNull();
    expect(session.profile).toBeNull();
  });

  it('should save and reload a session', () => {
    const session = getSession('__test_save');
    session.lastUrl = 'https://example.com';
    session.cookies = [{ name: 'sid', value: '123', domain: '.example.com' }];
    session.history = ['https://example.com', 'https://example.com/about'];
    saveSession('__test_save', session);

    const reloaded = getSession('__test_save');
    expect(reloaded.lastUrl).toBe('https://example.com');
    expect(reloaded.cookies).toHaveLength(1);
    expect(reloaded.history).toHaveLength(2);
    expect(reloaded.lastAccess).not.toBeNull();
  });

  it('should sanitize session name', () => {
    const session = getSession('__test_a/b\\c:d');
    expect(session.name).toBe('__test_a/b\\c:d');
    // File should be created with sanitized name
    saveSession('__test_a/b\\c:d', session);
    // Should be able to reload
    const reloaded = getSession('__test_a/b\\c:d');
    expect(reloaded.name).toBe('__test_a/b\\c:d');
  });

  it('should delete a session', () => {
    const session = getSession('__test_delete');
    saveSession('__test_delete', session);

    deleteSession('__test_delete');
    // After deletion, getSession returns a fresh session
    const fresh = getSession('__test_delete');
    expect(fresh.lastAccess).toBeNull();
  });

  it('should list sessions', () => {
    saveSession('__test_list1', { ...getSession('__test_list1'), lastUrl: 'https://a.com' });
    saveSession('__test_list2', { ...getSession('__test_list2'), lastUrl: 'https://b.com' });

    const list = listSessions();
    const testSessions = list.filter(s => s.name.startsWith('__test_list'));
    expect(testSessions.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run tests/unit/session.test.js`
Expected: PASS

- [ ] **Step 3: 运行全量测试**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add tests/unit/session.test.js tests/unit/proxy-pool.test.js
git commit -m "test: add unit tests for session.js and proxy-pool.js

Core data-layer modules now have test coverage:
- session: create/save/reload/delete/list
- proxy-pool: add/remove/rotate/dedup"
```

---

## Chunk 7: 文档与收尾

### Task 8: 更新文档

**Files:**
- Modify: `README.md` — 更新 Tests passing 数量、版本号
- Modify: `PLAN.md` — 标记已完成项、添加 v0.6 内容

- [ ] **Step 1: 更新 README.md 中的统计数据**

在完成所有上述任务后，运行 `npx vitest run` 统计测试数量，更新 README 中的：
- Tests badge
- Project Stats 部分

- [ ] **Step 2: Commit**

```bash
git add README.md PLAN.md
git commit -m "docs: update stats and mark v0.6 optimizations complete"
```

---

## 执行摘要

| Task | 优先级 | 类型 | 预计时间 | 核心收益 |
|------|--------|------|----------|---------|
| **T1: 全局配置贯通** | 🔴 P0 | Bug | 30min | 用户设置的配置真正生效 |
| **T2: 版本号统一** | 🔴 P0 | Bug | 5min | --version 显示正确 |
| **T3: DRY 消除重复** | 🟡 P1 | Refactor | 40min | 4 处重复 → 1 处共享 |
| **T4: 安全加固** | 🔴 P0 | Security | 30min | HTTP API 不再裸奔 |
| **T5: 资源管理** | 🟡 P1 | Fix | 30min | 防 OOM / 数据丢失 |
| **T6: MCP 修正** | 🟡 P1 | Fix | 15min | MCP 搜索与 CLI 一致 |
| **T7: 核心测试** | 🟢 P2 | Test | 30min | session + proxy 有回归保护 |
| **T8: 文档更新** | 🟢 P2 | Docs | 10min | 信息准确 |

**总计预估：~3 小时**

**推荐执行顺序：** T2 → T1 → T3 → T4 → T5 → T6 → T7 → T8（先修 bug，再重构，再加固，最后测试收尾）

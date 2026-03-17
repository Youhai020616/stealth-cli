# 🦊 stealth-cli 优化计划

## 当前状态评估

### ✅ 已完成
- 6 个基础命令（browse/screenshot/search/extract/crawl/interactive）
- Camoufox 反检测集成
- 代理支持、Cookie 导入
- 基础 JSON/Text 输出格式
- 管道友好（stdout 数据 / stderr 状态）

### ❌ 已知问题
1. **Google 搜索被拦截** — 缺少人类行为模拟，无重试机制
2. **每次命令都启动新浏览器** — 冷启动 ~6s，严重影响体验
3. **无错误重试** — 页面超时/网络错误直接失败
4. **搜索结果提取粗糙** — DuckDuckGo 等返回导航链接而非搜索结果
5. **无指纹管理** — 每次运行指纹固定，大规模使用易被关联
6. **无测试** — 零测试覆盖
7. **无 AI Agent 集成** — 缺少 SKILL.md 等 Agent 发现机制

---

## Phase 1: 核心体验修复（优先级最高）

> 目标：让已有功能真正好用

### 1.1 浏览器复用 — 后台常驻模式
**问题：** 每个命令都要等 6s 启动浏览器，极差体验
**方案：** 加一个 `stealth daemon` 后台进程，复用浏览器实例

```
新增文件：
  src/daemon.js              — 后台进程管理（启动/停止/状态）
  src/client.js              — CLI 命令通过 IPC/HTTP 连接 daemon

新增命令：
  stealth daemon start       — 启动后台浏览器（常驻）
  stealth daemon stop        — 停止后台
  stealth daemon status      — 查看状态

工作原理：
  1. daemon 启动后监听 Unix socket（~/.stealth/stealth.sock）
  2. CLI 命令检测 daemon 是否在运行
     - 在运行 → 通过 socket 发送指令（毫秒级响应）
     - 没运行 → 回退到直接启动浏览器（现有逻辑）
  3. daemon 空闲 5 分钟自动退出
```

### 1.2 人类行为模拟
**问题：** Google 搜索被拦截，行为太机械
**方案：** 在 browser.js 中加入行为模拟层

```
新增文件：
  src/humanize.js

功能：
  - randomDelay(min, max)         — 随机等待（模拟人类反应时间）
  - humanScroll(page)             — 模拟人类滚动（先快后慢、不均匀）
  - humanMouseMove(page, x, y)    — 贝塞尔曲线鼠标移动
  - humanType(page, sel, text)    — 逐字输入，随机间隔
  - warmup(page)                  — 预热：先访问几个普通页面再访问目标

修改：
  browser.js   — launchBrowser 增加 humanize 选项
  所有命令     — 导航后自动插入随机延迟和滚动
```

### 1.3 错误重试机制
**问题：** 超时/网络错误直接失败退出
**方案：** 加入统一的重试包装器

```
新增文件：
  src/retry.js

功能：
  - withRetry(fn, { maxRetries: 3, backoff: 'exponential' })
  - 支持自定义可重试的错误类型（timeout、network、navigation）
  - 重试间隔指数退避（1s → 2s → 4s）
  - stderr 输出重试日志

修改：
  所有命令的 page.goto() 调用包裹 withRetry
```

---

## Phase 2: 搜索引擎增强

> 目标：搜索结果准确、结构化

### 2.1 专用搜索结果提取器
**问题：** 目前只有 Google 有专门的提取逻辑，且 Google 被拦截
**方案：** 为主流搜索引擎各写一个提取器

```
新增文件：
  src/extractors/
    google.js         — Google SERP 提取（等待异步渲染）
    duckduckgo.js     — DuckDuckGo 结果提取
    bing.js           — Bing 结果提取
    github.js         — GitHub 仓库搜索提取
    youtube.js        — YouTube 视频列表提取
    base.js           — 通用链接提取（fallback）

每个提取器导出：
  - canHandle(url)              — 判断是否匹配
  - extractResults(page, max)   — 提取结构化结果
  - waitForResults(page)        — 等待搜索结果渲染完成

修改：
  search.js  — 根据 engine 自动选择对应 extractor
```

### 2.2 Google 反检测增强
**方案：**
```
1. 预热访问：先访问 google.com 首页 → 等待 → 再搜索
2. 搜索方式：不直接 URL 跳转，而是在搜索框输入关键词 + 回车
3. Cookie 持久化：保存 Google consent cookies，下次复用
4. 代理轮换：--proxy-rotate 支持多个代理随机切换
```

---

## Phase 3: 指纹与会话管理

> 目标：支持多身份、持久化会话

### 3.1 指纹配置文件
```
新增文件：
  src/profiles.js

功能：
  stealth profile create "profile-1"    — 创建指纹配置
  stealth profile list                  — 列出所有配置
  stealth profile delete "profile-1"    — 删除配置

存储：~/.stealth/profiles/
  profile-1.json = {
    fingerprint: { os, locale, timezone, viewport, ... },
    cookies: [...],
    proxy: "...",
    createdAt: "...",
    lastUsed: "..."
  }

使用：
  stealth browse https://example.com --profile profile-1
```

### 3.2 会话持久化
```
新增文件：
  src/session.js

功能：
  - 自动保存浏览会话（cookies、localStorage、历史记录）
  - stealth browse --session my-session → 复用上次会话
  - session 保存到 ~/.stealth/sessions/
  - interactive 模式退出时自动保存
```

### 3.3 代理池管理
```
新增文件：
  src/proxy-pool.js

功能：
  stealth proxy add "http://proxy1:8080"
  stealth proxy add "http://proxy2:8080"
  stealth proxy list
  stealth proxy test                    — 测试所有代理可用性

  stealth browse --proxy-rotate         — 自动轮换代理
  stealth crawl --proxy-rotate          — 每个页面切换代理

存储：~/.stealth/proxies.json
```

---

## Phase 4: 新增命令

> 目标：扩展使用场景

### 4.1 stealth pdf
```
stealth pdf https://example.com -o page.pdf
stealth pdf https://example.com --format A4 --margin 10mm
```

### 4.2 stealth monitor
```
stealth monitor https://example.com/price --interval 60 --selector ".price"
# 每 60s 检查一次，内容变化时通知（stdout 输出 diff）
```

### 4.3 stealth batch
```
stealth batch urls.txt --command browse --format json -o results/
stealth batch urls.txt --command screenshot -o screenshots/
# 从文件读取 URL 列表，批量执行
```

### 4.4 stealth fingerprint
```
stealth fingerprint                      — 显示当前浏览器指纹
stealth fingerprint --check              — 访问检测站点验证反检测效果
stealth fingerprint --compare            — 对比多次启动的指纹差异
```

### 4.5 stealth serve
```
stealth serve --port 9377                — 启动 HTTP API 服务器
# 让 AI Agent 或外部程序通过 HTTP 调用
# 兼容 camofox-browser 的 API 格式
```

---

## Phase 5: AI Agent 集成

> 目标：让 Claude Code / OpenClaw 等 AI Agent 能直接使用

### 5.1 SKILL.md — Agent 自动发现
```
新增文件：
  skills/SKILL.md

内容：
  - 工具名称和描述
  - 所有命令的使用方式
  - 输入输出格式说明
  - 示例调用

效果：
  AI Agent 读取 SKILL.md 就知道怎么调用 stealth-cli
```

### 5.2 MCP (Model Context Protocol) 支持
```
新增文件：
  src/mcp-server.js

功能：
  stealth mcp                 — 以 MCP 服务器模式运行
  支持 Claude Desktop、Cursor 等直接调用

MCP Tools：
  - stealth_browse(url, format)
  - stealth_screenshot(url, output)
  - stealth_search(engine, query)
  - stealth_extract(url, options)
```

---

## Phase 6: 质量保障

> 目标：生产可用的代码质量

### 6.1 测试
```
新增目录：
  tests/
    unit/
      browser.test.js
      macros.test.js
      cookies.test.js
      output.test.js
      retry.test.js
      humanize.test.js
    e2e/
      browse.test.js
      screenshot.test.js
      search.test.js
      extract.test.js
      crawl.test.js
    fixtures/
      cookies.txt
      urls.txt

工具：vitest（轻量、ESM 原生支持）
目标：>80% 覆盖率
```

### 6.2 错误处理标准化
```
新增文件：
  src/errors.js

自定义错误类型：
  - BrowserLaunchError    — 浏览器启动失败
  - NavigationError       — 页面导航失败
  - ExtractionError       — 数据提取失败
  - TimeoutError          — 操作超时
  - ProxyError            — 代理连接失败

每个错误包含：
  - 用户友好的错误信息
  - 可能的解决建议（hints）
  - 退出码标准化
```

### 6.3 配置文件支持
```
新增文件：
  src/config.js

支持：
  ~/.stealth/config.json = {
    "defaultProxy": "http://proxy:8080",
    "defaultLocale": "zh-CN",
    "defaultTimezone": "Asia/Shanghai",
    "headless": true,
    "timeout": 30000,
    "retries": 3,
    "humanize": true
  }

  stealth config set defaultLocale zh-CN
  stealth config get defaultLocale
  stealth config list
```

---

## Phase 7: 文档与发布

### 7.1 文档
```
docs/
  getting-started.md      — 快速上手
  commands.md             — 命令参考
  proxy-guide.md          — 代理配置指南
  cookies-guide.md        — Cookie 导入指南
  agent-integration.md    — AI Agent 集成指南
  api-reference.md        — SDK API 文档
  troubleshooting.md      — 常见问题
```

### 7.2 发布到 npm
```
npm publish              — 发布到 npm registry
npx stealth-cli browse   — 任何人都能直接用
```

---

## 执行优先级

| 阶段 | 预计时间 | 优先级 | 核心收益 |
|------|---------|--------|---------|
| **Phase 1** 核心体验修复 | 2-3 天 | 🔴 最高 | 浏览器复用省 6s + 人类行为模拟 + 重试 |
| **Phase 2** 搜索引擎增强 | 1-2 天 | 🔴 最高 | Google 搜索可用 + 结果准确 |
| **Phase 3** 指纹与会话 | 2 天 | 🟡 高 | 多身份管理 + 会话复用 |
| **Phase 4** 新增命令 | 2-3 天 | 🟡 高 | PDF/监控/批量/指纹检测 |
| **Phase 5** AI Agent 集成 | 1-2 天 | 🟡 高 | SKILL.md + MCP 支持 |
| **Phase 6** 质量保障 | 2 天 | 🟢 中 | 测试 + 错误处理 + 配置 |
| **Phase 7** 文档与发布 | 1 天 | 🟢 中 | npm 发布 + 文档 |

**总计预估：~2 周**

---

## 优化后的项目结构

```
stealth-cli/
├── bin/
│   └── stealth.js
├── src/
│   ├── browser.js            ← 核心浏览器模块
│   ├── daemon.js             ← [NEW] 后台浏览器进程
│   ├── client.js             ← [NEW] daemon 通信客户端
│   ├── humanize.js           ← [NEW] 人类行为模拟
│   ├── retry.js              ← [NEW] 重试机制
│   ├── errors.js             ← [NEW] 错误类型
│   ├── session.js            ← [NEW] 会话持久化
│   ├── profiles.js           ← [NEW] 指纹配置管理
│   ├── proxy-pool.js         ← [NEW] 代理池管理
│   ├── config.js             ← [NEW] 全局配置
│   ├── macros.js
│   ├── cookies.js
│   ├── output.js
│   ├── index.js
│   ├── mcp-server.js         ← [NEW] MCP 服务器
│   ├── commands/
│   │   ├── browse.js
│   │   ├── screenshot.js
│   │   ├── search.js
│   │   ├── extract.js
│   │   ├── crawl.js
│   │   ├── interactive.js
│   │   ├── pdf.js            ← [NEW]
│   │   ├── monitor.js        ← [NEW]
│   │   ├── batch.js          ← [NEW]
│   │   ├── fingerprint.js    ← [NEW]
│   │   ├── serve.js          ← [NEW]
│   │   ├── daemon.js         ← [NEW]
│   │   ├── profile.js        ← [NEW]
│   │   ├── proxy.js          ← [NEW]
│   │   └── config.js         ← [NEW]
│   └── extractors/           ← [NEW]
│       ├── base.js
│       ├── google.js
│       ├── duckduckgo.js
│       ├── bing.js
│       ├── github.js
│       └── youtube.js
├── skills/
│   └── SKILL.md              ← [NEW] AI Agent 发现
├── tests/                    ← [NEW]
│   ├── unit/
│   └── e2e/
├── docs/                     ← [NEW]
├── package.json
├── README.md
├── PLAN.md
└── LICENSE
```

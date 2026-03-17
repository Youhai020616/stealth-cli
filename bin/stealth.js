#!/usr/bin/env node

/**
 * stealth-cli — Anti-detection browser CLI powered by Camoufox
 */

import { program } from 'commander';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

import { registerBrowse } from '../src/commands/browse.js';
import { registerScreenshot } from '../src/commands/screenshot.js';
import { registerSearch } from '../src/commands/search.js';
import { registerExtract } from '../src/commands/extract.js';
import { registerCrawl } from '../src/commands/crawl.js';
import { registerInteractive } from '../src/commands/interactive.js';
import { registerDaemon } from '../src/commands/daemon.js';
import { registerProfile } from '../src/commands/profile.js';
import { registerProxy } from '../src/commands/proxy.js';
import { registerPdf } from '../src/commands/pdf.js';
import { registerMonitor } from '../src/commands/monitor.js';
import { registerBatch } from '../src/commands/batch.js';
import { registerFingerprint } from '../src/commands/fingerprint.js';
import { registerServe } from '../src/commands/serve.js';
import { registerMcp } from '../src/commands/mcp.js';
import { registerConfig } from '../src/commands/config.js';

program
  .name('stealth')
  .description('🦊 Anti-detection browser CLI powered by Camoufox')
  .version(version);

// Core commands
registerBrowse(program);
registerScreenshot(program);
registerSearch(program);
registerExtract(program);
registerCrawl(program);
registerInteractive(program);
registerPdf(program);
registerBatch(program);
registerMonitor(program);
registerFingerprint(program);
registerServe(program);
registerMcp(program);

// Management commands
registerDaemon(program);
registerProfile(program);
registerProxy(program);
registerConfig(program);

program.parse();

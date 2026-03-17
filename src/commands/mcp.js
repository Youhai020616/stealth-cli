/**
 * stealth mcp - Start MCP server for AI agent integration
 */

import chalk from 'chalk';
import { log } from '../output.js';

export function registerMcp(program) {
  program
    .command('mcp')
    .description('Start MCP server for Claude Desktop, Cursor, etc.')
    .option('--list-tools', 'List available MCP tools without starting server')
    .option('--config', 'Print MCP configuration JSON for claude_desktop_config.json')
    .action(async (opts) => {
      if (opts.config) {
        printConfig();
        return;
      }

      if (opts.listTools) {
        listTools();
        return;
      }

      // Start MCP server on stdio
      const { McpServer } = await import('../mcp-server.js');
      const server = new McpServer();
      await server.run();
    });
}

function printConfig() {
  const config = {
    mcpServers: {
      stealth: {
        command: 'node',
        args: [process.argv[1].replace(/\/commands\/.*/, '/../bin/stealth.js'), 'mcp'],
      },
    },
  };

  console.log(chalk.bold('\n  Add this to your claude_desktop_config.json:\n'));
  console.log(JSON.stringify(config, null, 2));
  console.log();

  log.dim('  Config location:');
  log.dim('    macOS: ~/Library/Application Support/Claude/claude_desktop_config.json');
  log.dim('    Linux: ~/.config/Claude/claude_desktop_config.json');
  console.log();
}

function listTools() {
  const tools = [
    { name: 'stealth_browse', desc: 'Visit URL with anti-detection, return text/snapshot' },
    { name: 'stealth_screenshot', desc: 'Screenshot a page (returns base64 PNG)' },
    { name: 'stealth_search', desc: 'Search Google/Bing/DuckDuckGo/YouTube/GitHub' },
    { name: 'stealth_extract', desc: 'Extract links/images/meta/headers/selector' },
    { name: 'stealth_click', desc: 'Click element by CSS selector' },
    { name: 'stealth_type', desc: 'Type text into input element' },
    { name: 'stealth_evaluate', desc: 'Execute JavaScript in page' },
  ];

  console.log(chalk.bold('\n  MCP Tools:\n'));
  for (const t of tools) {
    console.log(`  ${chalk.cyan(t.name.padEnd(24))} ${t.desc}`);
  }
  console.log();
}

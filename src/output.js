/**
 * Output formatting utilities
 */

import chalk from 'chalk';

/**
 * Format output based on requested format
 */
export function formatOutput(data, format = 'text') {
  switch (format) {
    case 'json':
      return JSON.stringify(data, null, 2);
    case 'jsonl':
      if (Array.isArray(data)) {
        return data.map((item) => JSON.stringify(item)).join('\n');
      }
      return JSON.stringify(data);
    case 'markdown':
      return toMarkdown(data);
    case 'text':
    default:
      if (typeof data === 'string') return data;
      if (typeof data === 'object') return JSON.stringify(data, null, 2);
      return String(data);
  }
}

/**
 * Convert data to markdown format
 */
function toMarkdown(data) {
  if (typeof data === 'string') return data;

  if (Array.isArray(data)) {
    return data
      .map((item, i) => {
        if (typeof item === 'string') return `- ${item}`;
        if (item.title && item.url) {
          return `${i + 1}. [${item.title}](${item.url})${item.text ? `\n   ${item.text}` : ''}`;
        }
        return `- ${JSON.stringify(item)}`;
      })
      .join('\n');
  }

  if (typeof data === 'object') {
    return Object.entries(data)
      .map(([key, value]) => `**${key}:** ${value}`)
      .join('\n');
  }

  return String(data);
}

/**
 * Print styled log messages
 */
export const log = {
  info: (msg) => console.error(chalk.blue('ℹ'), msg),
  success: (msg) => console.error(chalk.green('✔'), msg),
  warn: (msg) => console.error(chalk.yellow('⚠'), msg),
  error: (msg) => console.error(chalk.red('✖'), msg),
  dim: (msg) => console.error(chalk.dim(msg)),
};

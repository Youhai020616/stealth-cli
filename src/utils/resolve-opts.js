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

  // Coerce numeric fields (Commander passes CLI values as strings)
  const NUMERIC_KEYS = ['retries', 'timeout', 'delay', 'viewportWidth', 'viewportHeight', 'wait', 'depth', 'limit', 'interval', 'count', 'port', 'num', 'width', 'height'];
  for (const key of NUMERIC_KEYS) {
    if (typeof merged[key] === 'string') {
      const n = parseInt(merged[key], 10);
      if (!isNaN(n)) merged[key] = n;
    }
  }

  return merged;
}

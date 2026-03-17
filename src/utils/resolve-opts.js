/**
 * Merge global config with CLI options.
 * Priority: CLI explicit opts > global config > defaults
 *
 * Special handling for Commander's --no-xxx pattern:
 *   Commander sets `headless: true` by default even when user didn't pass --headless.
 *   We can't tell "default true" from "explicit --headless". So when the CLI value
 *   matches Commander's auto-default AND global config has a different value,
 *   we let global config win.
 */

import { loadConfig, DEFAULTS } from '../config.js';

// Commander auto-defaults for --no-xxx flags.
// When CLI value === auto-default, it may be Commander's default, not user intent.
const COMMANDER_AUTO_DEFAULTS = {
  headless: true,
};

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

// Numeric fields that Commander passes as strings
const NUMERIC_KEYS = [
  'retries', 'timeout', 'delay', 'viewportWidth', 'viewportHeight',
  'wait', 'depth', 'limit', 'interval', 'count', 'port', 'num', 'width', 'height',
];

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
  const globalConfig = loadConfig(); // merges DEFAULTS + user config file

  // Start with global config values
  const merged = {};
  for (const [configKey, cliKey] of Object.entries(CONFIG_TO_CLI)) {
    merged[cliKey] = globalConfig[configKey];
  }

  // Overlay CLI options (only if explicitly provided)
  for (const [key, value] of Object.entries(cliOpts)) {
    if (value === undefined) continue;

    // Handle Commander auto-defaults: if CLI value matches the auto-default
    // and user has set a different value in global config, let config win.
    if (key in COMMANDER_AUTO_DEFAULTS && value === COMMANDER_AUTO_DEFAULTS[key]) {
      if (merged[key] !== undefined && merged[key] !== DEFAULTS[key]) {
        continue; // Global config has a user-set value — don't overwrite with auto-default
      }
    }

    merged[key] = value;
  }

  // Coerce numeric fields (Commander passes CLI values as strings)
  for (const key of NUMERIC_KEYS) {
    if (typeof merged[key] === 'string') {
      const n = parseInt(merged[key], 10);
      if (!isNaN(n)) merged[key] = n;
    }
  }

  return merged;
}

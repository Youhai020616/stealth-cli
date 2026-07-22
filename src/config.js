/**
 * Global configuration — ~/.stealth/config.json
 *
 * Provides defaults for all commands so you don't have to repeat flags.
 */

import path from 'path';
import os from 'os';
import { readPrivateFile, writeJsonAtomic } from './utils/json-file.js';

const CONFIG_DIR = path.join(os.homedir(), '.stealth');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  headless: true,
  locale: 'en-US',
  timezone: 'America/Los_Angeles',
  timeout: 30000,
  retries: 2,
  humanize: false,
  delay: 1000,
  format: 'text',
  proxy: null,
  viewportWidth: 1280,
  viewportHeight: 720,
};

const VALID_KEYS = Object.keys(DEFAULTS);

/**
 * Load config (merges file with defaults)
 */
export function loadConfig() {
  const fileConfig = readConfigFile();
  return { ...DEFAULTS, ...fileConfig };
}

/**
 * Read raw config file
 */
function readConfigFile() {
  let contents;
  try {
    contents = readPrivateFile(CONFIG_FILE, { encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }

  try {
    return JSON.parse(contents);
  } catch {
    return {};
  }
}

/**
 * Write config file
 */
function writeConfigFile(config) {
  writeJsonAtomic(CONFIG_FILE, config);
}

/**
 * Get a config value
 */
export function getConfigValue(key) {
  const config = loadConfig();
  return config[key];
}

/**
 * Set a config value
 */
export function setConfigValue(key, value) {
  if (!VALID_KEYS.includes(key)) {
    throw new Error(`Unknown config key: "${key}". Valid keys: ${VALID_KEYS.join(', ')}`);
  }

  const config = readConfigFile();

  // Type coercion
  const defaultVal = DEFAULTS[key];
  if (typeof defaultVal === 'boolean') {
    value = value === 'true' || value === true;
  } else if (typeof defaultVal === 'number') {
    value = Number(value);
    if (isNaN(value)) throw new Error(`Invalid number for ${key}`);
  } else if (value === 'null' || value === '') {
    value = null;
  }

  config[key] = value;
  writeConfigFile(config);
  return value;
}

/**
 * Delete a config value (reset to default)
 */
export function deleteConfigValue(key) {
  const config = readConfigFile();
  delete config[key];
  writeConfigFile(config);
}

/**
 * List all config values
 */
export function listConfig() {
  const config = loadConfig();
  const fileConfig = readConfigFile();

  return VALID_KEYS.map((key) => ({
    key,
    value: config[key],
    source: key in fileConfig ? 'user' : 'default',
    default: DEFAULTS[key],
  }));
}

/**
 * Reset all config to defaults
 */
export function resetConfig() {
  writeConfigFile({});
}

export { CONFIG_FILE, VALID_KEYS, DEFAULTS };

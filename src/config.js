/**
 * Global configuration — ~/.stealth/config.json
 *
 * Provides defaults for all commands so you don't have to repeat flags.
 */

import path from 'path';
import os from 'os';
import { ProxyError, StealthError } from './errors.js';
import { readPrivateFile, writeJsonAtomic } from './utils/json-file.js';
import { isValidProxyUrl } from './utils/proxy.js';

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

function invalidConfig(message, cause) {
  return new StealthError(message, {
    code: 1,
    hint: `Fix or remove the configuration file: ${CONFIG_FILE}`,
    cause,
  });
}

function invalidConfigProxy(value, cause = new Error('Invalid proxy URL format')) {
  return new ProxyError(value, cause, {
    message: 'Global configuration contains an invalid proxy URL',
    hint: 'Use an HTTP(S) proxy in the form [http://][user:password@]host[:port], or delete the proxy setting',
  });
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw invalidConfig('Global configuration file has an invalid format');
  }

  for (const key of VALID_KEYS) {
    if (!Object.hasOwn(config, key)) continue;
    const value = config[key];
    if (key === 'proxy') {
      if (value !== null && !isValidProxyUrl(value)) throw invalidConfigProxy(value);
      continue;
    }

    const expected = typeof DEFAULTS[key];
    if (
      typeof value !== expected
      || (expected === 'number' && !Number.isFinite(value))
    ) {
      throw invalidConfig(`Global configuration field "${key}" has an invalid type`);
    }
  }
  return config;
}

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

  let config;
  try {
    config = JSON.parse(contents);
  } catch (cause) {
    throw invalidConfig('Global configuration file contains malformed JSON', cause);
  }
  return validateConfig(config);
}

/**
 * Write config file
 */
function writeConfigFile(config) {
  writeJsonAtomic(CONFIG_FILE, validateConfig(config));
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
  if (key === 'proxy' && value !== null && !isValidProxyUrl(value)) {
    throw invalidConfigProxy(value);
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

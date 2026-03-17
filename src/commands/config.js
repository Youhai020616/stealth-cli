/**
 * stealth config - Manage global configuration
 */

import chalk from 'chalk';
import {
  getConfigValue, setConfigValue, deleteConfigValue,
  listConfig, resetConfig, CONFIG_FILE,
} from '../config.js';
import { log } from '../output.js';

export function registerConfig(program) {
  const config = program
    .command('config')
    .description('Manage global configuration (~/.stealth/config.json)');

  // stealth config list
  config
    .command('list')
    .description('Show all config values')
    .action(() => {
      const items = listConfig();
      console.log(chalk.bold('\n  Configuration:\n'));
      console.log(chalk.dim(`  ${'Key'.padEnd(20)} ${'Value'.padEnd(25)} Source`));
      console.log(chalk.dim('  ' + '─'.repeat(55)));

      for (const item of items) {
        const val = item.value === null ? chalk.dim('null') : String(item.value);
        const src = item.source === 'user' ? chalk.cyan('user') : chalk.dim('default');
        console.log(`  ${item.key.padEnd(20)} ${val.padEnd(25)} ${src}`);
      }

      console.log(chalk.dim(`\n  File: ${CONFIG_FILE}\n`));
    });

  // stealth config get <key>
  config
    .command('get')
    .description('Get a config value')
    .argument('<key>', 'Config key')
    .action((key) => {
      try {
        const value = getConfigValue(key);
        console.log(value);
      } catch (err) {
        log.error(err.message);
        process.exit(1);
      }
    });

  // stealth config set <key> <value>
  config
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .action((key, value) => {
      try {
        const result = setConfigValue(key, value);
        log.success(`${key} = ${result}`);
      } catch (err) {
        log.error(err.message);
        process.exit(1);
      }
    });

  // stealth config delete <key>
  config
    .command('delete')
    .description('Reset a config value to default')
    .argument('<key>', 'Config key')
    .action((key) => {
      deleteConfigValue(key);
      log.success(`${key} reset to default`);
    });

  // stealth config reset
  config
    .command('reset')
    .description('Reset all config to defaults')
    .action(() => {
      resetConfig();
      log.success('All config reset to defaults');
    });
}

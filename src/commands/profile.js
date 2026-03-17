/**
 * stealth profile - Manage browser identity profiles
 */

import {
  createProfile, loadProfile, deleteProfile,
  listProfiles, getPresets,
} from '../profiles.js';
import { log } from '../output.js';
import chalk from 'chalk';

export function registerProfile(program) {
  const profile = program
    .command('profile')
    .description('Manage browser identity profiles');

  // stealth profile create <name>
  profile
    .command('create')
    .description('Create a new profile')
    .argument('<name>', 'Profile name')
    .option('--preset <preset>', `Use a preset: ${getPresets().join(', ')}`)
    .option('--random', 'Generate random fingerprint')
    .option('--locale <locale>', 'Browser locale (e.g. en-US, zh-CN)')
    .option('--timezone <tz>', 'Timezone (e.g. America/New_York)')
    .option('--proxy <proxy>', 'Proxy server for this profile')
    .option('--os <os>', 'OS fingerprint: windows, macos, linux')
    .action((name, opts) => {
      try {
        const p = createProfile(name, opts);
        log.success(`Profile "${name}" created`);
        log.dim(`  Locale:   ${p.fingerprint.locale}`);
        log.dim(`  Timezone: ${p.fingerprint.timezone}`);
        log.dim(`  OS:       ${p.fingerprint.os}`);
        log.dim(`  Viewport: ${p.fingerprint.viewport.width}x${p.fingerprint.viewport.height}`);
        if (p.proxy) log.dim(`  Proxy:    ${p.proxy}`);
      } catch (err) {
        log.error(err.message);
        process.exit(1);
      }
    });

  // stealth profile list
  profile
    .command('list')
    .description('List all profiles')
    .action(() => {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        log.info('No profiles yet. Create one with: stealth profile create <name>');
        return;
      }

      console.log(chalk.bold('\n  Profiles:\n'));
      const header = `  ${'Name'.padEnd(18)} ${'Locale'.padEnd(8)} ${'OS'.padEnd(8)} ${'Viewport'.padEnd(12)} ${'Proxy'.padEnd(6)} ${'Cookies'.padEnd(8)} ${'Uses'.padEnd(6)}`;
      console.log(chalk.dim(header));
      console.log(chalk.dim('  ' + '─'.repeat(70)));

      for (const p of profiles) {
        if (p.error) {
          console.log(`  ${chalk.red(p.name.padEnd(18))} ${chalk.dim('corrupted')}`);
          continue;
        }
        console.log(
          `  ${chalk.cyan(p.name.padEnd(18))} ${p.locale.padEnd(8)} ${p.os.padEnd(8)} ${p.viewport.padEnd(12)} ${p.proxy.padEnd(6)} ${String(p.cookies).padEnd(8)} ${String(p.useCount).padEnd(6)}`,
        );
      }
      console.log();
    });

  // stealth profile show <name>
  profile
    .command('show')
    .description('Show profile details')
    .argument('<name>', 'Profile name')
    .action((name) => {
      try {
        const p = loadProfile(name);
        console.log(JSON.stringify(p, null, 2));
      } catch (err) {
        log.error(err.message);
        process.exit(1);
      }
    });

  // stealth profile delete <name>
  profile
    .command('delete')
    .description('Delete a profile')
    .argument('<name>', 'Profile name')
    .action((name) => {
      try {
        deleteProfile(name);
        log.success(`Profile "${name}" deleted`);
      } catch (err) {
        log.error(err.message);
        process.exit(1);
      }
    });

  // stealth profile presets
  profile
    .command('presets')
    .description('List available fingerprint presets')
    .action(() => {
      console.log(chalk.bold('\n  Available presets:\n'));
      for (const name of getPresets()) {
        console.log(`  ${chalk.cyan(name)}`);
      }
      console.log(chalk.dim('\n  Usage: stealth profile create myprofile --preset us-desktop\n'));
    });
}

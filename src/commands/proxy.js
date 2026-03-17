/**
 * stealth proxy - Manage proxy pool
 */

import ora from 'ora';
import chalk from 'chalk';
import {
  addProxy, removeProxy, listProxies,
  testProxy, testAllProxies, poolSize,
} from '../proxy-pool.js';
import { log } from '../output.js';

export function registerProxy(program) {
  const proxy = program
    .command('proxy')
    .description('Manage proxy pool');

  // stealth proxy add <url>
  proxy
    .command('add')
    .description('Add a proxy to the pool')
    .argument('<url>', 'Proxy URL (http://user:pass@host:port)')
    .option('--label <label>', 'Label for this proxy')
    .option('--region <region>', 'Geographic region (e.g. US, EU, Asia)')
    .action((url, opts) => {
      try {
        const count = addProxy(url, opts);
        log.success(`Proxy added (${count} total in pool)`);
      } catch (err) {
        log.error(err.message);
      }
    });

  // stealth proxy remove <url>
  proxy
    .command('remove')
    .description('Remove a proxy from the pool')
    .argument('<url>', 'Proxy URL or label')
    .action((url) => {
      try {
        removeProxy(url);
        log.success('Proxy removed');
      } catch (err) {
        log.error(err.message);
      }
    });

  // stealth proxy list
  proxy
    .command('list')
    .description('List all proxies')
    .action(() => {
      const proxies = listProxies();
      if (proxies.length === 0) {
        log.info('No proxies configured. Add one with: stealth proxy add <url>');
        return;
      }

      console.log(chalk.bold('\n  Proxy Pool:\n'));
      const header = `  ${'URL'.padEnd(40)} ${'Label'.padEnd(10)} ${'Status'.padEnd(8)} ${'Latency'.padEnd(10)} ${'Uses'.padEnd(6)} ${'Fails'.padEnd(6)}`;
      console.log(chalk.dim(header));
      console.log(chalk.dim('  ' + '─'.repeat(84)));

      for (const p of proxies) {
        const statusColor = p.status === 'ok' ? chalk.green : p.status === 'fail' ? chalk.red : chalk.dim;
        console.log(
          `  ${p.url.padEnd(40).slice(0, 40)} ${p.label.padEnd(10)} ${statusColor(p.status.padEnd(8))} ${p.latency.padEnd(10)} ${String(p.useCount).padEnd(6)} ${String(p.failCount).padEnd(6)}`,
        );
      }
      console.log();
    });

  // stealth proxy test [url]
  proxy
    .command('test')
    .description('Test proxy connectivity')
    .argument('[url]', 'Specific proxy URL to test (or test all)')
    .action(async (url) => {
      if (url) {
        const spinner = ora(`Testing ${url}...`).start();
        const result = await testProxy(url);
        spinner.stop();

        if (result.ok) {
          log.success(`Proxy OK — IP: ${result.ip}, Latency: ${result.latency}ms`);
        } else {
          log.error(`Proxy FAILED — ${result.error}`);
        }
      } else {
        const size = poolSize();
        if (size === 0) {
          log.info('No proxies to test');
          return;
        }

        const spinner = ora(`Testing ${size} proxies...`).start();
        const results = await testAllProxies();
        spinner.stop();

        let ok = 0;
        let fail = 0;
        for (const r of results) {
          if (r.ok) {
            ok++;
            log.success(`${r.proxy} — IP: ${r.ip}, ${r.latency}ms`);
          } else {
            fail++;
            log.error(`${r.proxy} — ${r.error}`);
          }
        }

        console.log();
        log.info(`Results: ${chalk.green(`${ok} ok`)} / ${chalk.red(`${fail} failed`)} / ${size} total`);
      }
    });
}

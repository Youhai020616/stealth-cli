/**
 * stealth daemon - Manage background browser daemon
 */

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { isDaemonRunning, PID_PATH, SOCKET_PATH, STEALTH_DIR } from '../daemon.js';
import { daemonStatus, daemonShutdown } from '../client.js';
import { log } from '../output.js';

export function registerDaemon(program) {
  const daemon = program
    .command('daemon')
    .description('Manage background browser daemon for instant startup');

  // stealth daemon start
  daemon
    .command('start')
    .description('Start background browser daemon')
    .option('--idle-timeout <minutes>', 'Auto-shutdown after idle (minutes)', '5')
    .option('--verbose', 'Show daemon logs in terminal')
    .action(async (opts) => {
      if (isDaemonRunning()) {
        const status = await daemonStatus();
        if (status?.ok) {
          log.info(`Daemon already running (pid: ${status.pid}, uptime: ${status.uptime}s, memory: ${status.memoryMB}MB)`);
          return;
        }
      }

      const idleTimeout = parseInt(opts.idleTimeout) * 60 * 1000;

      if (opts.verbose) {
        // Run in foreground
        log.info('Starting daemon in foreground (Ctrl+C to stop)...');
        const { startDaemon } = await import('../daemon.js');
        await startDaemon({ idleTimeout, verbose: true });
      } else {
        // Fork as background process
        fs.mkdirSync(STEALTH_DIR, { recursive: true });

        const daemonScript = path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          'daemon-entry.js',
        );

        const child = fork(daemonScript, [], {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: {
            ...process.env,
            STEALTH_IDLE_TIMEOUT: String(idleTimeout),
          },
        });

        // Wait for daemon to report ready
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Daemon startup timeout (15s)'));
          }, 15000);

          child.on('message', (msg) => {
            if (msg === 'ready') {
              clearTimeout(timer);
              resolve();
            }
          });

          child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });

          child.on('exit', (code) => {
            if (code !== 0) {
              clearTimeout(timer);
              reject(new Error(`Daemon exited with code ${code}`));
            }
          });
        });

        child.unref();
        child.disconnect();

        log.success(`Daemon started (pid: ${child.pid})`);
        log.dim(`  Socket: ${SOCKET_PATH}`);
        log.dim(`  Idle timeout: ${opts.idleTimeout} minutes`);
        log.dim(`  Stop with: stealth daemon stop`);
      }
    });

  // stealth daemon stop
  daemon
    .command('stop')
    .description('Stop the background daemon')
    .action(async () => {
      if (!isDaemonRunning()) {
        log.info('Daemon is not running');
        return;
      }

      const result = await daemonShutdown();
      if (result?.ok) {
        log.success('Daemon stopped');
      } else {
        // Force kill via PID
        try {
          const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim());
          process.kill(pid, 'SIGTERM');
          log.success(`Daemon killed (pid: ${pid})`);
        } catch {
          log.error('Failed to stop daemon');
        }
      }
    });

  // stealth daemon status
  daemon
    .command('status')
    .description('Show daemon status')
    .action(async () => {
      if (!isDaemonRunning()) {
        log.info('Daemon is not running');
        log.dim('  Start with: stealth daemon start');
        return;
      }

      const status = await daemonStatus();
      if (status?.ok) {
        log.success('Daemon is running');
        log.dim(`  PID: ${status.pid}`);
        log.dim(`  Uptime: ${status.uptime}s`);
        log.dim(`  Contexts: ${status.contexts}`);
        log.dim(`  Memory: ${status.memoryMB}MB`);
        log.dim(`  Browser: ${status.browserConnected ? 'connected' : 'disconnected'}`);
      } else {
        log.warn('Daemon is running but not responding');
      }
    });
}

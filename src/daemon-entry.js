/**
 * Daemon entry point — spawned as a detached child process
 */

import { startDaemon } from './daemon.js';

const idleTimeout = parseInt(process.env.STEALTH_IDLE_TIMEOUT) || 5 * 60 * 1000;

try {
  await startDaemon({ idleTimeout, verbose: false });

  // Signal parent that we're ready
  if (process.send) {
    process.send('ready');
  }
} catch (err) {
  console.error(`Daemon failed to start: ${err.message}`);
  process.exit(1);
}

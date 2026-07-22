import { acquireStateLocks } from '../../src/utils/state-lock.js';

const [kind, name] = process.argv.slice(2);
if (!['profile', 'session'].includes(kind) || !name) {
  console.error('Usage: state-lock-holder-child.js <profile|session> <name>');
  process.exitCode = 2;
} else {
  const release = acquireStateLocks({ [kind]: name });
  const keepAlive = setInterval(() => {}, 1000);
  console.log('locked');

  const shutdown = () => {
    clearInterval(keepAlive);
    try {
      release();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

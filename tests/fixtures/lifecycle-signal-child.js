import {
  closeBrowser,
  launchBrowser,
} from '../../src/browser.js';
import {
  createBrowserLifecycle,
  createLaunchSignalGuard,
} from '../../src/browser-lifecycle.js';

const signalGuard = createLaunchSignalGuard();
let handle;
let lifecycle;

console.log('launching');

try {
  handle = await launchBrowser({
    headless: true,
    forceDirect: true,
    handleSignals: false,
  });
  lifecycle = createBrowserLifecycle(handle);
  signalGuard.transferTo(lifecycle);
  console.log('ready');

  const result = await lifecycle.wait();
  process.exitCode = result.exitCode;
} catch (error) {
  signalGuard.dispose();
  if (lifecycle) {
    try {
      await lifecycle.requestExit('command-error');
    } catch {}
  } else if (handle) {
    await closeBrowser(handle, { persist: false });
  }

  if (signalGuard.pendingSignal) {
    process.exitCode = signalGuard.exitCode;
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeBrowser,
  launchBrowser,
} from '../../src/browser.js';
import { createBrowserLifecycle } from '../../src/browser-lifecycle.js';
import {
  createProfile,
  deleteProfile,
  loadProfile,
} from '../../src/profiles.js';

let activeHandle = null;
const createdProfiles = [];
const SIGNAL_CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lifecycle-signal-child.js',
);

function runLaunchSignal(signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SIGNAL_CHILD], {
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signalSent = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${signal} shutdown`));
    }, 30_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!signalSent && stdout.includes('launching')) {
        signalSent = true;
        child.kill(signal);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code, exitSignal, stdout, stderr, signalSent });
    });
  });
}

function uniqueProfile(label) {
  const name = `__e2e_${label}_${process.pid}_${Date.now()}`;
  createdProfiles.push(name);
  createProfile(name, { preset: 'us-laptop' });
  return name;
}

afterEach(async () => {
  if (activeHandle) {
    await closeBrowser(activeHandle, { persist: false });
    activeHandle = null;
  }
  for (const profile of createdProfiles.splice(0)) {
    try {
      deleteProfile(profile);
    } catch {}
  }
});

describe('real Camoufox browser lifecycle', () => {
  it('persists authentication cookies when the last page closes', async () => {
    const profile = uniqueProfile('page_close');
    activeHandle = await launchBrowser({
      profile,
      headless: true,
      forceDirect: true,
      handleSignals: false,
    });
    const lifecycle = createBrowserLifecycle(activeHandle, {
      checkpointInterval: 60_000,
    });
    lifecycle.start();

    await activeHandle.context.addCookies([{
      name: 'auth_token',
      value: 'page-close-value',
      url: 'https://example.com',
    }]);
    await activeHandle.page.close();
    const result = await lifecycle.wait();
    activeHandle = null;

    expect(result.reason).toBe('last-page-closed');
    expect(result.usedCheckpointFallback).toBe(false);
    expect(loadProfile(profile).cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'auth_token', value: 'page-close-value' }),
    ]));
  }, 60_000);

  it('retains the latest durable checkpoint after a hard disconnect', async () => {
    const profile = uniqueProfile('disconnect');
    activeHandle = await launchBrowser({
      profile,
      headless: true,
      forceDirect: true,
      handleSignals: false,
    });
    const lifecycle = createBrowserLifecycle(activeHandle, {
      checkpointInterval: 60_000,
    });
    lifecycle.start();

    await activeHandle.context.addCookies([{
      name: 'auth_token',
      value: 'checkpoint-value',
      url: 'https://example.com',
    }]);
    await lifecycle.checkpoint();

    const completed = lifecycle.wait();
    await activeHandle.browser.close();
    const result = await completed;
    activeHandle = null;

    expect(['last-page-closed', 'context-closed', 'disconnected']).toContain(result.reason);
    expect(result.usedCheckpointFallback).toBe(true);
    expect(loadProfile(profile).cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'auth_token', value: 'checkpoint-value' }),
    ]));
  }, 60_000);

  const signalTest = process.platform === 'win32' ? it.skip : it;
  signalTest('owns SIGHUP, SIGINT, and SIGTERM during real browser launch', async () => {
    const expectations = [
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ];

    for (const [signal, expectedCode] of expectations) {
      const result = await runLaunchSignal(signal);
      expect(result.signalSent).toBe(true);
      expect(result.exitSignal).toBeNull();
      expect(result.code).toBe(expectedCode);
      expect(result.stderr).toBe('');
    }
  }, 120_000);
});

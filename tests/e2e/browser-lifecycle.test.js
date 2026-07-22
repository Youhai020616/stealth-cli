import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  closeBrowser,
  launchBrowser,
} from '../../src/browser.js';
import { createBrowserLifecycle } from '../../src/browser-lifecycle.js';
import { acquireStateLocks } from '../../src/utils/state-lock.js';
import {
  createProfile,
  deleteProfile,
  loadProfile,
} from '../../src/profiles.js';

const ORIGINAL_STEALTH_HOME = process.env.STEALTH_HOME;
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-lifecycle-e2e-'));
process.env.STEALTH_HOME = TEST_STEALTH_HOME;

let activeHandle = null;
const createdProfiles = [];
const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);
const SIGNAL_CHILD = path.join(FIXTURES_DIR, 'lifecycle-signal-child.js');
const STATE_LOCK_CHILD = path.join(FIXTURES_DIR, 'state-lock-holder-child.js');

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

function startStateLockHolder(kind, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATE_LOCK_CHILD, kind, name], {
      cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
      env: { ...process.env, STEALTH_HOME: TEST_STEALTH_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const exited = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal, stderr }));
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for ${kind} ${name} lock`));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!ready && stdout.includes('locked')) {
        ready = true;
        clearTimeout(timeout);
        resolve({ child, exited });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`Lock holder exited before ready (${code ?? signal}): ${stderr}`));
      }
    });
  });
}

function uniqueProfile(label) {
  const name = `__e2e_${label}_${process.pid}_${Date.now()}`;
  createdProfiles.push(name);
  createProfile(name, { preset: 'us-laptop' });
  return name;
}

afterAll(() => {
  if (ORIGINAL_STEALTH_HOME === undefined) delete process.env.STEALTH_HOME;
  else process.env.STEALTH_HOME = ORIGINAL_STEALTH_HOME;
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
});

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

describe('cross-process browser state locking', () => {
  it('prevents two processes from opening the same named profile concurrently', async () => {
    const { child, exited } = await startStateLockHolder('profile', 'shared-profile');

    try {
      expect(() => acquireStateLocks({ profile: 'shared-profile' }))
        .toThrow('already in use');
    } finally {
      child.kill('SIGTERM');
    }

    const childResult = await exited;
    expect(childResult).toMatchObject({ code: 0, signal: null, stderr: '' });

    const release = acquireStateLocks({ profile: 'shared-profile' });
    release();
  }, 20_000);
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

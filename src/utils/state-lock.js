import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProfileError } from '../errors.js';
import { ensurePrivateDirectory, ensurePrivateFile } from './json-file.js';
import { assertStateName, getStateLocksDir } from './storage-paths.js';

const INVALID_LOCK_STALE_MS = 30_000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockPath(key) {
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(getStateLocksDir(), `${digest}.lock`);
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function canRecoverLock(filePath, metadata) {
  if (metadata?.hostname === os.hostname()) {
    return !processIsAlive(metadata.pid);
  }
  if (metadata) return false;

  try {
    return Date.now() - fs.statSync(filePath).mtimeMs > INVALID_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function acquireLock(target) {
  const locksDir = getStateLocksDir();
  try {
    ensurePrivateDirectory(locksDir);
  } catch (cause) {
    throw new ProfileError('Browser state lock storage is not private', {
      hint: `Fix permissions for: ${locksDir}`,
      cause,
    });
  }
  const filePath = lockPath(`${target.kind}:${target.name}`);
  const token = crypto.randomUUID();
  const metadata = {
    token,
    kind: target.kind,
    name: target.name,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    let created = false;
    try {
      descriptor = fs.openSync(filePath, 'wx', 0o600);
      created = true;
      fs.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      ensurePrivateFile(filePath);

      let released = false;
      return () => {
        if (released) return;
        const current = readLock(filePath);
        if (!current) {
          if (fs.existsSync(filePath)) {
            throw new ProfileError(
              `${target.kind} "${target.name}" lock ownership could not be verified`,
            );
          }
          released = true;
          return;
        }
        if (current.token !== token) {
          released = true;
          return;
        }
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        released = true;
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {}
      }
      if (created) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
      if (error.code !== 'EEXIST') {
        if (error instanceof ProfileError) throw error;
        throw new ProfileError(
          `Failed to acquire ${target.kind} "${target.name}" lock`,
          { cause: error },
        );
      }

      try {
        ensurePrivateFile(filePath);
      } catch (cause) {
        if (cause.code === 'ENOENT') continue;
        throw new ProfileError(
          `${target.kind} "${target.name}" lock is not private`,
          { cause },
        );
      }
      const existing = readLock(filePath);
      if (attempt === 0 && canRecoverLock(filePath, existing)) {
        try {
          fs.unlinkSync(filePath);
          continue;
        } catch (unlinkError) {
          if (unlinkError.code === 'ENOENT') continue;
          throw new ProfileError(
            `Failed to recover stale ${target.kind} "${target.name}" lock`,
            { cause: unlinkError },
          );
        }
      }

      const owner = existing?.pid ? ` by process ${existing.pid}` : '';
      throw new ProfileError(
        `${target.kind} "${target.name}" is already in use${owner}`,
        { hint: 'Close the other stealth browser before reusing this state' },
      );
    }
  }

  throw new ProfileError(`${target.kind} "${target.name}" could not be locked`);
}

/**
 * Acquire deterministic, process-wide leases for browser authentication state.
 *
 * @param {object} opts
 * @param {string} [opts.profile]
 * @param {string} [opts.session]
 * @returns {() => void} Idempotent release function
 */
export function acquireStateLocks(opts = {}) {
  const targets = [];
  if (opts.profile) {
    targets.push({ kind: 'profile', name: assertStateName(opts.profile, 'Profile') });
  }
  if (opts.session) {
    targets.push({ kind: 'session', name: assertStateName(opts.session, 'Session') });
  }
  targets.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));

  const releases = [];
  try {
    for (const target of targets) releases.push(acquireLock(target));
  } catch (error) {
    for (const release of releases.reverse()) {
      try {
        release();
      } catch {}
    }
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    const errors = [];
    for (let index = releases.length - 1; index >= 0; index -= 1) {
      try {
        releases[index]();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
    released = true;
  };
}

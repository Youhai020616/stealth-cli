import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProfileError } from '../errors.js';
import { ensurePrivateDirectory, ensurePrivateFile } from './json-file.js';
import {
  assertStateName,
  getStateLocksDir,
  getStealthHome,
} from './storage-paths.js';

const STATE_KINDS = new Set(['profile', 'session']);
const LINK_PUBLICATION_FALLBACK_CODES = new Set([
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);
const STATE_LEASE_RECORDS = new WeakMap();

function targetFor(kind, name) {
  if (!STATE_KINDS.has(kind)) {
    throw new ProfileError(`Unknown browser state kind "${kind}"`);
  }
  const label = kind === 'profile' ? 'Profile' : 'Session';
  return { kind, name: assertStateName(name, label) };
}

function processStatus(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'invalid';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error.code === 'EPERM') return 'alive';
    if (error.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function lockPath(target) {
  const key = `${target.kind}:${target.name}`;
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(getStateLocksDir(), `${digest}.lock`);
}

function staleLockHint(filePath) {
  return `After confirming no stealth process is using this state, remove this exact lock file: ${filePath}`;
}

function readLock(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(contents);
  } catch {
    return null;
  }
}

function validLockMetadata(metadata, target) {
  return Boolean(
    metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && typeof metadata.token === 'string'
    && metadata.token.length > 0
    && metadata.kind === target.kind
    && metadata.name === target.name
    && Number.isInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.hostname === 'string'
    && metadata.hostname.length > 0
    && typeof metadata.createdAt === 'string'
    && !Number.isNaN(Date.parse(metadata.createdAt)),
  );
}

function fileIdentity(stats) {
  return { device: stats.dev, inode: stats.ino };
}

function hasFileIdentity(stats, identity) {
  return stats.dev === identity.device && stats.ino === identity.inode;
}

function appendCleanupFailure(error, target, cleanupError) {
  const existing = Array.isArray(error.cleanupFailures) ? error.cleanupFailures : [];
  error.cleanupFailures = [
    ...existing,
    { target: `${target.kind}:${target.name}`, error: cleanupError },
  ];
}

function cleanupOwnedPublishedLock(target, filePath, identity) {
  let current;
  try {
    current = fs.lstatSync(filePath, { throwIfNoEntry: false });
  } catch (cause) {
    throw new ProfileError(
      `${target.kind} "${target.name}" partial lock cleanup could not be verified`,
      { hint: staleLockHint(filePath), cause },
    );
  }

  if (!current) return;
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, identity)
  ) {
    throw new ProfileError(
      `${target.kind} "${target.name}" partial lock is no longer owned by this process`,
      { hint: staleLockHint(filePath) },
    );
  }

  try {
    fs.unlinkSync(filePath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return;
    throw new ProfileError(
      `Failed to clean up partial ${target.kind} "${target.name}" lock`,
      { hint: staleLockHint(filePath), cause },
    );
  }
}

function ensureLocksDir() {
  const root = getStealthHome();
  const locksDir = getStateLocksDir();
  try {
    // Validate the configured root before creating or opening a child path.
    ensurePrivateDirectory(root);
    ensurePrivateDirectory(locksDir);
  } catch (cause) {
    throw new ProfileError('Browser state lock storage is not private', {
      hint: `Fix permissions and path types for: ${root}`,
      cause,
    });
  }
  return locksDir;
}

function inspectExistingLock(target, filePath) {
  try {
    ensurePrivateFile(filePath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return 'retry';
    throw new ProfileError(
      `${target.kind} "${target.name}" lock path is unsafe`,
      { hint: staleLockHint(filePath), cause },
    );
  }

  let existing;
  try {
    existing = readLock(filePath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return 'retry';
    throw new ProfileError(
      `Failed to inspect ${target.kind} "${target.name}" lock`,
      { hint: `Check access permissions for: ${filePath}`, cause },
    );
  }

  if (!validLockMetadata(existing, target)) {
    throw new ProfileError(
      `${target.kind} "${target.name}" has an invalid stale lock`,
      { hint: staleLockHint(filePath) },
    );
  }

  const status = existing.hostname === os.hostname()
    ? processStatus(existing.pid)
    : 'remote';
  if (status === 'dead') {
    throw new ProfileError(
      `${target.kind} "${target.name}" has a stale lock from process ${existing.pid}`,
      { hint: staleLockHint(filePath) },
    );
  }

  const owner = existing.hostname === os.hostname()
    ? `process ${existing.pid}`
    : `process ${existing.pid} on ${existing.hostname}`;
  throw new ProfileError(
    `${target.kind} "${target.name}" is already in use by ${owner}`,
    { hint: 'Close the other stealth browser before reusing this state' },
  );
}

function createRelease(target, filePath, token) {
  let active = true;
  let owned = true;

  function clearOwnership() {
    active = false;
    owned = false;
  }

  return {
    isActive: () => active && owned,
    release() {
      if (!active) return;

      try {
        ensurePrivateFile(filePath);
      } catch (cause) {
        if (cause.code === 'ENOENT') {
          clearOwnership();
          return;
        }
        owned = false;
        throw new ProfileError(
          `${target.kind} "${target.name}" lock ownership could not be verified`,
          { hint: staleLockHint(filePath), cause },
        );
      }

      let current;
      try {
        current = readLock(filePath);
      } catch (cause) {
        if (cause.code === 'ENOENT') {
          clearOwnership();
          return;
        }
        owned = false;
        throw new ProfileError(
          `${target.kind} "${target.name}" lock ownership could not be verified`,
          { hint: staleLockHint(filePath), cause },
        );
      }

      if (!current) {
        owned = false;
        throw new ProfileError(
          `${target.kind} "${target.name}" lock ownership could not be verified`,
          { hint: staleLockHint(filePath) },
        );
      }
      if (current.token !== token) {
        clearOwnership();
        return;
      }

      try {
        fs.unlinkSync(filePath);
      } catch (cause) {
        if (cause.code === 'ENOENT') {
          clearOwnership();
          return;
        }
        throw new ProfileError(
          `Failed to release ${target.kind} "${target.name}" lock: ${cause.message}`,
          { cause },
        );
      }
      clearOwnership();
    },
  };
}

function publishLockWithExclusiveOpen(target, filePath, metadata) {
  let descriptor;
  let identity;

  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    const stats = fs.fstatSync(descriptor);
    identity = fileIdentity(stats);
    if (!stats.isFile()) {
      const error = new Error(`Lock path is not a regular file: ${filePath}`);
      error.code = 'EUNSAFESTATEPATH';
      throw error;
    }

    fs.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    const closingDescriptor = descriptor;
    descriptor = undefined;
    fs.closeSync(closingDescriptor);

    ensurePrivateFile(filePath);
    const published = readLock(filePath);
    if (!validLockMetadata(published, target) || published.token !== metadata.token) {
      throw new ProfileError(
        `${target.kind} "${target.name}" lock publication could not be verified`,
        { hint: staleLockHint(filePath) },
      );
    }

    return createRelease(target, filePath, metadata.token);
  } catch (cause) {
    // An EEXIST from the exclusive create belongs to another contender. It
    // must be inspected by the normal conflict path, never cleaned up here.
    if (cause.code === 'EEXIST' && identity === undefined) throw cause;

    const failure = cause instanceof ProfileError
      ? cause
      : new ProfileError(
        `Failed to acquire ${target.kind} "${target.name}" lock`,
        { cause },
      );

    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        appendCleanupFailure(failure, target, cleanupError);
      }
    }
    if (identity !== undefined) {
      try {
        cleanupOwnedPublishedLock(target, filePath, identity);
      } catch (cleanupError) {
        appendCleanupFailure(failure, target, cleanupError);
      }
    }

    throw failure;
  }
}

function acquireLock(target) {
  const locksDir = ensureLocksDir();
  const filePath = lockPath(target);
  const tempPath = path.join(
    locksDir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const token = crypto.randomUUID();
  const metadata = {
    token,
    kind: target.kind,
    name: target.name,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };

  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    ensurePrivateFile(tempPath);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let publicationError;
      try {
        // A hard link publishes a fully written inode and fails if the lock name
        // already exists, avoiding partially visible lock metadata.
        fs.linkSync(tempPath, filePath);
        return createRelease(target, filePath, token);
      } catch (error) {
        publicationError = error;
      }

      if (LINK_PUBLICATION_FALLBACK_CODES.has(publicationError.code)) {
        try {
          // Some filesystems cannot publish with hard links. Exclusive creation
          // makes the final path visible before writing, so contenders fail
          // closed on incomplete metadata until this owner finishes or cleans up.
          return publishLockWithExclusiveOpen(target, filePath, metadata);
        } catch (error) {
          publicationError = error;
        }
      }

      if (publicationError.code !== 'EEXIST') {
        if (publicationError instanceof ProfileError) throw publicationError;
        throw new ProfileError(
          `Failed to acquire ${target.kind} "${target.name}" lock`,
          { cause: publicationError },
        );
      }
      if (inspectExistingLock(target, filePath) === 'retry') continue;
    }
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError(
      `Failed to acquire ${target.kind} "${target.name}" lock`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }

  throw new ProfileError(`${target.kind} "${target.name}" could not be locked`);
}

/**
 * Acquire deterministic, process-wide leases for browser authentication state.
 *
 * @param {object} opts
 * @param {string} [opts.profile]
 * @param {string} [opts.session]
 * @returns {(() => void) & { owns(kind: string, name: string): boolean }}
 *   Callable, idempotent, retryable release function and ownership predicate.
 */
export function acquireStateLocks(opts = {}) {
  const targets = [];
  if (opts.profile !== undefined && opts.profile !== null) {
    targets.push(targetFor('profile', opts.profile));
  }
  if (opts.session !== undefined && opts.session !== null) {
    targets.push(targetFor('session', opts.session));
  }
  targets.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));

  const records = [];
  try {
    for (const target of targets) {
      records.push({ target, lock: acquireLock(target) });
    }
  } catch (error) {
    const cleanupFailures = [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      try {
        records[index].lock.release();
      } catch (cleanupError) {
        cleanupFailures.push({
          target: `${records[index].target.kind}:${records[index].target.name}`,
          error: cleanupError,
        });
      }
    }
    if (cleanupFailures.length > 0) {
      const existing = Array.isArray(error.cleanupFailures) ? error.cleanupFailures : [];
      error.cleanupFailures = [...existing, ...cleanupFailures];
    }
    throw error;
  }

  const lease = () => {
    const errors = [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      try {
        records[index].lock.release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
  };

  STATE_LEASE_RECORDS.set(lease, records);
  lease.owns = (kind, name) => ownsStateLock(lease, kind, name);

  return lease;
}

/**
 * Verify that a value is a genuine module-created lease with active ownership.
 *
 * @param {unknown} lease
 * @param {'profile'|'session'} kind
 * @param {string} name
 * @returns {boolean}
 */
export function ownsStateLock(lease, kind, name) {
  if (
    (typeof lease !== 'function' && (typeof lease !== 'object' || lease === null))
    || !STATE_KINDS.has(kind)
  ) {
    return false;
  }

  const records = STATE_LEASE_RECORDS.get(lease);
  if (!records) return false;

  let target;
  try {
    target = targetFor(kind, name);
  } catch {
    return false;
  }

  return records.some(({ target: held, lock }) => (
    lock.isActive() && held.kind === target.kind && held.name === target.name
  ));
}

/**
 * Run a callback under a state lock, reusing a compatible active lease.
 * The callback may return either a value or a promise.
 *
 * @template T
 * @param {'profile'|'session'} kind
 * @param {string} name
 * @param {null|undefined|Function} lease
 * @param {(activeLease: Function) => T} callback
 * @returns {T}
 */
export function withStateLock(kind, name, lease, callback) {
  const target = targetFor(kind, name);
  if (typeof callback !== 'function') {
    throw new TypeError('State lock callback must be a function');
  }

  if (ownsStateLock(lease, target.kind, target.name)) {
    return callback(lease);
  }

  const activeLease = acquireStateLocks({ [target.kind]: target.name });
  let result;
  try {
    result = callback(activeLease);
  } catch (error) {
    try {
      activeLease();
    } catch (cleanupError) {
      error.cleanupFailures = [{ target: `${target.kind}:${target.name}`, error: cleanupError }];
    }
    throw error;
  }

  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).then(
      (value) => {
        activeLease();
        return value;
      },
      (error) => {
        try {
          activeLease();
        } catch (cleanupError) {
          error.cleanupFailures = [{ target: `${target.kind}:${target.name}`, error: cleanupError }];
        }
        throw error;
      },
    );
  }

  activeLease();
  return result;
}

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { attachCleanupFailures, ProfileError } from '../errors.js';
import { ensurePrivateDirectory } from './json-file.js';
import { assertStateName, getStealthHome } from './storage-paths.js';

const STATE_KINDS = new Set(['profile', 'session']);
const OWNER_FILE_PATTERN = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.owner\.json$/;
const STATE_LEASE_RECORDS = new WeakMap();

function currentUserId() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function targetFor(kind, name, root = getStealthHome()) {
  if (!STATE_KINDS.has(kind)) {
    throw new ProfileError(`Unknown browser state kind "${kind}"`);
  }
  const label = kind === 'profile' ? 'Profile' : 'Session';
  return Object.freeze({
    root: path.resolve(root),
    kind,
    name: assertStateName(name, label),
  });
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

function locksDirectory(root) {
  return path.join(root, 'locks');
}

function lockPath(target) {
  const key = `${target.kind}:${target.name}`;
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(locksDirectory(target.root), `${digest}.lock`);
}

function ownerFileName(token) {
  return `${token}.owner.json`;
}

function staleLockHint(directoryPath) {
  return `After confirming no stealth process is using this state, remove this exact lock directory: ${directoryPath}`;
}

function unsafePathError(targetPath, expectedType) {
  const error = new Error(
    `State lock path must be ${expectedType} and must not be a symbolic link: ${targetPath}`,
  );
  error.code = 'EUNSAFESTATEPATH';
  return error;
}

function insecurePermissionsError(targetPath, expectedMode, actualMode) {
  const error = new Error(
    `State lock path must have mode ${expectedMode.toString(8)}: ${targetPath} (${actualMode.toString(8)})`,
  );
  error.code = 'EINSECUREPERMISSIONS';
  return error;
}

function wrongOwnerError(targetPath, expectedUserId, actualUserId) {
  const error = new Error(
    `State lock path must be owned by uid ${expectedUserId}: ${targetPath} (uid ${actualUserId})`,
  );
  error.code = 'EINVALIDSTATELOCKOWNER';
  return error;
}

function invalidGenerationError(message) {
  const error = new Error(message);
  error.code = 'EINVALIDSTATELOCK';
  return error;
}

function assertPrivateNode(stats, targetPath, type, mode) {
  const validType = type === 'directory' ? stats.isDirectory() : stats.isFile();
  if (!validType || stats.isSymbolicLink()) {
    throw unsafePathError(targetPath, type === 'directory' ? 'a directory' : 'a regular file');
  }

  if (process.platform !== 'win32') {
    const actualMode = stats.mode & 0o777;
    if (actualMode !== mode) {
      throw insecurePermissionsError(targetPath, mode, actualMode);
    }

    const userId = currentUserId();
    if (userId !== null && stats.uid !== userId) {
      throw wrongOwnerError(targetPath, userId, stats.uid);
    }
  }
}

function nodeIdentity(stats) {
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function hasNodeIdentity(stats, identity) {
  return stats.dev === identity.device && stats.ino === identity.inode;
}

function readMetadata(contents) {
  try {
    return JSON.parse(contents);
  } catch {
    return null;
  }
}

function readOwnerFile(ownerPath) {
  let descriptor;
  let failure;
  let result;

  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(ownerPath, fs.constants.O_RDONLY | noFollow);
    const stats = fs.fstatSync(descriptor);
    assertPrivateNode(stats, ownerPath, 'file', 0o600);
    result = {
      identity: nodeIdentity(stats),
      metadata: readMetadata(fs.readFileSync(descriptor, 'utf8')),
    };
  } catch (error) {
    failure = error;
  }

  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (!failure) failure = error;
    }
  }

  if (failure) throw failure;
  return result;
}

function validLockMetadata(metadata, target, token) {
  return Boolean(
    metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && metadata.token === token
    && metadata.root === target.root
    && metadata.kind === target.kind
    && metadata.name === target.name
    && metadata.uid === currentUserId()
    && Number.isInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.hostname === 'string'
    && metadata.hostname.length > 0
    && typeof metadata.createdAt === 'string'
    && !Number.isNaN(Date.parse(metadata.createdAt)),
  );
}

function cleanupEntry(target, error) {
  return { target: `${target.kind}:${target.name}`, error };
}

function attachStateCleanupFailures(error, failures) {
  try {
    attachCleanupFailures(error, failures);
  } catch {
    // Cleanup diagnostics must never replace a primitive or non-extensible primary error.
  }
}

function ensureLocksDir(root) {
  const directory = locksDirectory(root);
  try {
    ensurePrivateDirectory(root);
    assertPrivateNode(fs.lstatSync(root), root, 'directory', 0o700);
    ensurePrivateDirectory(directory);
    assertPrivateNode(fs.lstatSync(directory), directory, 'directory', 0o700);
  } catch (cause) {
    throw new ProfileError('Browser state lock storage is not private', {
      hint: `Fix permissions, ownership, and path types for: ${root}`,
      cause,
    });
  }
  return directory;
}

function currentDirectoryStats(directoryPath) {
  return fs.lstatSync(directoryPath, { throwIfNoEntry: false });
}

function directoryStillMatches(directoryPath, identity) {
  const stats = currentDirectoryStats(directoryPath);
  if (!stats || !hasNodeIdentity(stats, identity)) return null;
  assertPrivateNode(stats, directoryPath, 'directory', 0o700);
  return stats;
}

function ownerPathStillMatches(ownerPath, identity) {
  const stats = fs.lstatSync(ownerPath, { throwIfNoEntry: false });
  if (!stats || !hasNodeIdentity(stats, identity)) return null;
  assertPrivateNode(stats, ownerPath, 'file', 0o600);
  return stats;
}

function inspectOwnedGeneration({
  target,
  directoryPath,
  directoryIdentity,
  ownerPath,
  ownerIdentity,
  token,
}) {
  const directoryStats = currentDirectoryStats(directoryPath);
  if (!directoryStats) return 'absent';
  if (!hasNodeIdentity(directoryStats, directoryIdentity)) return 'replaced';
  assertPrivateNode(directoryStats, directoryPath, 'directory', 0o700);

  let owner;
  try {
    owner = readOwnerFile(ownerPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const current = currentDirectoryStats(directoryPath);
      if (!current) return 'absent';
      if (!hasNodeIdentity(current, directoryIdentity)) return 'replaced';
      return 'owner-missing';
    }
    throw error;
  }

  if (!hasNodeIdentity(
    { dev: owner.identity.device, ino: owner.identity.inode },
    ownerIdentity,
  )) {
    return 'owner-replaced';
  }
  if (!ownerPathStillMatches(ownerPath, ownerIdentity)) return 'owner-replaced';

  const entries = fs.readdirSync(directoryPath);
  const current = currentDirectoryStats(directoryPath);
  if (!current) return 'absent';
  if (!hasNodeIdentity(current, directoryIdentity)) return 'replaced';
  assertPrivateNode(current, directoryPath, 'directory', 0o700);

  if (entries.length !== 1 || entries[0] !== path.basename(ownerPath)) {
    throw invalidGenerationError(`State lock directory has unexpected owner entries: ${directoryPath}`);
  }
  if (!validLockMetadata(owner.metadata, target, token)) {
    throw invalidGenerationError(`State lock owner metadata is invalid: ${ownerPath}`);
  }

  return 'owned';
}

function invalidStaleLock(target, directoryPath, cause) {
  return new ProfileError(
    `${target.kind} "${target.name}" has an invalid stale lock`,
    { hint: staleLockHint(directoryPath), cause },
  );
}

function inspectExistingLock(target, directoryPath) {
  let directoryStats;
  try {
    directoryStats = currentDirectoryStats(directoryPath);
  } catch (cause) {
    throw new ProfileError(
      `Failed to inspect ${target.kind} "${target.name}" lock`,
      { hint: staleLockHint(directoryPath), cause },
    );
  }
  if (!directoryStats) return 'retry';

  try {
    assertPrivateNode(directoryStats, directoryPath, 'directory', 0o700);
  } catch (cause) {
    throw new ProfileError(
      `${target.kind} "${target.name}" lock directory is unsafe`,
      { hint: staleLockHint(directoryPath), cause },
    );
  }
  const directoryIdentity = nodeIdentity(directoryStats);

  let entries;
  try {
    entries = fs.readdirSync(directoryPath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return 'retry';
    throw new ProfileError(
      `Failed to inspect ${target.kind} "${target.name}" lock`,
      { hint: staleLockHint(directoryPath), cause },
    );
  }

  const current = currentDirectoryStats(directoryPath);
  if (!current || !hasNodeIdentity(current, directoryIdentity)) return 'retry';
  if (entries.length !== 1) throw invalidStaleLock(target, directoryPath);

  const match = OWNER_FILE_PATTERN.exec(entries[0]);
  if (!match) throw invalidStaleLock(target, directoryPath);
  const token = match[1];
  const ownerPath = path.join(directoryPath, entries[0]);

  let owner;
  try {
    owner = readOwnerFile(ownerPath);
    if (!ownerPathStillMatches(ownerPath, owner.identity)) return 'retry';
  } catch (cause) {
    if (cause.code === 'ENOENT') return 'retry';
    throw new ProfileError(
      `${target.kind} "${target.name}" lock owner metadata is unsafe`,
      { hint: staleLockHint(directoryPath), cause },
    );
  }

  const finalDirectory = currentDirectoryStats(directoryPath);
  if (!finalDirectory || !hasNodeIdentity(finalDirectory, directoryIdentity)) return 'retry';
  if (!validLockMetadata(owner.metadata, target, token)) {
    throw invalidStaleLock(target, directoryPath);
  }

  const status = owner.metadata.hostname === os.hostname()
    ? processStatus(owner.metadata.pid)
    : 'remote';
  if (status === 'dead') {
    throw new ProfileError(
      `${target.kind} "${target.name}" has a stale lock from process ${owner.metadata.pid}`,
      { hint: staleLockHint(directoryPath) },
    );
  }

  const ownerDescription = owner.metadata.hostname === os.hostname()
    ? `process ${owner.metadata.pid}`
    : `process ${owner.metadata.pid} on ${owner.metadata.hostname}`;
  throw new ProfileError(
    `${target.kind} "${target.name}" is already in use by ${ownerDescription}`,
    { hint: 'Close the other stealth browser before reusing this state' },
  );
}

function rollbackOwnedGeneration(
  target,
  directoryPath,
  directoryIdentity,
  ownerPath,
  ownerIdentity,
) {
  if (!directoryStillMatches(directoryPath, directoryIdentity)) return;

  if (ownerIdentity) {
    const ownerStats = fs.lstatSync(ownerPath, { throwIfNoEntry: false });
    if (!ownerStats) return;
    if (!hasNodeIdentity(ownerStats, ownerIdentity)) {
      throw new ProfileError(
        `${target.kind} "${target.name}" partial lock owner is no longer owned by this process`,
        { hint: staleLockHint(directoryPath) },
      );
    }
    assertPrivateNode(ownerStats, ownerPath, 'file', 0o600);

    try {
      fs.unlinkSync(ownerPath);
    } catch (cause) {
      if (cause.code === 'ENOENT') return;
      throw new ProfileError(
        `Failed to clean up partial ${target.kind} "${target.name}" lock owner`,
        { hint: staleLockHint(directoryPath), cause },
      );
    }
  }

  if (!directoryStillMatches(directoryPath, directoryIdentity)) return;
  const entries = fs.readdirSync(directoryPath);
  if (entries.length !== 0) {
    throw new ProfileError(
      `${target.kind} "${target.name}" partial lock directory is not empty`,
      { hint: staleLockHint(directoryPath) },
    );
  }
  if (!directoryStillMatches(directoryPath, directoryIdentity)) return;

  try {
    fs.rmdirSync(directoryPath);
  } catch (cause) {
    if (cause.code === 'ENOENT') return;
    throw new ProfileError(
      `Failed to clean up partial ${target.kind} "${target.name}" lock directory`,
      { hint: staleLockHint(directoryPath), cause },
    );
  }
}

function createRelease(record) {
  let authorizationActive = true;
  let ownerRemoved = false;
  let cleanupComplete = false;

  function markReplaced() {
    authorizationActive = false;
    cleanupComplete = true;
  }

  function ownershipFailure(cause) {
    authorizationActive = false;
    return new ProfileError(
      `${record.target.kind} "${record.target.name}" lock ownership could not be verified`,
      { hint: staleLockHint(record.directoryPath), cause },
    );
  }

  function cleanupReleasedDirectory() {
    let directoryStats;
    try {
      directoryStats = currentDirectoryStats(record.directoryPath);
    } catch (cause) {
      throw new ProfileError(
        `Failed to release ${record.target.kind} "${record.target.name}" lock directory: ${cause.message}`,
        { hint: staleLockHint(record.directoryPath), cause },
      );
    }

    if (!directoryStats || !hasNodeIdentity(directoryStats, record.directoryIdentity)) {
      cleanupComplete = true;
      return;
    }

    try {
      assertPrivateNode(directoryStats, record.directoryPath, 'directory', 0o700);
      const entries = fs.readdirSync(record.directoryPath);
      if (entries.length !== 0) {
        throw invalidGenerationError(
          `Released state lock directory is not empty: ${record.directoryPath}`,
        );
      }
      if (!directoryStillMatches(record.directoryPath, record.directoryIdentity)) {
        cleanupComplete = true;
        return;
      }
      fs.rmdirSync(record.directoryPath);
      cleanupComplete = true;
    } catch (cause) {
      if (cause.code === 'ENOENT') {
        cleanupComplete = true;
        return;
      }
      throw new ProfileError(
        `Failed to release ${record.target.kind} "${record.target.name}" lock directory: ${cause.message}`,
        { hint: staleLockHint(record.directoryPath), cause },
      );
    }
  }

  return {
    isActive() {
      if (!authorizationActive || ownerRemoved || cleanupComplete) return false;
      try {
        const status = inspectOwnedGeneration(record);
        if (status === 'owned') return true;
        authorizationActive = false;
        if (status === 'absent' || status === 'replaced') cleanupComplete = true;
        return false;
      } catch {
        authorizationActive = false;
        return false;
      }
    },

    release() {
      if (cleanupComplete) return;

      if (!ownerRemoved) {
        let status;
        try {
          status = inspectOwnedGeneration(record);
        } catch (cause) {
          throw ownershipFailure(cause);
        }

        if (status === 'absent' || status === 'replaced') {
          markReplaced();
          return;
        }
        if (status !== 'owned') {
          throw ownershipFailure(
            invalidGenerationError(`State lock owner is ${status}: ${record.ownerPath}`),
          );
        }

        try {
          fs.unlinkSync(record.ownerPath);
        } catch (cause) {
          if (cause.code === 'ENOENT') {
            authorizationActive = false;
            const current = currentDirectoryStats(record.directoryPath);
            if (!current || !hasNodeIdentity(current, record.directoryIdentity)) {
              cleanupComplete = true;
              return;
            }
            throw ownershipFailure(cause);
          }
          throw new ProfileError(
            `Failed to release ${record.target.kind} "${record.target.name}" lock owner: ${cause.message}`,
            { hint: staleLockHint(record.directoryPath), cause },
          );
        }

        authorizationActive = false;
        ownerRemoved = true;
      }

      cleanupReleasedDirectory();
    },
  };
}

function publishOwnedGeneration(target, directoryPath) {
  const token = crypto.randomUUID();
  const ownerPath = path.join(directoryPath, ownerFileName(token));
  const metadata = {
    token,
    root: target.root,
    kind: target.kind,
    name: target.name,
    uid: currentUserId(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };

  let directoryIdentity;
  let ownerIdentity;
  let descriptor;

  try {
    const directoryStats = currentDirectoryStats(directoryPath);
    if (!directoryStats) {
      throw invalidGenerationError(`New state lock directory disappeared: ${directoryPath}`);
    }
    assertPrivateNode(directoryStats, directoryPath, 'directory', 0o700);
    directoryIdentity = nodeIdentity(directoryStats);

    descriptor = fs.openSync(ownerPath, 'wx', 0o600);
    const ownerStats = fs.fstatSync(descriptor);
    assertPrivateNode(ownerStats, ownerPath, 'file', 0o600);
    ownerIdentity = nodeIdentity(ownerStats);

    fs.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const record = Object.freeze({
      target,
      directoryPath,
      directoryIdentity,
      ownerPath,
      ownerIdentity,
      token,
    });
    if (inspectOwnedGeneration(record) !== 'owned') {
      throw new ProfileError(
        `${target.kind} "${target.name}" lock publication could not be verified`,
        { hint: staleLockHint(directoryPath) },
      );
    }

    return createRelease(record);
  } catch (cause) {
    const failure = cause instanceof ProfileError
      ? cause
      : new ProfileError(
        `Failed to acquire ${target.kind} "${target.name}" lock`,
        { hint: staleLockHint(directoryPath), cause },
      );
    const cleanupFailures = [];

    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupEntry(target, cleanupError));
      }
    }
    if (directoryIdentity) {
      try {
        rollbackOwnedGeneration(
          target,
          directoryPath,
          directoryIdentity,
          ownerPath,
          ownerIdentity,
        );
      } catch (cleanupError) {
        cleanupFailures.push(cleanupEntry(target, cleanupError));
      }
    }

    attachStateCleanupFailures(failure, cleanupFailures);
    throw failure;
  }
}

function acquireLock(target) {
  ensureLocksDir(target.root);
  const directoryPath = lockPath(target);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(directoryPath, { mode: 0o700 });
      return publishOwnedGeneration(target, directoryPath);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        if (error instanceof ProfileError) throw error;
        throw new ProfileError(
          `Failed to acquire ${target.kind} "${target.name}" lock`,
          { hint: staleLockHint(directoryPath), cause: error },
        );
      }
      if (inspectExistingLock(target, directoryPath) === 'retry') continue;
    }
  }

  throw new ProfileError(`${target.kind} "${target.name}" could not be locked`, {
    hint: staleLockHint(directoryPath),
  });
}

function leaseOwnsTarget(lease, target) {
  if (typeof lease !== 'function' && (typeof lease !== 'object' || lease === null)) {
    return false;
  }

  const records = STATE_LEASE_RECORDS.get(lease);
  if (!records) return false;

  return records.some(({ target: held, lock }) => (
    held.root === target.root
    && held.kind === target.kind
    && held.name === target.name
    && lock.isActive()
  ));
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
  const root = getStealthHome();
  const targets = [];
  if (opts.profile !== undefined && opts.profile !== null) {
    targets.push(targetFor('profile', opts.profile, root));
  }
  if (opts.session !== undefined && opts.session !== null) {
    targets.push(targetFor('session', opts.session, root));
  }
  targets.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));

  const acquiredRecords = [];
  try {
    for (const target of targets) {
      acquiredRecords.push(Object.freeze({ target, lock: acquireLock(target) }));
    }
  } catch (error) {
    const cleanupFailures = [];
    for (let index = acquiredRecords.length - 1; index >= 0; index -= 1) {
      try {
        acquiredRecords[index].lock.release();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupEntry(acquiredRecords[index].target, cleanupError));
      }
    }
    attachStateCleanupFailures(error, cleanupFailures);
    throw error;
  }

  const records = Object.freeze(acquiredRecords.slice());
  const lease = () => {
    let firstError;
    const cleanupFailures = [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      try {
        records[index].lock.release();
      } catch (error) {
        if (!firstError) firstError = error;
        else cleanupFailures.push(cleanupEntry(records[index].target, error));
      }
    }
    if (firstError) {
      attachStateCleanupFailures(firstError, cleanupFailures);
      throw firstError;
    }
  };

  STATE_LEASE_RECORDS.set(lease, records);
  lease.owns = (kind, name) => ownsStateLock(lease, kind, name);

  return lease;
}

/**
 * Verify that a value is a genuine module-created lease with active ownership
 * for the currently resolved STEALTH_HOME root.
 *
 * @param {unknown} lease
 * @param {'profile'|'session'} kind
 * @param {string} name
 * @returns {boolean}
 */
export function ownsStateLock(lease, kind, name) {
  if (!STATE_KINDS.has(kind)) return false;

  let target;
  try {
    target = targetFor(kind, name);
  } catch {
    return false;
  }
  return leaseOwnsTarget(lease, target);
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

  if (leaseOwnsTarget(lease, target)) {
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
      attachStateCleanupFailures(error, [cleanupEntry(target, cleanupError)]);
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
          attachStateCleanupFailures(error, [cleanupEntry(target, cleanupError)]);
        }
        throw error;
      },
    );
  }

  activeLease();
  return result;
}

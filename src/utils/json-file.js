import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PENDING_JSON_CLEANUPS = new Map();
const PRIVATE_READ_FLAGS = (
  fs.constants.O_RDONLY
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_NONBLOCK || 0)
  | (fs.constants.O_CLOEXEC || 0)
);

function currentUserId() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function unsafePathError(targetPath, expectedType) {
  const error = new Error(
    `Sensitive state path must be ${expectedType} and must not be a symbolic link: ${targetPath}`,
  );
  error.code = 'EUNSAFESTATEPATH';
  return error;
}

function insecurePermissionsError(targetPath, mode, actualMode, cause) {
  const error = new Error(
    `Sensitive state path has insecure permissions: ${targetPath} (${actualMode.toString(8)}, expected ${mode.toString(8)})`,
    { cause },
  );
  error.code = 'EINSECUREPERMISSIONS';
  return error;
}

function wrongOwnerError(targetPath, expectedUserId, actualUserId) {
  const error = new Error(
    `Sensitive state path must be owned by uid ${expectedUserId}: ${targetPath} (uid ${actualUserId})`,
  );
  error.code = 'EINVALIDSTATEOWNER';
  return error;
}

function replacedPathError(targetPath) {
  const error = new Error(`Sensitive state path was replaced while in use: ${targetPath}`);
  error.code = 'ESTATEPATHREPLACED';
  return error;
}

function changedFileError(targetPath) {
  const error = new Error(`Sensitive state file changed while it was being read: ${targetPath}`);
  error.code = 'ESTATEFILECHANGED';
  return error;
}

function assertCurrentOwner(stats, targetPath) {
  if (process.platform === 'win32') return;
  const userId = currentUserId();
  if (userId !== null && stats.uid !== userId) {
    throw wrongOwnerError(targetPath, userId, stats.uid);
  }
}

function enforcePrivateMode(targetPath, mode) {
  let stats = fs.lstatSync(targetPath);
  assertCurrentOwner(stats, targetPath);
  if (process.platform === 'win32') return stats;
  if ((stats.mode & 0o777) === mode) return stats;

  let chmodError = null;
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    chmodError = error;
  }

  stats = fs.lstatSync(targetPath);
  assertCurrentOwner(stats, targetPath);
  const actualMode = stats.mode & 0o777;
  if (actualMode !== mode) {
    throw insecurePermissionsError(targetPath, mode, actualMode, chmodError || undefined);
  }
  return stats;
}

export function ensurePrivateDirectory(directory) {
  let stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    stats = fs.lstatSync(directory);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw unsafePathError(directory, 'a directory');
  }
  assertCurrentOwner(stats, directory);
  stats = enforcePrivateMode(directory, 0o700);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw unsafePathError(directory, 'a directory');
  }
}

export function ensurePrivateFile(filePath, mode = 0o600, expectedIdentity = null) {
  let stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw unsafePathError(filePath, 'a regular file');
  }
  assertCurrentOwner(stats, filePath);
  if (expectedIdentity && !hasFileIdentity(stats, expectedIdentity)) {
    throw replacedPathError(filePath);
  }

  stats = enforcePrivateMode(filePath, mode);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw unsafePathError(filePath, 'a regular file');
  }
  if (expectedIdentity && !hasFileIdentity(stats, expectedIdentity)) {
    throw replacedPathError(filePath);
  }
}

function validateOpenedPrivateFile(descriptor, filePath, mode) {
  let stats = fs.fstatSync(descriptor);
  if (!stats.isFile()) throw unsafePathError(filePath, 'a regular file');
  assertCurrentOwner(stats, filePath);

  if (process.platform !== 'win32' && (stats.mode & 0o777) !== mode) {
    let chmodError = null;
    try {
      fs.fchmodSync(descriptor, mode);
    } catch (error) {
      chmodError = error;
    }
    stats = fs.fstatSync(descriptor);
    assertCurrentOwner(stats, filePath);
    const actualMode = stats.mode & 0o777;
    if (actualMode !== mode) {
      throw insecurePermissionsError(filePath, mode, actualMode, chmodError || undefined);
    }
  }

  const identity = fileIdentity(stats);
  const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !current
    || !current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, identity)
  ) {
    throw replacedPathError(filePath);
  }
  assertCurrentOwner(current, filePath);
  if (process.platform !== 'win32' && (current.mode & 0o777) !== mode) {
    throw insecurePermissionsError(filePath, mode, current.mode & 0o777);
  }
  return stats;
}

/**
 * Read a sensitive file through a no-follow descriptor bound to the validated
 * pathname and owner. Legacy owner-controlled permissions are hardened through
 * the descriptor before any bytes are returned.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {BufferEncoding|null} [opts.encoding=null]
 * @param {number} [opts.mode=0o600]
 * @returns {Buffer|string}
 */
export function readPrivateFile(filePath, opts = {}) {
  const { encoding = null, mode = 0o600 } = opts;
  let descriptor;
  let contents;
  let failure;

  try {
    descriptor = fs.openSync(filePath, PRIVATE_READ_FLAGS);
    const before = validateOpenedPrivateFile(descriptor, filePath, mode);
    contents = encoding === null
      ? fs.readFileSync(descriptor)
      : fs.readFileSync(descriptor, encoding);
    const after = validateOpenedPrivateFile(descriptor, filePath, mode);
    if (
      before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw changedFileError(filePath);
    }
  } catch (error) {
    failure = error.code === 'ELOOP'
      ? unsafePathError(filePath, 'a regular file')
      : error;
  }

  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (closeError) {
      if (failure) {
        Object.defineProperty(failure, 'cleanupError', {
          configurable: true,
          enumerable: false,
          writable: true,
          value: closeError,
        });
      } else {
        failure = closeError;
      }
    }
  }

  if (failure) throw failure;
  return contents;
}

function directorySyncIsUnsupported(error) {
  if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) return true;
  // Windows does not consistently expose readable directory descriptors.
  return process.platform === 'win32' && ['EISDIR', 'EPERM', 'EBADF'].includes(error?.code);
}

function syncDirectory(directory) {
  let directoryDescriptor;
  let operationError = null;
  let closeError = null;

  try {
    directoryDescriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(directoryDescriptor);
  } catch (error) {
    operationError = error;
  } finally {
    if (directoryDescriptor !== undefined) {
      try {
        fs.closeSync(directoryDescriptor);
      } catch (error) {
        closeError = error;
      }
    }
  }

  if (closeError) throw closeError;
  if (operationError && !directorySyncIsUnsupported(operationError)) throw operationError;
}

function fileIdentity(stats) {
  return { device: stats.dev, inode: stats.ino };
}

function hasFileIdentity(stats, identity) {
  return stats.dev === identity.device && stats.ino === identity.inode;
}

function cleanupFailure(operation, artifactPath, cause) {
  const error = new Error(
    `Failed to ${operation} sensitive JSON artifact: ${artifactPath}`,
    { cause },
  );
  error.code = 'EJSONCLEANUP';
  return error;
}

function cleanupResource(resource) {
  if (resource.kind === 'descriptor') {
    try {
      fs.closeSync(resource.descriptor);
    } catch (error) {
      if (error.code !== 'EBADF') throw error;
    }
    return;
  }

  const current = fs.lstatSync(resource.artifactPath, { throwIfNoEntry: false });
  if (!current) return;
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, resource.identity)
  ) {
    throw replacedPathError(resource.artifactPath);
  }
  assertCurrentOwner(current, resource.artifactPath);
  fs.unlinkSync(resource.artifactPath);
}

function attachJsonCleanupFailures(error, filePath, failures) {
  if (failures.length === 0) return;
  const existing = Array.isArray(error.cleanupFailures) ? error.cleanupFailures : [];
  Object.defineProperty(error, 'cleanupFailures', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: [...existing, ...failures],
  });
  Object.defineProperty(error, 'cleanupOutcome', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: {
      status: 'pending',
      destination: path.resolve(filePath),
      artifacts: failures.map(({ operation, artifactPath, error: failure }) => ({
        operation,
        path: artifactPath,
        code: failure.code,
      })),
    },
  });
}

function retainJsonCleanup(filePath, resource) {
  const key = path.resolve(filePath);
  const pending = PENDING_JSON_CLEANUPS.get(key) || [];
  pending.push(resource);
  PENDING_JSON_CLEANUPS.set(key, pending);
}

function attemptJsonCleanup(filePath, resource, failures) {
  const operation = resource.kind === 'descriptor' ? 'close' : 'remove';
  try {
    cleanupResource(resource);
    return true;
  } catch (cause) {
    const error = cleanupFailure(operation, resource.artifactPath, cause);
    failures.push({
      target: `sensitive-json:${resource.artifactPath}`,
      operation,
      artifactPath: resource.artifactPath,
      error,
    });
    return false;
  }
}

function drainPendingJsonCleanup(filePath) {
  const key = path.resolve(filePath);
  const pending = PENDING_JSON_CLEANUPS.get(key);
  if (!pending || pending.length === 0) return;

  const failures = [];
  const remaining = [];
  for (const resource of pending) {
    if (!attemptJsonCleanup(filePath, resource, failures)) remaining.push(resource);
  }

  if (remaining.length === 0) PENDING_JSON_CLEANUPS.delete(key);
  else PENDING_JSON_CLEANUPS.set(key, remaining);
  if (failures.length > 0) {
    const error = new Error(`Sensitive JSON cleanup is incomplete for: ${filePath}`);
    error.code = 'EJSONCLEANUP';
    attachJsonCleanupFailures(error, filePath, failures);
    throw error;
  }
}

function rollbackPublishedWrite(filePath, previousContents, replacementIdentity, mode) {
  const directory = path.dirname(filePath);
  const rollbackPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.rollback`,
  );
  let rollbackDescriptor;
  let rollbackIdentity;
  let rollbackTempExists = false;
  let destination = 'replacement';
  const cleanupFailures = [];
  const cleanupResources = [];

  try {
    const current = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      current
      && (
        !current.isFile()
        || current.isSymbolicLink()
        || !hasFileIdentity(current, replacementIdentity)
      )
    ) {
      const error = new Error(
        `Atomic JSON rollback refused to replace an unowned destination: ${filePath}`,
      );
      error.code = 'EROLLBACKOWNERSHIP';
      throw error;
    }

    if (previousContents !== null) {
      rollbackDescriptor = fs.openSync(rollbackPath, 'wx', mode);
      rollbackTempExists = true;
      const rollbackStats = fs.fstatSync(rollbackDescriptor);
      rollbackIdentity = fileIdentity(rollbackStats);
      if (!rollbackStats.isFile()) {
        throw unsafePathError(rollbackPath, 'a regular file');
      }
      assertCurrentOwner(rollbackStats, rollbackPath);
      fs.writeFileSync(rollbackDescriptor, previousContents);
      fs.fsyncSync(rollbackDescriptor);
      fs.closeSync(rollbackDescriptor);
      rollbackDescriptor = undefined;
      ensurePrivateFile(rollbackPath, mode, rollbackIdentity);
      fs.renameSync(rollbackPath, filePath);
      rollbackTempExists = false;
      destination = 'restored';
      ensurePrivateFile(filePath, mode, rollbackIdentity);
    } else {
      if (current) fs.unlinkSync(filePath);
      destination = 'absent';
    }

    syncDirectory(directory);
    return {
      status: 'succeeded',
      destination,
      cleanupFailures,
      cleanupResources,
    };
  } catch (error) {
    if (rollbackDescriptor !== undefined) {
      const resource = {
        kind: 'descriptor',
        descriptor: rollbackDescriptor,
        artifactPath: rollbackPath,
      };
      if (!attemptJsonCleanup(filePath, resource, cleanupFailures)) {
        cleanupResources.push(resource);
      }
    }
    if (rollbackTempExists && rollbackIdentity) {
      const resource = {
        kind: 'path',
        artifactPath: rollbackPath,
        identity: rollbackIdentity,
      };
      if (!attemptJsonCleanup(filePath, resource, cleanupFailures)) {
        cleanupResources.push(resource);
      }
    }
    return {
      status: 'failed',
      destination,
      error,
      cleanupFailures,
      cleanupResources,
    };
  }
}

function attachCommitOutcome(error, previousContents, rollback) {
  const rollbackDetails = {
    status: rollback.status,
    destination: rollback.destination,
  };
  if (rollback.error) {
    rollbackDetails.error = {
      name: rollback.error.name,
      code: rollback.error.code,
      message: rollback.error.message,
    };
    error.rollbackError = rollback.error;
  }
  rollbackDetails.cleanup = rollback.cleanupFailures.length > 0
    ? { status: 'pending', artifacts: rollback.cleanupFailures.length }
    : { status: 'complete', artifacts: 0 };

  error.commitOutcome = {
    status: rollback.status === 'succeeded' ? 'rolled-back' : 'uncertain',
    replacement: 'published',
    previousDestination: previousContents === null ? 'absent' : 'present',
    rollback: rollbackDetails,
  };
}

/**
 * Atomically write sensitive JSON data with owner-only permissions.
 *
 * The temporary file is created in the destination directory so publication
 * remains atomic on the same filesystem. Failures before publication leave the
 * destination unchanged. Post-publication validation or directory-sync failures
 * trigger an atomic rollback to the prior bytes (or prior absence) and still
 * throw; an uncertain rollback is described on error.commitOutcome.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {object} [opts]
 * @param {number} [opts.mode=0o600]
 */
export function writeJsonAtomic(filePath, value, opts = {}) {
  const { mode = 0o600 } = opts;
  const directory = path.dirname(filePath);
  drainPendingJsonCleanup(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  ensurePrivateDirectory(directory);
  let previousContents = null;
  try {
    previousContents = readPrivateFile(filePath, { mode });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let fileDescriptor;
  let replacementIdentity;
  let published = false;
  try {
    fileDescriptor = fs.openSync(tempPath, 'wx', mode);
    const replacementStats = fs.fstatSync(fileDescriptor);
    replacementIdentity = fileIdentity(replacementStats);
    if (!replacementStats.isFile()) {
      throw unsafePathError(tempPath, 'a regular file');
    }
    assertCurrentOwner(replacementStats, tempPath);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    ensurePrivateFile(tempPath, mode, replacementIdentity);
    fs.renameSync(tempPath, filePath);
    published = true;
    ensurePrivateFile(filePath, mode, replacementIdentity);
    syncDirectory(directory);
  } catch (error) {
    const cleanupFailures = [];
    const cleanupResources = [];

    if (fileDescriptor !== undefined) {
      const resource = {
        kind: 'descriptor',
        descriptor: fileDescriptor,
        artifactPath: tempPath,
      };
      if (!attemptJsonCleanup(filePath, resource, cleanupFailures)) {
        cleanupResources.push(resource);
      }
    }
    if (published) {
      const rollback = rollbackPublishedWrite(
        filePath,
        previousContents,
        replacementIdentity,
        mode,
      );
      attachCommitOutcome(error, previousContents, rollback);
      cleanupFailures.push(...rollback.cleanupFailures);
      cleanupResources.push(...rollback.cleanupResources);
    }
    if (replacementIdentity) {
      const resource = {
        kind: 'path',
        artifactPath: tempPath,
        identity: replacementIdentity,
      };
      if (!attemptJsonCleanup(filePath, resource, cleanupFailures)) {
        cleanupResources.push(resource);
      }
    }

    for (const resource of cleanupResources) retainJsonCleanup(filePath, resource);
    attachJsonCleanupFailures(error, filePath, cleanupFailures);
    throw error;
  }
}

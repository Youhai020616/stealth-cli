import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function unsafePathError(targetPath, expectedType) {
  const error = new Error(
    `Sensitive state path must be ${expectedType} and must not be a symbolic link: ${targetPath}`,
  );
  error.code = 'EUNSAFESTATEPATH';
  return error;
}

function enforcePrivateMode(targetPath, mode) {
  if (process.platform === 'win32') return;

  let chmodError = null;
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    chmodError = error;
  }

  const actualMode = fs.lstatSync(targetPath).mode & 0o777;
  if (actualMode !== mode) {
    const error = new Error(
      `Sensitive state path has insecure permissions: ${targetPath} (${actualMode.toString(8)})`,
      { cause: chmodError || undefined },
    );
    error.code = 'EINSECUREPERMISSIONS';
    throw error;
  }
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
  enforcePrivateMode(directory, 0o700);
}

export function ensurePrivateFile(filePath, mode = 0o600) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw unsafePathError(filePath, 'a regular file');
  }
  enforcePrivateMode(filePath, mode);
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

function rollbackPublishedWrite(filePath, previousContents, replacementIdentity, mode) {
  const directory = path.dirname(filePath);
  const rollbackPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.rollback`,
  );
  let rollbackDescriptor;
  let rollbackTempExists = false;
  let destination = 'replacement';

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
      if (!fs.fstatSync(rollbackDescriptor).isFile()) {
        throw unsafePathError(rollbackPath, 'a regular file');
      }
      fs.writeFileSync(rollbackDescriptor, previousContents);
      fs.fsyncSync(rollbackDescriptor);
      const closingDescriptor = rollbackDescriptor;
      rollbackDescriptor = undefined;
      fs.closeSync(closingDescriptor);
      ensurePrivateFile(rollbackPath, mode);
      fs.renameSync(rollbackPath, filePath);
      rollbackTempExists = false;
      destination = 'restored';
      ensurePrivateFile(filePath, mode);
    } else {
      if (current) fs.unlinkSync(filePath);
      destination = 'absent';
    }

    syncDirectory(directory);
    return { status: 'succeeded', destination };
  } catch (error) {
    if (rollbackDescriptor !== undefined) {
      try {
        fs.closeSync(rollbackDescriptor);
      } catch {}
    }
    if (rollbackTempExists) {
      try {
        fs.unlinkSync(rollbackPath);
      } catch {}
    }
    return { status: 'failed', destination, error };
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
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  ensurePrivateDirectory(directory);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) ensurePrivateFile(filePath, mode);
  const previousContents = existing ? fs.readFileSync(filePath) : null;

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
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    ensurePrivateFile(tempPath, mode);
    fs.renameSync(tempPath, filePath);
    published = true;
    ensurePrivateFile(filePath, mode);
    syncDirectory(directory);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {}
    }
    if (published) {
      const rollback = rollbackPublishedWrite(
        filePath,
        previousContents,
        replacementIdentity,
        mode,
      );
      attachCommitOutcome(error, previousContents, rollback);
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

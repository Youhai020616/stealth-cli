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

/**
 * Atomically write sensitive JSON data with owner-only permissions.
 *
 * The temporary file is created in the destination directory so rename remains
 * atomic on the same filesystem. The previous file is left intact if writing
 * or syncing the replacement fails.
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

  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(tempPath, 'wx', mode);
    if (!fs.fstatSync(fileDescriptor).isFile()) {
      throw unsafePathError(tempPath, 'a regular file');
    }
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    ensurePrivateFile(tempPath, mode);
    fs.renameSync(tempPath, filePath);
    ensurePrivateFile(filePath, mode);
    syncDirectory(directory);
  } catch (error) {
    if (fileDescriptor !== undefined) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

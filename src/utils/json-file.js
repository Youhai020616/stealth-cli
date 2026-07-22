import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function enforcePrivateMode(targetPath, mode) {
  if (process.platform === 'win32') return;

  let chmodError = null;
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    chmodError = error;
  }

  const actualMode = fs.statSync(targetPath).mode & 0o777;
  if ((actualMode & 0o077) !== 0) {
    const error = new Error(
      `Sensitive state path has insecure permissions: ${targetPath} (${actualMode.toString(8)})`,
      { cause: chmodError || undefined },
    );
    error.code = 'EINSECUREPERMISSIONS';
    throw error;
  }
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  enforcePrivateMode(directory, 0o700);
}

export function ensurePrivateFile(filePath, mode = 0o600) {
  enforcePrivateMode(filePath, mode);
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

  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    ensurePrivateFile(tempPath, mode);
    fs.renameSync(tempPath, filePath);

    // Best-effort directory sync makes the rename durable across sudden power
    // loss on filesystems that support syncing directory descriptors.
    let directoryDescriptor;
    try {
      directoryDescriptor = fs.openSync(directory, 'r');
      fs.fsyncSync(directoryDescriptor);
    } catch {
      // Directory fsync is not available on every platform/filesystem.
    } finally {
      if (directoryDescriptor !== undefined) {
        try {
          fs.closeSync(directoryDescriptor);
        } catch {}
      }
    }
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

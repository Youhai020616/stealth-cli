import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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

  fs.mkdirSync(directory, { recursive: true });

  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;

    fs.renameSync(tempPath, filePath);

    // Existing files may have been created before owner-only permissions were
    // enforced. Best effort is sufficient on platforms without POSIX modes.
    try {
      fs.chmodSync(filePath, mode);
    } catch {}

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

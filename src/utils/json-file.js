import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { attachJsonCleanupDetails } from '../errors.js';

const PENDING_JSON_CLEANUPS = new Map();
const PRIVATE_READ_FLAGS = (
  fs.constants.O_RDONLY
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_NONBLOCK || 0)
  | (fs.constants.O_CLOEXEC || 0)
);

function defineHidden(target, property, value) {
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}

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

function unsafeAncestorError(targetPath, reason) {
  const error = new Error(`Sensitive state path has an unsafe ancestor: ${targetPath} (${reason})`);
  error.code = 'EUNSAFESTATEPATH';
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

function missingParentError(targetPath) {
  const error = new Error(`Sensitive state parent directory does not exist: ${targetPath}`);
  error.code = 'ENOENT';
  return error;
}

function assertCurrentOwner(stats, targetPath) {
  if (process.platform === 'win32') return;
  const userId = currentUserId();
  if (userId !== null && stats.uid !== userId) {
    throw wrongOwnerError(targetPath, userId, stats.uid);
  }
}

const MAX_ANCESTOR_SYMLINKS = 40;

function splitAbsolutePath(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  return {
    root,
    components: resolved.slice(root.length).split(path.sep).filter(Boolean),
  };
}

function assertTrustedDirectoryEntry(stats, current, userId) {
  if (!stats.isDirectory()) {
    throw unsafeAncestorError(current, 'ancestor is not a directory');
  }
  if (userId !== null && stats.uid !== userId && stats.uid !== 0) {
    throw unsafeAncestorError(current, `ancestor is controlled by uid ${stats.uid}`);
  }
  if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
    throw unsafeAncestorError(current, 'ancestor is writable by another user');
  }
}

function assertTrustedDirectoryPath(directory) {
  const userId = currentUserId();
  let { root, components } = splitAbsolutePath(directory);
  let current = root;
  let symlinkCount = 0;
  assertTrustedDirectoryEntry(fs.lstatSync(current), current, userId);

  while (components.length > 0) {
    const component = components.shift();
    const candidate = path.join(current, component);
    const stats = fs.lstatSync(candidate);
    if (!stats.isSymbolicLink()) {
      assertTrustedDirectoryEntry(stats, candidate, userId);
      current = candidate;
      continue;
    }

    if (stats.uid !== 0) {
      throw unsafeAncestorError(candidate, 'symbolic links must be system-owned');
    }
    symlinkCount += 1;
    if (symlinkCount > MAX_ANCESTOR_SYMLINKS) {
      throw unsafeAncestorError(candidate, 'too many symbolic-link hops');
    }

    const linkTarget = fs.readlinkSync(candidate, 'utf8');
    const expandedTarget = path.isAbsolute(linkTarget)
      ? path.resolve(linkTarget)
      : path.resolve(path.dirname(candidate), linkTarget);
    const expandedPath = path.join(expandedTarget, ...components);
    ({ root, components } = splitAbsolutePath(expandedPath));
    current = root;
    assertTrustedDirectoryEntry(fs.lstatSync(current), current, userId);
  }
}

/**
 * Bind path-based operations to an ancestor chain that another OS user cannot
 * redirect. Every symlink hop is inspected with lstat/readlink; system-owned
 * aliases are accepted only when every expanded target component is trusted.
 * Hostile code running as this same uid remains outside the storage boundary.
 */
function assertSafeDirectoryAncestors(targetPath, opts = {}) {
  if (process.platform === 'win32') return;

  const parentPath = path.dirname(path.resolve(targetPath));
  let existing = parentPath;
  let stats = fs.lstatSync(existing, { throwIfNoEntry: false });
  if (!stats && opts.requireParent) throw missingParentError(parentPath);

  while (!stats) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
    stats = fs.lstatSync(existing, { throwIfNoEntry: false });
  }

  assertTrustedDirectoryPath(existing);
}

function missingDirectoryComponents(directory) {
  const resolved = path.resolve(directory);
  const missing = [];
  let existing = resolved;
  let stats = fs.lstatSync(existing, { throwIfNoEntry: false });

  while (!stats) {
    missing.unshift(existing);
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
    stats = fs.lstatSync(existing, { throwIfNoEntry: false });
  }

  if (process.platform !== 'win32') {
    assertTrustedDirectoryPath(missing.length > 0 ? existing : path.dirname(resolved));
  }
  return missing;
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
  const missing = missingDirectoryComponents(directory);
  for (const component of missing) {
    try {
      fs.mkdirSync(component, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const created = fs.lstatSync(component);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw unsafePathError(component, 'a directory');
    }
    assertCurrentOwner(created, component);
    enforcePrivateMode(component, 0o700);
  }

  let stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw unsafePathError(directory, 'a directory');
  }
  assertCurrentOwner(stats, directory);
  stats = enforcePrivateMode(directory, 0o700);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw unsafePathError(directory, 'a directory');
  }
  assertSafeDirectoryAncestors(directory, { requireParent: true });
}

export function ensurePrivateFile(filePath, mode = 0o600, expectedIdentity = null) {
  assertSafeDirectoryAncestors(filePath, { requireParent: true });
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
  assertSafeDirectoryAncestors(filePath, { requireParent: true });
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

function closeJsonDescriptorResource(resource) {
  if (resource.descriptorOpen === false) return;

  if (resource.identity) {
    let stats;
    try {
      stats = fs.fstatSync(resource.descriptor);
    } catch (error) {
      if (error.code === 'EBADF') {
        resource.descriptorOpen = false;
        return;
      }
      throw error;
    }
    if (!hasFileIdentity(stats, resource.identity)) {
      const error = new Error(
        `Sensitive JSON descriptor was reused before cleanup completed: ${resource.artifactPath}`,
      );
      error.code = 'ESTATEDESCRIPTORREUSED';
      throw error;
    }
  }

  const descriptor = resource.descriptor;
  try {
    fs.closeSync(descriptor);
    resource.descriptorOpen = false;
    resource.descriptor = undefined;
  } catch (error) {
    resource.descriptorOpen = false;
    resource.descriptor = undefined;
    if (error.code === 'EBADF') return;

    // close(2) may release the descriptor even while reporting an error. A
    // later open can reuse both this number and this persistent artifact inode,
    // so no identity check can authorize retrying the numeric descriptor.
    resource.retryable = false;
    throw error;
  }
}

function assertOwnedJsonArtifact(resource) {
  const current = fs.lstatSync(resource.artifactPath, { throwIfNoEntry: false });
  if (
    !current
    || !current.isFile()
    || current.isSymbolicLink()
    || !hasFileIdentity(current, resource.identity)
  ) {
    throw replacedPathError(resource.artifactPath);
  }
  assertCurrentOwner(current, resource.artifactPath);
  if (process.platform !== 'win32' && (current.mode & 0o777) !== resource.mode) {
    throw insecurePermissionsError(
      resource.artifactPath,
      resource.mode,
      current.mode & 0o777,
    );
  }
  return current;
}

function cleanupResource(resource) {
  if (resource.kind === 'descriptor') {
    closeJsonDescriptorResource(resource);
    return;
  }

  if (resource.kind === 'claim') {
    if (process.platform === 'win32') closeJsonDescriptorResource(resource);
    if (resource.pathLinked !== false) {
      assertOwnedJsonArtifact(resource);
      fs.unlinkSync(resource.artifactPath);
      resource.pathLinked = false;
      resource.removalSyncPending = true;
    }
    if (resource.removalSyncPending) {
      syncDirectory(resource.directory);
      resource.removalSyncPending = false;
    }
    if (process.platform !== 'win32') closeJsonDescriptorResource(resource);
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
  defineHidden(error, 'cleanupFailures', [...existing, ...failures]);
  attachJsonCleanupDetails(error, {
    status: 'pending',
    destination: path.resolve(filePath),
    artifacts: failures.map(({ operation, artifactPath, error: failure }) => ({
      operation,
      path: path.resolve(artifactPath),
      code: failure.code,
    })),
  });
}

function retainJsonCleanup(filePath, resource) {
  if (resource.retryable === false) return;
  const key = path.resolve(filePath);
  const pending = PENDING_JSON_CLEANUPS.get(key) || [];
  pending.push(resource);
  PENDING_JSON_CLEANUPS.set(key, pending);
}

function attemptJsonCleanup(filePath, resource, failures) {
  const operation = resource.kind === 'descriptor'
    ? 'close'
    : resource.kind === 'claim' ? 'release' : 'remove';
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
    if (resource.kind === 'claim' && remaining.length > 0) {
      remaining.push(resource);
      continue;
    }
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

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function jsonArtifactPath(filePath, suffix) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.${suffix}`,
  );
}

function durableJsonArtifactPattern(filePath) {
  const basename = escapeRegularExpression(path.basename(filePath));
  return new RegExp(
    `^\\.${basename}\\.\\d+\\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\.(?:claim|tmp|rollback)$`,
    'u',
  );
}

function assertOwnJsonClaim(claim) {
  if (claim.descriptorOpen === false || claim.pathLinked === false) {
    throw replacedPathError(claim.artifactPath);
  }
  const descriptorStats = fs.fstatSync(claim.descriptor);
  if (
    !descriptorStats.isFile()
    || !hasFileIdentity(descriptorStats, claim.identity)
  ) {
    throw replacedPathError(claim.artifactPath);
  }
  assertCurrentOwner(descriptorStats, claim.artifactPath);
  assertOwnedJsonArtifact(claim);
}

function acquireJsonWriteClaim(filePath, mode) {
  const directory = path.dirname(filePath);
  const claimPath = jsonArtifactPath(filePath, 'claim');
  let descriptor;
  let claim;
  const cleanupFailures = [];
  const cleanupResources = [];

  try {
    descriptor = fs.openSync(claimPath, 'wx', mode);
    let stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) throw unsafePathError(claimPath, 'a regular file');
    assertCurrentOwner(stats, claimPath);
    if (process.platform !== 'win32' && (stats.mode & 0o777) !== mode) {
      fs.fchmodSync(descriptor, mode);
      stats = fs.fstatSync(descriptor);
      assertCurrentOwner(stats, claimPath);
      if ((stats.mode & 0o777) !== mode) {
        throw insecurePermissionsError(claimPath, mode, stats.mode & 0o777);
      }
    }
    const identity = fileIdentity(stats);
    claim = {
      kind: 'claim',
      descriptor,
      descriptorOpen: true,
      pathLinked: true,
      removalSyncPending: false,
      artifactPath: claimPath,
      directory,
      identity,
      mode,
    };
    fs.writeFileSync(descriptor, `${JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    assertOwnJsonClaim(claim);
    syncDirectory(directory);
    return claim;
  } catch (error) {
    if (claim) {
      if (!attemptJsonCleanup(filePath, claim, cleanupFailures)) {
        cleanupResources.push(claim);
      }
    } else if (descriptor !== undefined) {
      const resource = {
        kind: 'descriptor',
        descriptor,
        descriptorOpen: true,
        artifactPath: claimPath,
      };
      if (!attemptJsonCleanup(filePath, resource, cleanupFailures)) {
        cleanupResources.push(resource);
      }
      const inspectionError = cleanupFailure(
        'verify',
        claimPath,
        new Error('The write claim identity could not be established'),
      );
      cleanupFailures.push({
        target: `sensitive-json:${claimPath}`,
        operation: 'inspect',
        artifactPath: claimPath,
        error: inspectionError,
      });
    }

    for (const resource of cleanupResources) retainJsonCleanup(filePath, resource);
    attachJsonCleanupFailures(error, filePath, cleanupFailures);
    throw error;
  }
}

function assertNoDurableJsonArtifacts(filePath, mode, claim) {
  assertOwnJsonClaim(claim);
  const directory = path.dirname(filePath);
  const pattern = durableJsonArtifactPattern(filePath);
  const artifactNames = fs.readdirSync(directory)
    .filter((name) => pattern.test(name))
    .sort();
  const ownClaimName = path.basename(claim.artifactPath);
  const findings = [];
  let ownClaimObserved = false;

  for (const name of artifactNames) {
    const artifactPath = path.join(directory, name);
    if (name === ownClaimName) {
      ownClaimObserved = true;
      continue;
    }

    let validationError = null;
    try {
      const stats = fs.lstatSync(artifactPath, { throwIfNoEntry: false });
      if (!stats) continue;
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw unsafePathError(artifactPath, 'a regular file');
      }
      assertCurrentOwner(stats, artifactPath);
      if (process.platform !== 'win32' && (stats.mode & 0o777) !== mode) {
        throw insecurePermissionsError(artifactPath, mode, stats.mode & 0o777);
      }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      validationError = error;
    }
    findings.push({ artifactPath, validationError });
  }

  if (!ownClaimObserved) {
    findings.push({
      artifactPath: claim.artifactPath,
      validationError: replacedPathError(claim.artifactPath),
    });
  }
  if (findings.length === 0) return;

  const artifactPaths = findings.map(({ artifactPath }) => path.resolve(artifactPath));
  const error = new Error(
    `Sensitive JSON cleanup is incomplete; inspect these exact owner-only artifacts before retrying: ${artifactPaths.join(', ')}`,
  );
  error.code = 'EJSONCLEANUP';
  attachJsonCleanupDetails(
    error,
    {
      status: 'pending',
      destination: path.resolve(filePath),
      artifacts: findings.map(({ artifactPath, validationError }) => ({
        operation: 'inspect',
        path: path.resolve(artifactPath),
        code: validationError?.code || 'EJSONARTIFACTPENDING',
      })),
    },
    findings
      .filter(({ validationError }) => validationError)
      .map(({ artifactPath, validationError }) => ({
        path: path.resolve(artifactPath),
        error: validationError,
      })),
  );
  throw error;
}

function rollbackPublishedWrite(
  filePath,
  previousContents,
  replacementIdentity,
  mode,
  claim,
) {
  const directory = path.dirname(filePath);
  const rollbackPath = jsonArtifactPath(filePath, 'rollback');
  let rollbackDescriptorResource;
  let rollbackIdentity;
  let rollbackTempExists = false;
  let destination = 'replacement';
  const cleanupFailures = [];
  const cleanupResources = [];

  try {
    assertOwnJsonClaim(claim);
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
      const rollbackDescriptor = fs.openSync(rollbackPath, 'wx', mode);
      rollbackDescriptorResource = {
        kind: 'descriptor',
        descriptor: rollbackDescriptor,
        descriptorOpen: true,
        identity: null,
        artifactPath: rollbackPath,
      };
      rollbackTempExists = true;
      const rollbackStats = fs.fstatSync(rollbackDescriptor);
      rollbackIdentity = fileIdentity(rollbackStats);
      rollbackDescriptorResource.identity = rollbackIdentity;
      if (!rollbackStats.isFile()) {
        throw unsafePathError(rollbackPath, 'a regular file');
      }
      assertCurrentOwner(rollbackStats, rollbackPath);
      fs.writeFileSync(rollbackDescriptor, previousContents);
      fs.fsyncSync(rollbackDescriptor);
      closeJsonDescriptorResource(rollbackDescriptorResource);
      ensurePrivateFile(rollbackPath, mode, rollbackIdentity);
      assertOwnJsonClaim(claim);
      fs.renameSync(rollbackPath, filePath);
      rollbackTempExists = false;
      destination = 'restored';
      ensurePrivateFile(filePath, mode, rollbackIdentity);
    } else {
      assertOwnJsonClaim(claim);
      if (current) fs.unlinkSync(filePath);
      destination = 'absent';
    }

    syncDirectory(directory);
    assertOwnJsonClaim(claim);
    return {
      status: 'succeeded',
      destination,
      cleanupFailures,
      cleanupResources,
    };
  } catch (error) {
    if (rollbackDescriptorResource && rollbackDescriptorResource.descriptorOpen !== false) {
      if (!attemptJsonCleanup(filePath, rollbackDescriptorResource, cleanupFailures)) {
        cleanupResources.push(rollbackDescriptorResource);
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
    defineHidden(error, 'rollbackError', rollback.error);
  }
  rollbackDetails.cleanup = rollback.cleanupFailures.length > 0
    ? { status: 'pending', artifacts: rollback.cleanupFailures.length }
    : { status: 'complete', artifacts: 0 };

  defineHidden(error, 'commitOutcome', {
    status: rollback.status === 'succeeded' ? 'rolled-back' : 'uncertain',
    replacement: 'published',
    previousDestination: previousContents === null ? 'absent' : 'present',
    rollback: rollbackDetails,
  });
}

function preserveJsonClaimForRecovery(filePath, claim, error) {
  const failures = [];
  const descriptorResource = {
    kind: 'descriptor',
    descriptor: claim.descriptor,
    descriptorOpen: claim.descriptorOpen,
    identity: claim.identity,
    artifactPath: claim.artifactPath,
  };
  if (!attemptJsonCleanup(filePath, descriptorResource, failures)) {
    retainJsonCleanup(filePath, descriptorResource);
  }
  const inspectionError = cleanupFailure(
    'verify',
    claim.artifactPath,
    new Error('The atomic write outcome is uncertain and requires manual inspection'),
  );
  failures.push({
    target: `sensitive-json:${claim.artifactPath}`,
    operation: 'inspect',
    artifactPath: claim.artifactPath,
    error: inspectionError,
  });
  attachJsonCleanupFailures(error, filePath, failures);
  return error;
}

function releaseJsonWriteClaim(filePath, claim, operationError, committed) {
  const failures = [];
  const released = attemptJsonCleanup(filePath, claim, failures);
  if (!released) retainJsonCleanup(filePath, claim);

  if (failures.length === 0) return operationError;

  const error = operationError || new Error(
    committed
      ? 'Sensitive JSON was committed, but write-claim cleanup is incomplete'
      : 'Sensitive JSON write-claim cleanup is incomplete',
  );
  if (!operationError) error.code = 'EJSONCLEANUP';
  if (committed && !error.commitOutcome) {
    defineHidden(error, 'commitOutcome', {
      status: 'committed',
      replacement: 'published',
      cleanup: { status: 'pending' },
    });
  }
  attachJsonCleanupFailures(error, filePath, failures);
  return error;
}

function readClaimedJsonSnapshot(transaction) {
  assertOwnJsonClaim(transaction.claim);
  try {
    transaction.previousContents = readPrivateFile(transaction.filePath, {
      mode: transaction.mode,
    });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    transaction.previousContents = null;
  }
  assertOwnJsonClaim(transaction.claim);
}

function publishClaimedJson(transaction, value) {
  const {
    filePath,
    directory,
    mode,
    claim,
    previousContents,
  } = transaction;
  const tempPath = jsonArtifactPath(filePath, 'tmp');
  let descriptorResource;
  let replacementIdentity;
  let published = false;

  try {
    const fileDescriptor = fs.openSync(tempPath, 'wx', mode);
    descriptorResource = {
      kind: 'descriptor',
      descriptor: fileDescriptor,
      descriptorOpen: true,
      identity: null,
      artifactPath: tempPath,
    };
    const replacementStats = fs.fstatSync(fileDescriptor);
    replacementIdentity = fileIdentity(replacementStats);
    descriptorResource.identity = replacementIdentity;
    if (!replacementStats.isFile()) {
      throw unsafePathError(tempPath, 'a regular file');
    }
    assertCurrentOwner(replacementStats, tempPath);
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileDescriptor);
    closeJsonDescriptorResource(descriptorResource);

    ensurePrivateFile(tempPath, mode, replacementIdentity);
    assertOwnJsonClaim(claim);
    fs.renameSync(tempPath, filePath);
    published = true;
    ensurePrivateFile(filePath, mode, replacementIdentity);
    syncDirectory(directory);
    assertOwnJsonClaim(claim);
    transaction.committed = true;
  } catch (error) {
    const cleanupFailures = [];
    const cleanupResources = [];

    if (descriptorResource && descriptorResource.descriptorOpen !== false) {
      if (!attemptJsonCleanup(filePath, descriptorResource, cleanupFailures)) {
        cleanupResources.push(descriptorResource);
      }
    }
    if (published) {
      const rollback = rollbackPublishedWrite(
        filePath,
        previousContents,
        replacementIdentity,
        mode,
        claim,
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

function withClaimedJsonWrite(filePath, opts, operation) {
  const { mode = 0o600 } = opts;
  const directory = path.dirname(filePath);
  drainPendingJsonCleanup(filePath);
  ensurePrivateDirectory(directory);
  const claim = acquireJsonWriteClaim(filePath, mode);
  const transaction = {
    filePath,
    directory,
    mode,
    claim,
    previousContents: null,
    committed: false,
  };
  let operationError = null;
  let result;

  try {
    assertNoDurableJsonArtifacts(filePath, mode, claim);
    readClaimedJsonSnapshot(transaction);
    result = operation(transaction);
  } catch (error) {
    operationError = error;
  }

  if (operationError?.commitOutcome?.status === 'uncertain') {
    throw preserveJsonClaimForRecovery(filePath, claim, operationError);
  }

  operationError = releaseJsonWriteClaim(
    filePath,
    claim,
    operationError,
    transaction.committed,
  );
  if (operationError) throw operationError;
  return result;
}

function synchronousCallbackResult(value, label) {
  if (value && typeof value.then === 'function') {
    throw new TypeError(`${label} must be synchronous`);
  }
  return value;
}

/**
 * Atomically write sensitive JSON data with owner-only permissions.
 *
 * The durable claim is held from pre-read admission through publication,
 * rollback, directory sync, and claim cleanup.
 */
export function writeJsonAtomic(filePath, value, opts = {}) {
  withClaimedJsonWrite(filePath, opts, (transaction) => {
    publishClaimedJson(transaction, value);
  });
}

/**
 * Perform a synchronous logical read-modify-write while holding the same
 * durable destination claim used for atomic publication.
 *
 * Returning undefined from updater releases the claim without publishing.
 */
export function updateJsonAtomic(filePath, updater, opts = {}) {
  if (typeof updater !== 'function') {
    throw new TypeError('Atomic JSON updater must be a function');
  }
  const parse = opts.parse || JSON.parse;
  const validate = opts.validate || ((value) => value);
  const createDefault = opts.createDefault || (() => undefined);
  for (const [label, callback] of [
    ['Atomic JSON parser', parse],
    ['Atomic JSON validator', validate],
    ['Atomic JSON default factory', createDefault],
  ]) {
    if (typeof callback !== 'function') throw new TypeError(`${label} must be a function`);
  }

  return withClaimedJsonWrite(filePath, opts, (transaction) => {
    const parsed = transaction.previousContents === null
      ? synchronousCallbackResult(createDefault(), 'Atomic JSON default factory')
      : synchronousCallbackResult(
        parse(transaction.previousContents.toString('utf8')),
        'Atomic JSON parser',
      );
    const validatedCurrent = synchronousCallbackResult(
      validate(parsed),
      'Atomic JSON validator',
    );
    const current = validatedCurrent === undefined ? parsed : validatedCurrent;
    const next = synchronousCallbackResult(updater(current), 'Atomic JSON updater');
    if (next === undefined) return undefined;

    const validatedNext = synchronousCallbackResult(
      validate(next),
      'Atomic JSON validator',
    );
    const replacement = validatedNext === undefined ? next : validatedNext;
    publishClaimedJson(transaction, replacement);
    return replacement;
  });
}

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TextDecoder } from 'util';
import { attachCleanupFailures, ProfileError } from '../errors.js';
import { ensurePrivateDirectory } from './json-file.js';
import { assertStateName, getStealthHome } from './storage-paths.js';

const STATE_KINDS = new Set(['profile', 'session']);
const TOKEN_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const STATE_LEASE_RECORDS = new WeakMap();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

// Journals are deliberately never compacted or replaced: doing so would
// reintroduce pathname-delete ABA. Fail closed and require explicit operator
// maintenance instead of parsing an attacker- or accident-controlled size.
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const READ_OPEN_FLAGS = (
  fs.constants.O_RDONLY
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_CLOEXEC || 0)
  | (fs.constants.O_NONBLOCK || 0)
);
const APPEND_OPEN_FLAGS = (
  fs.constants.O_RDWR
  | fs.constants.O_APPEND
  | (fs.constants.O_NOFOLLOW || 0)
  | (fs.constants.O_CLOEXEC || 0)
);
const CREATE_OPEN_FLAGS = (
  APPEND_OPEN_FLAGS
  | fs.constants.O_CREAT
  | fs.constants.O_EXCL
);

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

function manualRemovalHint(journalPath) {
  return `After confirming no stealth process is using this state, remove this exact lock journal file: ${journalPath}`;
}

function maintenanceHint(journalPath) {
  return `After confirming no stealth process is using this state, archive or remove this exact lock journal file before retrying: ${journalPath}`;
}

function unsafePathError(targetPath) {
  const error = new Error(
    `State lock journal must be a regular file and must not be a symbolic link: ${targetPath}`,
  );
  error.code = 'EUNSAFESTATEPATH';
  return error;
}

function insecurePermissionsError(targetPath, expectedMode, actualMode) {
  const error = new Error(
    `State lock journal must have mode ${expectedMode.toString(8)}: ${targetPath} (${actualMode.toString(8)})`,
  );
  error.code = 'EINSECUREPERMISSIONS';
  return error;
}

function wrongOwnerError(targetPath, expectedUserId, actualUserId) {
  const error = new Error(
    `State lock journal must be owned by uid ${expectedUserId}: ${targetPath} (uid ${actualUserId})`,
  );
  error.code = 'EINVALIDSTATELOCKOWNER';
  return error;
}

function invalidJournalError(message) {
  const error = new Error(message);
  error.code = 'EINVALIDSTATELOCK';
  return error;
}

function replacedJournalError(journalPath) {
  const error = new Error(`State lock journal path was replaced: ${journalPath}`);
  error.code = 'ESTATELOCKREPLACED';
  return error;
}

function assertPrivateFile(stats, journalPath) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw unsafePathError(journalPath);
  }

  if (process.platform !== 'win32') {
    const actualMode = stats.mode & 0o777;
    if (actualMode !== 0o600) {
      throw insecurePermissionsError(journalPath, 0o600, actualMode);
    }

    const userId = currentUserId();
    if (userId !== null && stats.uid !== userId) {
      throw wrongOwnerError(journalPath, userId, stats.uid);
    }
  }
}

function nodeIdentity(stats) {
  return Object.freeze({ device: stats.dev, inode: stats.ino });
}

function hasNodeIdentity(stats, identity) {
  return stats.dev === identity.device && stats.ino === identity.inode;
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
    const rootStats = fs.lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw unsafePathError(root);
    ensurePrivateDirectory(directory);
    const directoryStats = fs.lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw unsafePathError(directory);
    }
  } catch (cause) {
    throw new ProfileError('Browser state lock storage is not private', {
      hint: `Fix permissions, ownership, and path types for: ${root}`,
      cause,
    });
  }
  return directory;
}

function journalSafetyError(target, journalPath, cause) {
  return new ProfileError(`${target.kind} "${target.name}" lock journal is unsafe`, {
    hint: manualRemovalHint(journalPath),
    cause,
  });
}

function closeOpenedJournal(opened) {
  if (opened.descriptor === undefined) return;
  const descriptor = opened.descriptor;
  try {
    fs.closeSync(descriptor);
    opened.descriptor = undefined;
  } catch (error) {
    if (error.code === 'EBADF') {
      opened.descriptor = undefined;
      return;
    }
    throw error;
  }
}

function validateOpenedJournal(descriptor, journalPath) {
  const stats = fs.fstatSync(descriptor);
  assertPrivateFile(stats, journalPath);
  const identity = nodeIdentity(stats);
  const current = fs.lstatSync(journalPath, { throwIfNoEntry: false });
  if (
    !current
    || current.isSymbolicLink()
    || !current.isFile()
    || !hasNodeIdentity(current, identity)
  ) {
    throw replacedJournalError(journalPath);
  }
  assertPrivateFile(current, journalPath);
  return identity;
}

function openJournal(target, { create, readOnly = false, allowAbsent = false }) {
  const journalPath = lockPath(target);
  let descriptor;
  let created = false;
  let failure;

  try {
    if (readOnly) {
      if (create) throw new TypeError('A read-only lock journal cannot be created');
      descriptor = fs.openSync(journalPath, READ_OPEN_FLAGS);
    } else if (create) {
      try {
        descriptor = fs.openSync(journalPath, CREATE_OPEN_FLAGS, 0o600);
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        descriptor = fs.openSync(journalPath, APPEND_OPEN_FLAGS);
      }
    } else {
      descriptor = fs.openSync(journalPath, APPEND_OPEN_FLAGS);
    }

    const identity = validateOpenedJournal(descriptor, journalPath);
    return { descriptor, identity, journalPath, created };
  } catch (error) {
    if (allowAbsent && descriptor === undefined && error.code === 'ENOENT') return null;
    failure = error;
  }

  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (closeError) {
      attachStateCleanupFailures(failure, [cleanupEntry(target, closeError)]);
    }
  }

  if (failure instanceof ProfileError) throw failure;
  throw journalSafetyError(target, journalPath, failure);
}

function journalPathStatus(opened) {
  const current = fs.lstatSync(opened.journalPath, { throwIfNoEntry: false });
  if (!current) return 'absent';
  if (!hasNodeIdentity(current, opened.identity)) return 'replaced';
  assertPrivateFile(current, opened.journalPath);
  return 'same';
}

function journalSizeError(target, journalPath, size) {
  return new ProfileError(
    `${target.kind} "${target.name}" lock journal exceeds the 4 MiB safety limit (${size} bytes)`,
    { hint: maintenanceHint(journalPath) },
  );
}

function assertJournalSize(target, opened, size) {
  if (size > MAX_JOURNAL_BYTES) {
    throw journalSizeError(target, opened.journalPath, size);
  }
}

function validateDescriptor(target, opened) {
  const stats = fs.fstatSync(opened.descriptor);
  assertPrivateFile(stats, opened.journalPath);
  if (!hasNodeIdentity(stats, opened.identity)) {
    throw replacedJournalError(opened.journalPath);
  }
  assertJournalSize(target, opened, stats.size);
  return stats;
}

function readJournalBytes(target, opened) {
  let position = 0;
  let buffer = Buffer.alloc(0);

  while (true) {
    const stats = validateDescriptor(target, opened);
    if (stats.size < position) {
      throw invalidJournalError(`State lock journal was truncated: ${opened.journalPath}`);
    }

    if (buffer.length < stats.size) {
      const expanded = Buffer.allocUnsafe(stats.size);
      buffer.copy(expanded, 0, 0, position);
      buffer = expanded;
    }

    while (position < stats.size) {
      const bytesRead = fs.readSync(
        opened.descriptor,
        buffer,
        position,
        stats.size - position,
        position,
      );
      if (bytesRead === 0) {
        throw invalidJournalError(`State lock journal was truncated: ${opened.journalPath}`);
      }
      position += bytesRead;
    }

    const finalStats = validateDescriptor(target, opened);
    if (finalStats.size < position) {
      throw invalidJournalError(`State lock journal was truncated: ${opened.journalPath}`);
    }
    if (finalStats.size > position) continue;
    if (journalPathStatus(opened) !== 'same') {
      throw replacedJournalError(opened.journalPath);
    }
    return buffer.subarray(0, position);
  }
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function hasExactKeys(record, expected) {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function validClaim(record, target) {
  return Boolean(
    record
    && typeof record === 'object'
    && !Array.isArray(record)
    && hasExactKeys(record, [
      'op',
      'token',
      'root',
      'kind',
      'name',
      'pid',
      'hostname',
      'createdAt',
    ])
    && record.op === 'claim'
    && TOKEN_PATTERN.test(record.token)
    && record.root === target.root
    && record.kind === target.kind
    && record.name === target.name
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.hostname === 'string'
    && record.hostname.length > 0
    && validTimestamp(record.createdAt)
  );
}

function validRelease(record) {
  return Boolean(
    record
    && typeof record === 'object'
    && !Array.isArray(record)
    && hasExactKeys(record, ['op', 'token', 'releasedAt'])
    && record.op === 'release'
    && TOKEN_PATTERN.test(record.token)
    && validTimestamp(record.releasedAt)
  );
}

function parseJournal(target, opened, bytes) {
  if (bytes.length === 0) {
    return { records: [], claims: new Map(), activeClaims: [] };
  }
  if (bytes[bytes.length - 1] !== 0x0a) {
    throw invalidJournalError(`State lock journal has a truncated final record: ${opened.journalPath}`);
  }

  let contents;
  try {
    contents = UTF8_DECODER.decode(bytes);
  } catch (cause) {
    throw invalidJournalError(
      `State lock journal is not valid UTF-8: ${opened.journalPath}`,
      { cause },
    );
  }

  const lines = contents.slice(0, -1).split('\n');
  const records = [];
  const claims = new Map();
  const active = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      throw invalidJournalError(`State lock journal contains an empty record: ${opened.journalPath}`);
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      throw invalidJournalError(
        `State lock journal contains malformed JSON at line ${index + 1}: ${opened.journalPath}`,
        { cause },
      );
    }

    if (record?.op === 'claim') {
      if (!validClaim(record, target) || claims.has(record.token)) {
        throw invalidJournalError(
          `State lock journal contains an invalid claim at line ${index + 1}: ${opened.journalPath}`,
        );
      }
      const claim = Object.freeze({ ...record, index });
      claims.set(record.token, claim);
      active.set(record.token, claim);
    } else if (record?.op === 'release') {
      if (!validRelease(record) || !claims.has(record.token)) {
        throw invalidJournalError(
          `State lock journal contains an invalid release at line ${index + 1}: ${opened.journalPath}`,
        );
      }
      active.delete(record.token);
    } else {
      throw invalidJournalError(
        `State lock journal contains an unknown record at line ${index + 1}: ${opened.journalPath}`,
      );
    }

    records.push(Object.freeze(record));
  }

  return {
    records: Object.freeze(records),
    claims,
    activeClaims: Object.freeze([...active.values()].sort((a, b) => a.index - b.index)),
  };
}

function readJournal(target, opened) {
  try {
    return parseJournal(target, opened, readJournalBytes(target, opened));
  } catch (cause) {
    if (cause instanceof ProfileError) throw cause;
    throw new ProfileError(`${target.kind} "${target.name}" has an invalid lock journal`, {
      hint: manualRemovalHint(opened.journalPath),
      cause,
    });
  }
}

function serializeRecord(record) {
  return Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
}

function appendRecord(target, opened, record, progress = {}) {
  const buffer = serializeRecord(record);
  const stats = validateDescriptor(target, opened);
  assertJournalSize(target, opened, stats.size + buffer.length);
  if (journalPathStatus(opened) !== 'same') {
    throw replacedJournalError(opened.journalPath);
  }

  const bytesWritten = fs.writeSync(
    opened.descriptor,
    buffer,
    0,
    buffer.length,
    null,
  );
  progress.complete = bytesWritten === buffer.length;
  if (!progress.complete) {
    throw invalidJournalError(
      `State lock journal append was incomplete: ${opened.journalPath} (${bytesWritten}/${buffer.length} bytes)`,
    );
  }
  fs.fsyncSync(opened.descriptor);
  progress.synced = true;
}

function claimRecord(target, token) {
  return {
    op: 'claim',
    token,
    root: target.root,
    kind: target.kind,
    name: target.name,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
}

function releaseRecord(token) {
  return {
    op: 'release',
    token,
    releasedAt: new Date().toISOString(),
  };
}

function contentionError(target, owner, journalPath) {
  if (owner.hostname !== os.hostname()) {
    return new ProfileError(
      `${target.kind} "${target.name}" has an active lock claim from process ${owner.pid} on ${owner.hostname}`,
      { hint: manualRemovalHint(journalPath) },
    );
  }

  const status = processStatus(owner.pid);
  if (status === 'alive') {
    return new ProfileError(
      `${target.kind} "${target.name}" is already in use by process ${owner.pid}`,
      { hint: 'Close the other stealth browser before reusing this state' },
    );
  }
  if (status === 'dead') {
    return new ProfileError(
      `${target.kind} "${target.name}" has a stale lock claim from process ${owner.pid}`,
      { hint: manualRemovalHint(journalPath) },
    );
  }
  return new ProfileError(
    `${target.kind} "${target.name}" has a lock claim whose process cannot be verified`,
    { hint: manualRemovalHint(journalPath) },
  );
}

function releaseFailure(target, journalPath, cause) {
  return new ProfileError(
    `Failed to release ${target.kind} "${target.name}" lock journal: ${cause.message}`,
    { hint: manualRemovalHint(journalPath), cause },
  );
}

function closeFailure(target, journalPath, cause) {
  return new ProfileError(
    `Failed to close ${target.kind} "${target.name}" lock journal: ${cause.message}`,
    { hint: manualRemovalHint(journalPath), cause },
  );
}

function replacementClaimError(target, journalPath) {
  return new ProfileError(
    `${target.kind} "${target.name}" replacement lock journal still contains this process's active claim`,
    { hint: manualRemovalHint(journalPath) },
  );
}

function replacementInspectionFailure(target, journalPath, cause) {
  return new ProfileError(
    `${target.kind} "${target.name}" replacement lock journal could not be inspected safely`,
    { hint: manualRemovalHint(journalPath), cause },
  );
}

function inspectDetachedJournalPath(record) {
  let currentOpened;
  let currentClaimIsActive = false;
  let failure;

  try {
    currentOpened = openJournal(record.target, {
      create: false,
      readOnly: true,
      allowAbsent: true,
    });

    if (!currentOpened) {
      if (journalPathStatus(record.opened) !== 'absent') {
        throw replacedJournalError(record.opened.journalPath);
      }
      return;
    }

    const journal = readJournal(record.target, currentOpened);
    currentClaimIsActive = journal.activeClaims.some(({ token }) => token === record.token);
  } catch (cause) {
    failure = cause;
  }

  if (currentOpened) {
    try {
      closeOpenedJournal(currentOpened);
    } catch (cause) {
      const closeError = closeFailure(
        record.target,
        record.opened.journalPath,
        cause,
      );
      if (failure) attachStateCleanupFailures(failure, [cleanupEntry(record.target, closeError)]);
      else failure = closeError;
    }
  }

  if (failure) {
    throw replacementInspectionFailure(
      record.target,
      record.opened.journalPath,
      failure,
    );
  }
  if (currentClaimIsActive) {
    throw replacementClaimError(record.target, record.opened.journalPath);
  }
}

function createRelease(record) {
  let writeAuthorized = true;
  let releasePublished = false;
  let releaseDurable = false;
  let descriptorCleanupComplete = false;

  function finishClose() {
    if (descriptorCleanupComplete) return;
    try {
      closeOpenedJournal(record.opened);
      descriptorCleanupComplete = true;
    } catch (cause) {
      throw closeFailure(record.target, record.opened.journalPath, cause);
    }
  }

  function verificationFailure(cause) {
    writeAuthorized = false;
    return new ProfileError(
      `${record.target.kind} "${record.target.name}" lock ownership could not be verified`,
      { hint: manualRemovalHint(record.opened.journalPath), cause },
    );
  }

  function confirmReleaseDurability() {
    if (!releasePublished || releaseDurable) return;
    try {
      fs.fsyncSync(record.opened.descriptor);
      releaseDurable = true;
    } catch (cause) {
      throw releaseFailure(record.target, record.opened.journalPath, cause);
    }
  }

  function finishPublishedRelease() {
    let status;
    try {
      status = journalPathStatus(record.opened);
    } catch (cause) {
      throw verificationFailure(cause);
    }
    if (status !== 'same') inspectDetachedJournalPath(record);

    confirmReleaseDurability();
    finishClose();
  }

  return {
    isActive() {
      if (!writeAuthorized || releasePublished) return false;

      try {
        if (journalPathStatus(record.opened) !== 'same') {
          writeAuthorized = false;
          return false;
        }

        const journal = readJournal(record.target, record.opened);
        const claim = journal.claims.get(record.token);
        if (!claim) {
          writeAuthorized = false;
          return false;
        }

        const active = journal.activeClaims.some(({ token }) => token === record.token);
        if (!active) {
          writeAuthorized = false;
          releasePublished = true;
        }
        return active;
      } catch {
        writeAuthorized = false;
        return false;
      }
    },

    release() {
      if (descriptorCleanupComplete) return;
      if (releasePublished) {
        finishPublishedRelease();
        return;
      }

      let status;
      try {
        status = journalPathStatus(record.opened);
      } catch (cause) {
        throw verificationFailure(cause);
      }
      if (status !== 'same') {
        writeAuthorized = false;
        inspectDetachedJournalPath(record);
        finishClose();
        return;
      }

      let journal;
      try {
        journal = readJournal(record.target, record.opened);
      } catch (cause) {
        throw verificationFailure(cause);
      }

      const claim = journal.claims.get(record.token);
      if (!claim) {
        writeAuthorized = false;
        finishClose();
        return;
      }

      const claimIsActive = journal.activeClaims.some(({ token }) => token === record.token);
      if (!claimIsActive) {
        writeAuthorized = false;
        releasePublished = true;
        finishPublishedRelease();
        return;
      }

      const progress = {};
      try {
        appendRecord(record.target, record.opened, releaseRecord(record.token), progress);
      } catch (cause) {
        if (progress.complete) {
          writeAuthorized = false;
          releasePublished = true;
          releaseDurable = progress.synced === true;
        }
        throw releaseFailure(record.target, record.opened.journalPath, cause);
      }

      writeAuthorized = false;
      releasePublished = true;
      releaseDurable = true;
      finishClose();
    },
  };
}

function acquireLock(target) {
  ensureLocksDir(target.root);
  const journalPath = lockPath(target);
  const token = crypto.randomUUID();
  let opened;
  let claimAppended = false;
  let acquired = false;

  try {
    opened = openJournal(target, { create: true });
    readJournal(target, opened);

    const progress = {};
    try {
      appendRecord(target, opened, claimRecord(target, token), progress);
    } finally {
      claimAppended = progress.complete === true;
    }

    const journal = readJournal(target, opened);
    const ownClaim = journal.claims.get(token);
    if (!ownClaim) {
      throw new ProfileError(
        `${target.kind} "${target.name}" lock claim publication could not be verified`,
        { hint: manualRemovalHint(journalPath) },
      );
    }

    const earliest = journal.activeClaims[0];
    if (!earliest || earliest.token !== token) {
      throw contentionError(target, earliest || ownClaim, journalPath);
    }

    acquired = true;
    return createRelease({ target, token, opened });
  } catch (cause) {
    const failure = cause instanceof ProfileError
      ? cause
      : new ProfileError(
        `Failed to acquire ${target.kind} "${target.name}" lock`,
        { hint: manualRemovalHint(journalPath), cause },
      );
    const cleanupFailures = [];

    if (opened && claimAppended && !acquired) {
      try {
        if (journalPathStatus(opened) === 'same') {
          appendRecord(target, opened, releaseRecord(token));
        }
      } catch (cleanupError) {
        cleanupFailures.push(cleanupEntry(target, releaseFailure(
          target,
          opened.journalPath,
          cleanupError,
        )));
      }
    }

    if (opened) {
      try {
        closeOpenedJournal(opened);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupEntry(target, closeFailure(
          target,
          opened.journalPath,
          cleanupError,
        )));
      }
    }

    attachStateCleanupFailures(failure, cleanupFailures);
    throw failure;
  }
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

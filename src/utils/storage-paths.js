import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProfileError } from '../errors.js';

const STATE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const JSON_SUFFIX = '.json';

function legacySanitizedName(name) {
  if (typeof name !== 'string') return null;
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  return STATE_NAME_PATTERN.test(sanitized) ? sanitized : null;
}

export function getStealthHome() {
  return path.resolve(process.env.STEALTH_HOME || path.join(os.homedir(), '.stealth'));
}

/**
 * Resolve a path and prove that it remains at or below STEALTH_HOME.
 */
export function assertPathWithinStealthHome(targetPath) {
  const root = getStealthHome();
  const resolved = path.resolve(targetPath);
  const relative = path.relative(root, resolved);
  if (
    relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    return resolved;
  }

  throw new ProfileError(`Sensitive state path escapes STEALTH_HOME: ${resolved}`, {
    hint: `Keep browser state under: ${root}`,
  });
}

export function getProfilesDir() {
  return assertPathWithinStealthHome(path.join(getStealthHome(), 'profiles'));
}

export function getSessionsDir() {
  return assertPathWithinStealthHome(path.join(getStealthHome(), 'sessions'));
}

export function getStateLocksDir() {
  return assertPathWithinStealthHome(path.join(getStealthHome(), 'locks'));
}

/**
 * Validate and canonicalize a profile/session name.
 *
 * Names are ASCII-only because they become portable filenames and lock keys.
 * Canonical lowercase names make case aliases share one identity on every OS.
 */
export function assertStateName(name, kind) {
  if (typeof name !== 'string' || !STATE_NAME_PATTERN.test(name)) {
    const legacyName = legacySanitizedName(name);
    throw new ProfileError(
      `${kind} name must contain only letters, numbers, underscores, and hyphens`,
      {
        hint: legacyName
          ? `Earlier versions may have stored this state under the sanitized basename "${legacyName}". Use that basename explicitly; path-like names are not accepted.`
          : 'Choose a non-empty name containing only letters, numbers, underscores, and hyphens',
      },
    );
  }
  return name.toLowerCase();
}

function canonicalNameFromFile(fileName) {
  if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith(JSON_SUFFIX)) {
    return null;
  }
  const basename = fileName.slice(0, -JSON_SUFFIX.length);
  return STATE_NAME_PATTERN.test(basename) ? basename.toLowerCase() : null;
}

function scanStateFiles(directory) {
  const safeDirectory = assertPathWithinStealthHome(directory);
  const groups = new Map();

  for (const entry of fs.readdirSync(safeDirectory, { withFileTypes: true })) {
    const name = canonicalNameFromFile(entry.name);
    if (!name) continue;
    const matches = groups.get(name) || [];
    matches.push({
      name,
      fileName: entry.name,
      filePath: path.join(safeDirectory, entry.name),
    });
    groups.set(name, matches);
  }

  return groups;
}

function assertNoCollision(kind, directory, name, matches) {
  if (matches.length <= 1) return;
  const fileNames = matches.map(({ fileName }) => `"${fileName}"`).join(', ');
  throw new ProfileError(
    `${kind} "${name}" has case-insensitive filename collisions`,
    {
      hint: `Keep exactly one of these files in ${directory}: ${fileNames}`,
    },
  );
}

/**
 * Resolve an existing JSON state file case-insensitively, or return the
 * canonical lowercase path for a new file.
 */
export function resolveStateFilePath(directory, name, kind) {
  const safeDirectory = assertPathWithinStealthHome(directory);
  const canonicalName = assertStateName(name, kind);
  const matches = scanStateFiles(safeDirectory).get(canonicalName) || [];
  assertNoCollision(kind, safeDirectory, canonicalName, matches);

  if (matches.length === 1) {
    return { ...matches[0], exists: true };
  }

  const fileName = `${canonicalName}${JSON_SUFFIX}`;
  return {
    name: canonicalName,
    fileName,
    filePath: path.join(safeDirectory, fileName),
    exists: false,
  };
}

/**
 * List JSON state files using canonical, reusable basenames.
 */
export function listStateFilePaths(directory, kind) {
  const safeDirectory = assertPathWithinStealthHome(directory);
  const groups = scanStateFiles(safeDirectory);
  const files = [];

  for (const [name, matches] of groups) {
    assertNoCollision(kind, safeDirectory, name, matches);
    files.push(matches[0]);
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

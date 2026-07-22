import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  readPrivateFile,
  updateJsonAtomic,
  writeJsonAtomic,
} from '../../src/utils/json-file.js';

const temporaryDirectories = [];
const JSON_FILE_MODULE = new URL('../../src/utils/json-file.js', import.meta.url).href;

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-json-'));
  temporaryDirectories.push(directory);
  return directory;
}

function temporaryFile() {
  return path.join(temporaryDirectory(), 'state.json');
}

function statsWithUid(stats, uid) {
  return new Proxy(stats, {
    get(current, property) {
      if (property === 'uid') return uid;
      const value = Reflect.get(current, property);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
}

async function waitForPath(filePath, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for child-process marker: ${filePath}`);
}

function collectChildResult(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

describe('private state permissions', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('hardens legacy directory and file modes', () => {
    const directory = temporaryDirectory();
    const filePath = path.join(directory, 'state.json');
    fs.writeFileSync(filePath, '{}');
    fs.chmodSync(directory, 0o755);
    fs.chmodSync(filePath, 0o644);

    ensurePrivateDirectory(directory);
    ensurePrivateFile(filePath);

    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  posixIt('rejects a wrong-owner file before attempting to harden permissions', () => {
    const filePath = temporaryFile();
    fs.writeFileSync(filePath, '{}', { mode: 0o644 });
    const lstatSync = fs.lstatSync.bind(fs);
    const chmodSync = vi.spyOn(fs, 'chmodSync');
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      const stats = lstatSync(target, ...args);
      if (target !== filePath) return stats;
      return new Proxy(stats, {
        get(current, property) {
          if (property === 'uid') return current.uid + 1;
          const value = Reflect.get(current, property);
          return typeof value === 'function' ? value.bind(current) : value;
        },
      });
    });

    expect(() => ensurePrivateFile(filePath)).toThrow('must be owned by uid');
    expect(chmodSync).not.toHaveBeenCalled();
  });

  posixIt('fails closed when an insecure directory cannot be hardened', () => {
    const directory = temporaryDirectory();
    fs.chmodSync(directory, 0o755);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    });

    expect(() => ensurePrivateDirectory(directory)).toThrow('insecure permissions');
  });

  posixIt('fails closed when an insecure file cannot be hardened', () => {
    const filePath = temporaryFile();
    fs.writeFileSync(filePath, '{}');
    fs.chmodSync(filePath, 0o644);
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    });

    expect(() => ensurePrivateFile(filePath)).toThrow('insecure permissions');
  });

  it('rejects non-directory and non-regular targets', () => {
    const directory = temporaryDirectory();
    const filePath = path.join(directory, 'state.json');
    fs.writeFileSync(filePath, '{}');

    expect(() => ensurePrivateDirectory(filePath)).toThrow('must be a directory');
    expect(() => ensurePrivateFile(directory)).toThrow('must be a regular file');
  });

  posixIt('rejects symbolic-link directories and files', () => {
    const targetDirectory = temporaryDirectory();
    const linksDirectory = temporaryDirectory();
    const directoryLink = path.join(linksDirectory, 'linked-directory');
    fs.symlinkSync(targetDirectory, directoryLink);

    const targetFile = path.join(targetDirectory, 'target.json');
    const fileLink = path.join(linksDirectory, 'linked-file.json');
    fs.writeFileSync(targetFile, '{}');
    fs.symlinkSync(targetFile, fileLink);

    expect(() => ensurePrivateDirectory(directoryLink)).toThrow('must not be a symbolic link');
    expect(() => ensurePrivateFile(fileLink)).toThrow('must not be a symbolic link');
  });

  posixIt('rejects a user-controlled symbolic link in the ancestor chain', () => {
    const targetDirectory = temporaryDirectory();
    const linksDirectory = temporaryDirectory();
    const ancestorLink = path.join(linksDirectory, 'linked-parent');
    fs.symlinkSync(targetDirectory, ancestorLink);

    expect(() => ensurePrivateDirectory(path.join(ancestorLink, 'state')))
      .toThrow('unsafe ancestor');
    expect(fs.existsSync(path.join(targetDirectory, 'state'))).toBe(false);
  });

  posixIt('rejects an untrusted symlink behind a system-owned alias', () => {
    const targetDirectory = temporaryDirectory();
    const linksDirectory = temporaryDirectory();
    const nestedAlias = path.join(linksDirectory, 'nested-alias');
    const systemAlias = path.join(linksDirectory, 'system-alias');
    fs.symlinkSync(targetDirectory, nestedAlias);
    fs.symlinkSync(nestedAlias, systemAlias);
    const lstatSync = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      const stats = lstatSync(target, ...args);
      if (target === systemAlias) return statsWithUid(stats, 0);
      if (target === nestedAlias) return statsWithUid(stats, 12345);
      return stats;
    });

    expect(() => ensurePrivateDirectory(path.join(systemAlias, 'state')))
      .toThrow('symbolic links must be system-owned');
    expect(fs.existsSync(path.join(targetDirectory, 'state'))).toBe(false);
  });

  posixIt('accepts a fully trusted system-owned alias chain', () => {
    const targetDirectory = temporaryDirectory();
    const linksDirectory = temporaryDirectory();
    const nestedAlias = path.join(linksDirectory, 'nested-system-alias');
    const systemAlias = path.join(linksDirectory, 'system-alias');
    fs.symlinkSync(targetDirectory, nestedAlias);
    fs.symlinkSync(nestedAlias, systemAlias);
    const lstatSync = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      const stats = lstatSync(target, ...args);
      if (target === systemAlias || target === nestedAlias) {
        return statsWithUid(stats, 0);
      }
      return stats;
    });

    ensurePrivateDirectory(path.join(systemAlias, 'state'));

    expect(fs.statSync(path.join(targetDirectory, 'state')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(targetDirectory, 'state')).mode & 0o777).toBe(0o700);
  });

  posixIt('rejects a non-sticky ancestor writable by other users', () => {
    const directory = temporaryDirectory();
    const sharedDirectory = path.join(directory, 'shared');
    fs.mkdirSync(sharedDirectory, { mode: 0o700 });
    fs.chmodSync(sharedDirectory, 0o777);

    expect(() => ensurePrivateDirectory(path.join(sharedDirectory, 'state')))
      .toThrow('writable by another user');
  });

  posixIt('does not follow a symlink inserted while creating a private component', () => {
    const sharedDirectory = temporaryDirectory();
    const outsideDirectory = temporaryDirectory();
    fs.chmodSync(sharedDirectory, 0o1777);
    const privateRoot = path.join(sharedDirectory, 'predictable-root');
    const nestedDirectory = path.join(privateRoot, 'profiles');
    const mkdirSync = fs.mkdirSync.bind(fs);
    let injected = false;

    vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
      if (!injected && (target === privateRoot || target === nestedDirectory)) {
        injected = true;
        fs.symlinkSync(outsideDirectory, privateRoot);
      }
      return mkdirSync(target, options);
    });

    expect(() => ensurePrivateDirectory(nestedDirectory)).toThrow('must not be a symbolic link');
    expect(fs.existsSync(path.join(outsideDirectory, 'profiles'))).toBe(false);
  });
});

describe('readPrivateFile', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  it('reads through a validated no-follow descriptor', () => {
    const filePath = temporaryFile();
    fs.writeFileSync(filePath, '{"version":1}\n', { mode: 0o600 });

    expect(readPrivateFile(filePath, { encoding: 'utf8' })).toBe('{"version":1}\n');
  });

  it('fails before opening when the parent directory is absent', () => {
    const filePath = path.join(temporaryDirectory(), 'missing', 'state.json');
    const openSpy = vi.spyOn(fs, 'openSync');

    expect(() => readPrivateFile(filePath, { encoding: 'utf8' })).toThrow(
      'parent directory does not exist',
    );
    expect(openSpy).not.toHaveBeenCalled();
  });

  posixIt('rejects a pathname replacement that occurs during descriptor reads', () => {
    const directory = temporaryDirectory();
    const filePath = path.join(directory, 'state.json');
    const displacedPath = path.join(directory, 'state.displaced.json');
    const attackerPath = path.join(directory, 'attacker.json');
    fs.writeFileSync(filePath, '{"trusted":true}\n', { mode: 0o600 });
    fs.writeFileSync(attackerPath, '{"proxy":"http://attacker.invalid"}\n', { mode: 0o600 });
    const readFileSync = fs.readFileSync.bind(fs);
    let swapped = false;

    vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
      if (typeof target === 'number' && !swapped) {
        swapped = true;
        fs.renameSync(filePath, displacedPath);
        fs.copyFileSync(attackerPath, filePath);
      }
      return readFileSync(target, ...args);
    });

    expect(() => readPrivateFile(filePath, { encoding: 'utf8' }))
      .toThrow('was replaced while in use');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"proxy":"http://attacker.invalid"}\n');
  });
});

describe('writeJsonAtomic', () => {
  it('should atomically write owner-only JSON', () => {
    const filePath = temporaryFile();

    writeJsonAtomic(filePath, { cookies: [{ name: 'sid', value: '123' }] });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).cookies).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('retains failed temp cleanup and drains it before a retry creates another artifact', () => {
    const filePath = temporaryFile();
    const openSync = fs.openSync.bind(fs);
    const fsyncSync = fs.fsyncSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    const unlinkSync = fs.unlinkSync.bind(fs);
    let tempDescriptor;
    let tempPath;
    let tempOpenCount = 0;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (typeof target === 'string' && target.endsWith('.tmp')) {
        tempDescriptor = descriptor;
        tempPath = target;
        tempOpenCount += 1;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (descriptor === tempDescriptor) {
        const error = new Error('temp fsync failed');
        error.code = 'EIO';
        throw error;
      }
      return fsyncSync(descriptor);
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === tempDescriptor) {
        const error = new Error('temp close failed');
        error.code = 'EIO';
        throw error;
      }
      return closeSync(descriptor);
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === tempPath) {
        const error = new Error('temp unlink failed');
        error.code = 'EIO';
        throw error;
      }
      return unlinkSync(target);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 1 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toContain('temp fsync failed');
    expect(failure?.cleanupFailures).toHaveLength(2);
    expect(failure?.cleanupOutcome).toEqual(expect.objectContaining({
      status: 'pending',
      destination: filePath,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ operation: 'close', path: tempPath }),
        expect.objectContaining({ operation: 'remove', path: tempPath }),
      ]),
    }));
    expect(Object.getOwnPropertyDescriptor(failure, 'cleanupFailures')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(failure, 'cleanupOutcome')?.enumerable).toBe(false);
    expect(fs.existsSync(tempPath)).toBe(true);
    expect(tempOpenCount).toBe(1);

    expect(() => writeJsonAtomic(filePath, { version: 2 }))
      .toThrow('cleanup is incomplete');
    expect(tempOpenCount).toBe(1);

    vi.restoreAllMocks();
    expect(() => writeJsonAtomic(filePath, { version: 3 })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 3 });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['state.json']);
  });

  it('retains a failed write-claim release and drains it before another claim', () => {
    const filePath = temporaryFile();
    const openSync = fs.openSync.bind(fs);
    const unlinkSync = fs.unlinkSync.bind(fs);
    let claimPath;
    let claimOpenCount = 0;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (typeof target === 'string' && target.endsWith('.claim')) {
        claimPath = target;
        claimOpenCount += 1;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (target === claimPath) {
        const error = new Error('claim unlink failed');
        error.code = 'EIO';
        throw error;
      }
      return unlinkSync(target);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 1 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.code).toBe('EJSONCLEANUP');
    expect(failure?.message).toContain('committed');
    expect(failure?.commitOutcome).toEqual({
      status: 'committed',
      replacement: 'published',
      cleanup: { status: 'pending' },
    });
    expect(Object.getOwnPropertyDescriptor(failure, 'commitOutcome')?.enumerable).toBe(false);
    expect(failure?.cleanupOutcome?.artifacts).toContainEqual(expect.objectContaining({
      operation: 'release',
      path: claimPath,
    }));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(claimOpenCount).toBe(1);

    expect(() => writeJsonAtomic(filePath, { version: 2 }))
      .toThrow('cleanup is incomplete');
    expect(claimOpenCount).toBe(1);

    vi.restoreAllMocks();
    expect(() => writeJsonAtomic(filePath, { version: 3 })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 3 });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['state.json']);
  });

  it('retries write-claim removal sync before admitting another claim', () => {
    const filePath = temporaryFile();
    const openSync = fs.openSync.bind(fs);
    const fsyncSync = fs.fsyncSync.bind(fs);
    let claimPath;
    let claimOpenCount = 0;
    let directorySyncs = 0;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (typeof target === 'string' && target.endsWith('.claim')) {
        claimPath = target;
        claimOpenCount += 1;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        directorySyncs += 1;
        if (directorySyncs >= 3) {
          const error = new Error('claim removal sync failed');
          error.code = 'EIO';
          throw error;
        }
      }
      return fsyncSync(descriptor);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 1 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.code).toBe('EJSONCLEANUP');
    expect(failure?.commitOutcome?.status).toBe('committed');
    expect(failure?.cleanupOutcome?.artifacts).toContainEqual(expect.objectContaining({
      operation: 'release',
      path: claimPath,
    }));
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(claimOpenCount).toBe(1);

    expect(() => writeJsonAtomic(filePath, { version: 2 }))
      .toThrow('cleanup is incomplete');
    expect(claimOpenCount).toBe(1);

    vi.restoreAllMocks();
    expect(() => writeJsonAtomic(filePath, { version: 3 })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 3 });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['state.json']);
  });

  it('never retries an identity-less descriptor after an ambiguous close', () => {
    const filePath = temporaryFile();
    const directory = path.dirname(filePath);
    const unrelatedPath = path.join(directory, 'unrelated.txt');
    const openSync = fs.openSync.bind(fs);
    const fstatSync = fs.fstatSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let claimDescriptor;
    let claimPath;
    let initialFstatFailed = false;
    let ambiguousCloseInjected = false;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (typeof target === 'string' && target.endsWith('.claim')) {
        claimDescriptor = descriptor;
        claimPath = target;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
      if (descriptor === claimDescriptor && !initialFstatFailed) {
        initialFstatFailed = true;
        const error = new Error('claim identity lookup failed');
        error.code = 'EIO';
        throw error;
      }
      return fstatSync(descriptor, ...args);
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === claimDescriptor && !ambiguousCloseInjected) {
        ambiguousCloseInjected = true;
        closeSync(descriptor);
        const error = new Error('close reported failure after releasing descriptor');
        error.code = 'EIO';
        throw error;
      }
      return closeSync(descriptor);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 1 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toContain('claim identity lookup failed');
    expect(failure?.cleanupOutcome?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'close', path: claimPath }),
      expect.objectContaining({ operation: 'inspect', path: claimPath }),
    ]));
    expect(fs.existsSync(claimPath)).toBe(true);

    vi.restoreAllMocks();
    const unrelatedDescriptor = fs.openSync(unrelatedPath, 'w+', 0o600);
    expect(unrelatedDescriptor).toBe(claimDescriptor);

    expect(() => writeJsonAtomic(filePath, { version: 2 }))
      .toThrow('cleanup is incomplete');
    expect(fs.fstatSync(unrelatedDescriptor).isFile()).toBe(true);
    fs.writeSync(unrelatedDescriptor, Buffer.from('still open'));
    fs.closeSync(unrelatedDescriptor);

    fs.unlinkSync(claimPath);
    expect(() => writeJsonAtomic(filePath, { version: 3 })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 3 });
  });

  it('never retries an identity-bound descriptor after same-inode fd reuse', () => {
    const filePath = temporaryFile();
    writeJsonAtomic(filePath, { version: 1 });
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    const fsyncSync = fs.fsyncSync.bind(fs);
    let claimDescriptor;
    let claimPath;
    let directorySyncs = 0;
    let ambiguousCloseInjected = false;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (typeof target === 'string' && target.endsWith('.claim')) {
        claimDescriptor = descriptor;
        claimPath = target;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        directorySyncs += 1;
        if (directorySyncs >= 2) {
          const error = new Error('directory sync failed');
          error.code = 'EIO';
          throw error;
        }
      }
      return fsyncSync(descriptor);
    });
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === claimDescriptor && !ambiguousCloseInjected) {
        ambiguousCloseInjected = true;
        closeSync(descriptor);
        const error = new Error('claim close failed after releasing descriptor');
        error.code = 'EIO';
        throw error;
      }
      return closeSync(descriptor);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 2 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.commitOutcome?.status).toBe('uncertain');
    expect(failure?.cleanupOutcome?.artifacts).toContainEqual(expect.objectContaining({
      operation: 'close',
      path: claimPath,
    }));
    expect(closeSpy.mock.calls.filter(([descriptor]) => descriptor === claimDescriptor))
      .toHaveLength(1);
    expect(fs.existsSync(claimPath)).toBe(true);

    vi.restoreAllMocks();
    const reopenedDescriptor = fs.openSync(claimPath, 'r');
    expect(reopenedDescriptor).toBe(claimDescriptor);

    expect(() => writeJsonAtomic(filePath, { version: 3 }))
      .toThrow('cleanup is incomplete');
    expect(fs.fstatSync(reopenedDescriptor).isFile()).toBe(true);
    fs.closeSync(reopenedDescriptor);

    fs.unlinkSync(claimPath);
    expect(() => writeJsonAtomic(filePath, { version: 4 })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 4 });
  });

  it('abandons an ambiguously closed temp descriptor before same-inode fd reuse', () => {
    const filePath = temporaryFile();
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    let tempDescriptor;
    let tempPath;
    let reopenedDescriptor;
    let tempCloseAttempts = 0;
    let ambiguousCloseInjected = false;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (typeof target === 'string' && target.endsWith('.tmp')) {
        tempDescriptor = descriptor;
        tempPath = target;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === tempDescriptor) tempCloseAttempts += 1;
      if (descriptor === tempDescriptor && !ambiguousCloseInjected) {
        ambiguousCloseInjected = true;
        closeSync(descriptor);
        reopenedDescriptor = openSync(tempPath, 'r');
        const error = new Error('temp close failed after releasing descriptor');
        error.code = 'EIO';
        throw error;
      }
      return closeSync(descriptor);
    });

    expect(() => writeJsonAtomic(filePath, { version: 1 }))
      .toThrow('temp close failed after releasing descriptor');
    expect(reopenedDescriptor).toBe(tempDescriptor);
    expect(tempCloseAttempts).toBe(1);
    expect(fs.fstatSync(reopenedDescriptor).isFile()).toBe(true);

    vi.restoreAllMocks();
    fs.closeSync(reopenedDescriptor);
  });

  it('abandons an ambiguously closed rollback descriptor before same-inode fd reuse', () => {
    const filePath = temporaryFile();
    writeJsonAtomic(filePath, { version: 1 });
    const openSync = fs.openSync.bind(fs);
    const closeSync = fs.closeSync.bind(fs);
    const fsyncSync = fs.fsyncSync.bind(fs);
    let rollbackDescriptor;
    let rollbackPath;
    let reopenedDescriptor;
    let directorySyncs = 0;
    let rollbackCloseAttempts = 0;
    let ambiguousCloseInjected = false;

    vi.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
      const descriptor = openSync(target, ...args);
      if (typeof target === 'string' && target.endsWith('.rollback')) {
        rollbackDescriptor = descriptor;
        rollbackPath = target;
      }
      return descriptor;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        directorySyncs += 1;
        if (directorySyncs >= 2) {
          const error = new Error('directory sync failed');
          error.code = 'EIO';
          throw error;
        }
      }
      return fsyncSync(descriptor);
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (descriptor === rollbackDescriptor) rollbackCloseAttempts += 1;
      if (descriptor === rollbackDescriptor && !ambiguousCloseInjected) {
        ambiguousCloseInjected = true;
        closeSync(descriptor);
        reopenedDescriptor = openSync(rollbackPath, 'r');
        const error = new Error('rollback close failed after releasing descriptor');
        error.code = 'EIO';
        throw error;
      }
      return closeSync(descriptor);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 2 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.commitOutcome?.status).toBe('uncertain');
    expect(reopenedDescriptor).toBe(rollbackDescriptor);
    expect(rollbackCloseAttempts).toBe(1);
    expect(fs.fstatSync(reopenedDescriptor).isFile()).toBe(true);

    vi.restoreAllMocks();
    fs.closeSync(reopenedDescriptor);
  });

  it('fails closed in a new process while a durable temp artifact remains', () => {
    const filePath = temporaryFile();
    const directory = path.dirname(filePath);
    const artifactPath = path.join(
      directory,
      '.state.json.999999.11111111-1111-4111-8111-111111111111.tmp',
    );
    writeJsonAtomic(filePath, { version: 1 });
    fs.writeFileSync(artifactPath, '{"pending":true}\n', { mode: 0o600 });

    const script = `
      import { writeJsonAtomic } from ${JSON.stringify(JSON_FILE_MODULE)};

      try {
        writeJsonAtomic(process.env.TEST_JSON_PATH, { version: 2 });
        process.stdout.write('unexpected success');
      } catch (error) {
        process.stderr.write(JSON.stringify({
          message: error.message,
          code: error.code,
          cleanupOutcome: error.cleanupOutcome,
          cleanupOutcomeEnumerable: Object.prototype.propertyIsEnumerable.call(
            error,
            'cleanupOutcome',
          ),
        }));
        process.exitCode = 23;
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_JSON_PATH: filePath,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(23);
    expect(result.stdout).toBe('');
    const failure = JSON.parse(result.stderr);
    expect(failure.message).toContain('cleanup is incomplete');
    expect(failure.message).toContain(artifactPath);
    expect(failure.code).toBe('EJSONCLEANUP');
    expect(failure.cleanupOutcomeEnumerable).toBe(false);
    expect(failure.cleanupOutcome).toEqual({
      status: 'pending',
      destination: filePath,
      artifacts: [{
        operation: 'inspect',
        path: artifactPath,
        code: 'EJSONARTIFACTPENDING',
      }],
    });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe('{"pending":true}\n');
    expect(fs.readdirSync(directory).sort()).toEqual([
      path.basename(artifactPath),
      'state.json',
    ].sort());
  });

  it('holds a durable claim across scan and publication in another process', async () => {
    const filePath = temporaryFile();
    const directory = path.dirname(filePath);
    const readyPath = path.join(directory, 'writer-ready');
    const releasePath = path.join(directory, 'release-writer');
    const firstWriterScript = `
      import fs from 'fs';
      import path from 'path';
      import { writeJsonAtomic } from ${JSON.stringify(JSON_FILE_MODULE)};

      const filePath = process.env.TEST_JSON_PATH;
      const directory = path.dirname(filePath);
      const readdirSync = fs.readdirSync.bind(fs);
      let paused = false;
      fs.readdirSync = (target, ...args) => {
        const entries = readdirSync(target, ...args);
        if (!paused && path.resolve(target) === path.resolve(directory)) {
          paused = true;
          fs.writeFileSync(process.env.TEST_READY_PATH, 'ready', { mode: 0o600 });
          const signal = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(process.env.TEST_RELEASE_PATH)) {
            Atomics.wait(signal, 0, 0, 10);
          }
        }
        return entries;
      };

      try {
        writeJsonAtomic(filePath, { writer: 'first' });
      } catch (error) {
        process.stderr.write(JSON.stringify({
          message: error.message,
          code: error.code,
          cleanupOutcome: error.cleanupOutcome,
        }));
        process.exitCode = 31;
      }
    `;
    const firstWriter = spawn(
      process.execPath,
      ['--input-type=module', '--eval', firstWriterScript],
      {
        env: {
          ...process.env,
          TEST_JSON_PATH: filePath,
          TEST_READY_PATH: readyPath,
          TEST_RELEASE_PATH: releasePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const firstResultPromise = collectChildResult(firstWriter);
    let secondResult;
    let firstClaimPath;

    try {
      await waitForPath(readyPath);
      const claims = fs.readdirSync(directory).filter((name) => name.endsWith('.claim'));
      expect(claims).toHaveLength(1);
      firstClaimPath = path.join(directory, claims[0]);

      const secondWriterScript = `
        import { writeJsonAtomic } from ${JSON.stringify(JSON_FILE_MODULE)};
        try {
          writeJsonAtomic(process.env.TEST_JSON_PATH, { writer: 'second' });
          process.stdout.write('unexpected publication');
        } catch (error) {
          process.stderr.write(JSON.stringify({
            message: error.message,
            code: error.code,
            cleanupOutcome: error.cleanupOutcome,
          }));
          process.exitCode = 23;
        }
      `;
      secondResult = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', secondWriterScript],
        {
          encoding: 'utf8',
          env: { ...process.env, TEST_JSON_PATH: filePath },
        },
      );
    } finally {
      fs.writeFileSync(releasePath, 'release', { mode: 0o600 });
    }

    const firstResult = await firstResultPromise;
    expect(firstResult).toEqual(expect.objectContaining({
      status: 0,
      signal: null,
      stdout: '',
      stderr: '',
    }));
    expect(secondResult.error).toBeUndefined();
    expect(secondResult.status).toBe(23);
    expect(secondResult.stdout).toBe('');
    const secondFailure = JSON.parse(secondResult.stderr);
    expect(secondFailure.code).toBe('EJSONCLEANUP');
    expect(secondFailure.cleanupOutcome.artifacts).toContainEqual(expect.objectContaining({
      operation: 'inspect',
      path: firstClaimPath,
      code: 'EJSONARTIFACTPENDING',
    }));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ writer: 'first' });
    expect(fs.readdirSync(directory).filter((name) => (
      name.endsWith('.claim') || name.endsWith('.tmp') || name.endsWith('.rollback')
    ))).toEqual([]);
  }, 10000);

  it('should preserve the previous file when replacement serialization fails', () => {
    const filePath = temporaryFile();
    writeJsonAtomic(filePath, { version: 1 });
    const circular = {};
    circular.self = circular;

    expect(() => writeJsonAtomic(filePath, circular)).toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['state.json']);
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('fails closed without following or removing a durable artifact symlink', () => {
    const filePath = temporaryFile();
    const directory = path.dirname(filePath);
    const targetPath = path.join(directory, 'unrelated.json');
    const artifactPath = path.join(
      directory,
      '.state.json.999999.22222222-2222-4222-8222-222222222222.rollback',
    );
    writeJsonAtomic(filePath, { version: 1 });
    fs.writeFileSync(targetPath, '{"untouched":true}\n', { mode: 0o600 });
    fs.symlinkSync(targetPath, artifactPath);

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 2 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.code).toBe('EJSONCLEANUP');
    expect(failure?.message).toContain(artifactPath);
    expect(failure?.cleanupOutcome).toEqual({
      status: 'pending',
      destination: filePath,
      artifacts: [{
        operation: 'inspect',
        path: artifactPath,
        code: 'EUNSAFESTATEPATH',
      }],
    });
    expect(Object.getOwnPropertyDescriptor(failure, 'cleanupOutcome')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(failure, 'artifactErrors')?.enumerable).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('{"untouched":true}\n');
    expect(fs.lstatSync(artifactPath).isSymbolicLink()).toBe(true);
  });

  posixIt('rejects a symbolic-link destination without changing its target', () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, 'outside.json');
    const linkPath = path.join(directory, 'state.json');
    fs.writeFileSync(targetPath, '{"outside":true}', { mode: 0o600 });
    fs.symlinkSync(targetPath, linkPath);

    expect(() => writeJsonAtomic(linkPath, { outside: false }))
      .toThrow('must not be a symbolic link');
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf8'))).toEqual({ outside: true });
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it('restores an existing destination after a directory fsync failure', () => {
    const filePath = temporaryFile();
    writeJsonAtomic(filePath, { version: 1 });
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directorySyncs = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        directorySyncs += 1;
        if (directorySyncs >= 2) {
          const error = new Error('I/O failure');
          error.code = 'EIO';
          throw error;
        }
      }
      return fsyncSync(descriptor);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 2 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toContain('I/O failure');
    expect(failure?.commitOutcome).toEqual(expect.objectContaining({
      status: 'uncertain',
      replacement: 'published',
      previousDestination: 'present',
      rollback: expect.objectContaining({
        status: 'failed',
        destination: 'restored',
        error: expect.objectContaining({ code: 'EIO' }),
      }),
    }));
    expect(Object.getOwnPropertyDescriptor(failure, 'commitOutcome')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(failure, 'rollbackError')?.enumerable).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
    const artifacts = fs.readdirSync(path.dirname(filePath));
    expect(artifacts).toContain('state.json');
    expect(artifacts.filter((name) => name.endsWith('.claim'))).toHaveLength(1);
    expect(failure?.cleanupOutcome?.artifacts).toContainEqual(expect.objectContaining({
      operation: 'inspect',
      path: path.join(
        path.dirname(filePath),
        artifacts.find((name) => name.endsWith('.claim')),
      ),
    }));
  });

  it('restores a new destination to absence after a directory fsync failure', () => {
    const filePath = temporaryFile();
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directorySyncs = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        directorySyncs += 1;
        if (directorySyncs >= 2) {
          const error = new Error('I/O failure');
          error.code = 'EIO';
          throw error;
        }
      }
      return fsyncSync(descriptor);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 1 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toContain('I/O failure');
    expect(failure?.commitOutcome).toEqual(expect.objectContaining({
      status: 'uncertain',
      replacement: 'published',
      previousDestination: 'absent',
      rollback: expect.objectContaining({
        status: 'failed',
        destination: 'absent',
        error: expect.objectContaining({ code: 'EIO' }),
      }),
    }));
    expect(Object.getOwnPropertyDescriptor(failure, 'commitOutcome')?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(failure, 'rollbackError')?.enumerable).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
    const artifacts = fs.readdirSync(path.dirname(filePath));
    expect(artifacts.filter((name) => name.endsWith('.claim'))).toHaveLength(1);
    expect(failure?.cleanupOutcome?.artifacts).toContainEqual(expect.objectContaining({
      operation: 'inspect',
      path: path.join(
        path.dirname(filePath),
        artifacts.find((name) => name.endsWith('.claim')),
      ),
    }));
  });

  it('restores prior contents after post-rename validation fails', () => {
    const filePath = temporaryFile();
    writeJsonAtomic(filePath, { version: 1 });
    const lstatSync = fs.lstatSync.bind(fs);
    const renameSync = fs.renameSync.bind(fs);
    let replacementPublished = false;
    let validationFailed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      const result = renameSync(source, destination);
      if (destination === filePath && String(source).endsWith('.tmp')) {
        replacementPublished = true;
      }
      return result;
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (target === filePath && replacementPublished && !validationFailed) {
        validationFailed = true;
        const error = new Error('post-rename validation failure');
        error.code = 'EIO';
        throw error;
      }
      return lstatSync(target, ...args);
    });

    let failure;
    try {
      writeJsonAtomic(filePath, { version: 2 });
    } catch (error) {
      failure = error;
    }

    expect(failure?.message).toContain('post-rename validation failure');
    expect(failure?.commitOutcome).toEqual(expect.objectContaining({
      status: 'rolled-back',
      rollback: expect.objectContaining({
        status: 'succeeded',
        destination: 'restored',
      }),
    }));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
  });

  it('ignores only an unsupported directory fsync result', () => {
    const filePath = temporaryFile();
    const fsyncSync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        const error = new Error('operation unsupported');
        error.code = 'EINVAL';
        throw error;
      }
      return fsyncSync(descriptor);
    });

    expect(() => writeJsonAtomic(filePath, { version: 1 })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
  });
});

describe('updateJsonAtomic', () => {
  it('holds the durable claim before reading and invoking the updater', () => {
    const filePath = temporaryFile();
    const directory = path.dirname(filePath);
    writeJsonAtomic(filePath, { count: 0 });

    const result = updateJsonAtomic(filePath, (current) => {
      expect(fs.readdirSync(directory).filter((name) => name.endsWith('.claim')))
        .toHaveLength(1);
      expect(() => updateJsonAtomic(filePath, (value) => value))
        .toThrow('cleanup is incomplete');
      current.count += 1;
      return current;
    });

    expect(result).toEqual({ count: 1 });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ count: 1 });
    expect(fs.readdirSync(directory).filter((name) => (
      name.endsWith('.claim') || name.endsWith('.tmp') || name.endsWith('.rollback')
    ))).toEqual([]);
  });

  it('uses an absent-file default and supports a no-publication update', () => {
    const filePath = temporaryFile();
    const result = updateJsonAtomic(filePath, (current) => {
      current.count += 1;
      return current;
    }, { createDefault: () => ({ count: 0 }) });

    expect(result).toEqual({ count: 1 });
    const before = fs.readFileSync(filePath, 'utf8');
    const identity = fs.statSync(filePath).ino;
    expect(updateJsonAtomic(filePath, () => undefined)).toBeUndefined();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(fs.statSync(filePath).ino).toBe(identity);
  });

  it('preserves malformed bytes and rejects asynchronous callbacks', () => {
    const filePath = temporaryFile();
    fs.writeFileSync(filePath, '{broken-json', { mode: 0o600 });
    const before = fs.readFileSync(filePath, 'utf8');

    expect(() => updateJsonAtomic(filePath, (current) => current)).toThrow(SyntaxError);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);

    writeJsonAtomic(filePath, { count: 0 });
    expect(() => updateJsonAtomic(filePath, async (current) => current))
      .toThrow('updater must be synchronous');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ count: 0 });
  });
});

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  readPrivateFile,
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
});

describe('readPrivateFile', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  it('reads through a validated no-follow descriptor', () => {
    const filePath = temporaryFile();
    fs.writeFileSync(filePath, '{"version":1}\n', { mode: 0o600 });

    expect(readPrivateFile(filePath, { encoding: 'utf8' })).toBe('{"version":1}\n');
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
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        const error = new Error('I/O failure');
        error.code = 'EIO';
        throw error;
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
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['state.json']);
  });

  it('restores a new destination to absence after a directory fsync failure', () => {
    const filePath = temporaryFile();
    const fsyncSync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        const error = new Error('I/O failure');
        error.code = 'EIO';
        throw error;
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
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([]);
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

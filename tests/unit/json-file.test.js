import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  writeJsonAtomic,
} from '../../src/utils/json-file.js';

const temporaryDirectories = [];

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

describe('writeJsonAtomic', () => {
  it('should atomically write owner-only JSON', () => {
    const filePath = temporaryFile();

    writeJsonAtomic(filePath, { cookies: [{ name: 'sid', value: '123' }] });

    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).cookies).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
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

  it('propagates directory fsync data-integrity failures', () => {
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

    expect(() => writeJsonAtomic(filePath, { version: 1 })).toThrow('I/O failure');
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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../../src/utils/json-file.js';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-json-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'state.json');
}

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
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const configMocks = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  deleteConfigValue: vi.fn(),
  listConfig: vi.fn(),
  resetConfig: vi.fn(),
}));

vi.mock('../../src/config.js', () => ({
  ...configMocks,
  CONFIG_FILE: '/tmp/stealth-config.json',
}));

import { registerConfig } from '../../src/commands/config.js';
import { ProxyError } from '../../src/errors.js';
import { log } from '../../src/output.js';

function programForConfig() {
  const program = new Command();
  program.exitOverride();
  registerConfig(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('config command credential display', () => {
  it('masks proxy userinfo in get and list output', async () => {
    const proxy = 'http://api-token:proxy-secret@proxy.example:8080';
    configMocks.getConfigValue.mockReturnValue(proxy);
    configMocks.listConfig.mockReturnValue([
      { key: 'proxy', value: proxy, source: 'user' },
    ]);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await programForConfig().parseAsync(['node', 'stealth', 'config', 'get', 'proxy']);
    await programForConfig().parseAsync(['node', 'stealth', 'config', 'list']);

    const rendered = output.mock.calls.flat().join(' ');
    expect(rendered).toContain('http://****@proxy.example:8080');
    expect(rendered).not.toContain('api-token');
    expect(rendered).not.toContain('proxy-secret');
  });

  it('reports invalid proxy settings through handleError with exit code 7', async () => {
    const invalid = 'http://user:do-not-leak@proxy.example:8080/private';
    configMocks.setConfigValue.mockImplementation(() => {
      throw new ProxyError(invalid, new Error('invalid proxy'), {
        message: 'Global configuration contains an invalid proxy URL',
      });
    });
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'dim').mockImplementation(() => {});

    await programForConfig().parseAsync([
      'node',
      'stealth',
      'config',
      'set',
      'proxy',
      invalid,
    ]);

    expect(process.exitCode).toBe(7);
    const rendered = errorLog.mock.calls.flat().join(' ');
    expect(rendered).toContain('invalid proxy URL');
    expect(rendered).not.toContain('do-not-leak');
  });

  it('wraps unclassified failures without exposing raw errors or stack traces', async () => {
    configMocks.listConfig.mockImplementation(() => {
      throw new Error('storage failed password=do-not-leak');
    });
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    const dimLog = vi.spyOn(log, 'dim').mockImplementation(() => {});

    await programForConfig().parseAsync(['node', 'stealth', 'config', 'list']);

    expect(process.exitCode).toBe(1);
    const rendered = [...errorLog.mock.calls, ...dimLog.mock.calls].flat().join(' ');
    expect(rendered).toContain('Failed to read global configuration');
    expect(rendered).not.toContain('do-not-leak');
  });

  it('classifies filesystem failures as persistence errors without exposing the raw cause', async () => {
    const storageError = new Error('write failed password=do-not-leak');
    storageError.code = 'ENOSPC';
    storageError.syscall = 'write';
    configMocks.resetConfig.mockImplementation(() => {
      throw storageError;
    });
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    const dimLog = vi.spyOn(log, 'dim').mockImplementation(() => {});

    await programForConfig().parseAsync(['node', 'stealth', 'config', 'reset']);

    expect(process.exitCode).toBe(8);
    const rendered = [...errorLog.mock.calls, ...dimLog.mock.calls].flat().join(' ');
    expect(rendered).toContain('Failed to reset global configuration (ENOSPC during write)');
    expect(rendered).not.toContain('do-not-leak');
  });

  it('masks proxy userinfo in set confirmation output', async () => {
    const proxy = 'http://api-token:proxy-secret@proxy.example:8080';
    configMocks.setConfigValue.mockReturnValue(proxy);
    const success = vi.spyOn(log, 'success').mockImplementation(() => {});

    await programForConfig().parseAsync([
      'node',
      'stealth',
      'config',
      'set',
      'proxy',
      proxy,
    ]);

    expect(success).toHaveBeenCalledWith('proxy = http://****@proxy.example:8080');
  });
});

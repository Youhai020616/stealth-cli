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
import { log } from '../../src/output.js';

function programForConfig() {
  const program = new Command();
  program.exitOverride();
  registerConfig(program);
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
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

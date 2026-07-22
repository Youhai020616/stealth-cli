import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const proxyMocks = vi.hoisted(() => ({
  addProxy: vi.fn(),
  removeProxy: vi.fn(),
  listProxies: vi.fn(),
  testProxy: vi.fn(),
  testAllProxies: vi.fn(),
  poolSize: vi.fn(),
}));
const spinner = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
spinner.start.mockReturnValue(spinner);

vi.mock('../../src/proxy-pool.js', () => proxyMocks);
vi.mock('ora', () => ({ default: vi.fn(() => spinner) }));

import { registerProxy } from '../../src/commands/proxy.js';
import { log } from '../../src/output.js';

function programForProxy() {
  const program = new Command();
  program.exitOverride();
  registerProxy(program);
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
  spinner.start.mockReturnValue(spinner);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('proxy command failures', () => {
  it('routes a negative single test through handleError with code 7', async () => {
    proxyMocks.testProxy.mockResolvedValue({
      ok: false,
      error: 'Proxy authentication rejected by upstream',
      proxy: 'http://****@proxy.example:8080',
    });
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    const hintLog = vi.spyOn(log, 'dim').mockImplementation(() => {});

    await programForProxy().parseAsync([
      'node',
      'stealth',
      'proxy',
      'test',
      'http://user:secret@proxy.example:8080',
    ]);

    expect(process.exitCode).toBe(7);
    expect(errorLog).toHaveBeenCalledWith('Proxy authentication rejected by upstream');
    expect(hintLog.mock.calls.flat().join(' ')).toContain('stealth proxy test');
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain('secret');
  });

  it('routes aggregate test failures through one typed summary error', async () => {
    proxyMocks.poolSize.mockReturnValue(2);
    proxyMocks.testAllProxies.mockResolvedValue([
      { ok: true, proxy: 'http://good.example:8080', ip: '203.0.113.1', latency: 10 },
      { ok: false, proxy: 'http://****@bad.example:8080', error: 'failed' },
    ]);
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.spyOn(log, 'success').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(log, 'dim').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await programForProxy().parseAsync(['node', 'stealth', 'proxy', 'test']);

    expect(process.exitCode).toBe(7);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith('1 of 2 proxy tests failed');
  });
});

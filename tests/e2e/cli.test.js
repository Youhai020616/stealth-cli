import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', '..', 'bin', 'stealth.js');

function run(args, opts = {}) {
  const timeout = opts.timeout || 60000;
  try {
    const result = execFileSync('node', [CLI, ...args], {
      timeout,
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
    };
  }
}

describe('CLI integration', () => {
  it('should show help', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('Anti-detection browser CLI');
    expect(stdout).toContain('browse');
    expect(stdout).toContain('screenshot');
    expect(stdout).toContain('search');
  });

  it('should show version', () => {
    const { stdout } = run(['--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should show profile presets', () => {
    const { stdout } = run(['profile', 'presets']);
    expect(stdout).toContain('us-desktop');
    expect(stdout).toContain('jp-desktop');
  });

  it('should show config list', () => {
    const { stdout } = run(['config', 'list']);
    expect(stdout).toContain('locale');
    expect(stdout).toContain('headless');
    expect(stdout).toContain('timeout');
  });

  it('should show daemon status', () => {
    // daemon status outputs to stderr via log.info
    // execFileSync only captures stdout; just verify it doesn't crash
    const { exitCode } = run(['daemon', 'status']);
    expect(exitCode).toBe(0);
  });

  it('should show mcp tools list', () => {
    const { stdout } = run(['mcp', '--list-tools']);
    expect(stdout).toContain('stealth_browse');
    expect(stdout).toContain('stealth_search');
    expect(stdout).toContain('stealth_screenshot');
  });

  it('should error on unknown command', () => {
    const { stdout, stderr, exitCode } = run(['nonexistent']);
    const combined = stdout + stderr;
    expect(combined).toContain('unknown command');
  });
});

describe('CLI browse (e2e)', () => {
  it('should browse example.com and return text', () => {
    const { stdout } = run(['browse', 'https://example.com']);
    expect(stdout).toContain('Example Domain');
  }, 60000);

  it('should browse with JSON format', () => {
    const { stdout } = run(['browse', 'https://example.com', '-f', 'json']);
    const data = JSON.parse(stdout);
    expect(data.url).toBe('https://example.com/');
    expect(data.title).toBe('Example Domain');
    expect(data.userAgent).toContain('Firefox');
  }, 60000);
});

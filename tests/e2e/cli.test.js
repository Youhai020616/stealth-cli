import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', '..', 'bin', 'stealth.js');
const TEST_STEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-cli-e2e-'));

afterAll(() => {
  fs.rmSync(TEST_STEALTH_HOME, { recursive: true, force: true });
});

function run(args, opts = {}) {
  const timeout = opts.timeout || 60000;
  try {
    const result = execFileSync('node', [CLI, ...args], {
      timeout,
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        STEALTH_HOME: TEST_STEALTH_HOME,
        ...opts.env,
      },
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
    expect(stdout).toContain('open');
  });

  it('should expose headed open and interactive persistence options', () => {
    const openHelp = run(['open', '--help']).stdout;
    const interactiveHelp = run(['interactive', '--help']).stdout;

    expect(openHelp).toContain('headed browser');
    expect(openHelp).toContain('--profile');
    expect(openHelp).toContain('--session');
    expect(openHelp).toContain('--checkpoint-interval');
    expect(interactiveHelp).toContain('--profile');
    expect(interactiveHelp).toContain('--session');
  });

  it('should fail before launch for a missing explicit profile', () => {
    const { stderr, exitCode } = run([
      'open',
      '--profile',
      '__missing_profile_for_cli_test__',
    ]);

    expect(exitCode).toBe(8);
    expect(stderr).toContain('not found');
  });

  it('should sanitize malformed global config errors at the top-level boundary', () => {
    const home = fs.mkdtempSync(path.join(TEST_STEALTH_HOME, 'malformed-config-home-'));
    const configDirectory = path.join(home, '.stealth');
    const username = 'cli-config-user';
    const password = 'cli-config-password';
    fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(configDirectory, 'config.json'),
      `{"proxy":"http://${username}:${password}@proxy.example:8080",\n`,
      { mode: 0o600 },
    );

    const result = run(['browse', 'https://example.com'], {
      env: { HOME: home },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Global configuration file contains malformed JSON');
    expect(result.stderr).toContain('Hint: Fix or remove the configuration file');
    expect(result.stderr).not.toMatch(/\n\s*at\s/u);
    expect(result.stderr).not.toContain('SyntaxError');
    expect(result.stderr).not.toContain('file://');
    expect(result.stderr).not.toContain('[cause]');
    expect(result.stderr).not.toContain(username);
    expect(result.stderr).not.toContain(password);
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

  it('should use exit code 8 for profile create/show/delete failures', () => {
    const create = run(['profile', 'create', 'CON']);
    const show = run(['profile', 'show', '__missing_profile_for_show__']);
    const remove = run(['profile', 'delete', '__missing_profile_for_delete__']);

    expect(create.exitCode).toBe(8);
    expect(create.stderr).toContain('reserved Windows device basename');
    expect(show.exitCode).toBe(8);
    expect(show.stderr).toContain('not found');
    expect(remove.exitCode).toBe(8);
    expect(remove.stderr).toContain('not found');
  });

  it('should redact durable credentials from profile show output', () => {
    const name = '__safe_profile_show__';
    const proxy = 'HTTP://api-token:proxy-secret@proxy.example:8080';
    const created = run(['profile', 'create', name, '--preset', 'us-desktop', '--proxy', proxy]);
    expect(created.exitCode).toBe(0);

    const profilePath = path.join(TEST_STEALTH_HOME, 'profiles', `${name}.json`);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profile.cookies = [{
      name: 'sid',
      value: 'cookie-secret',
      domain: 'example.com',
      path: '/',
    }];
    fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });

    const shown = run(['profile', 'show', name]);
    const displayed = JSON.parse(shown.stdout);
    expect(shown.exitCode).toBe(0);
    expect(displayed.proxy).toBe('http://****@proxy.example:8080');
    expect(displayed.cookieCount).toBe(1);
    expect(displayed).not.toHaveProperty('cookies');
    expect(shown.stdout).not.toContain('api-token');
    expect(shown.stdout).not.toContain('proxy-secret');
    expect(shown.stdout).not.toContain('cookie-secret');
  });

  it('should use proxy exit code 7 without echoing invalid credentials', () => {
    const result = run([
      'proxy',
      'add',
      'HTTP://user:do-not-leak@proxy.example:8080/private',
    ]);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).not.toContain('user');
    expect(result.stderr).not.toContain('do-not-leak');
  });

  it('should catch profile list storage failures with exit code 8', () => {
    const invalidHome = path.join(TEST_STEALTH_HOME, 'not-a-directory');
    fs.writeFileSync(invalidHome, 'not a directory', { mode: 0o600 });

    const { stderr, exitCode } = run(['profile', 'list'], {
      env: { STEALTH_HOME: invalidHome },
    });

    expect(exitCode).toBe(8);
    expect(stderr).toContain('profile storage');
  });

  it('should display actual per-profile error labels', () => {
    const labelHome = path.join(TEST_STEALTH_HOME, 'profile-labels');
    const profilesDir = path.join(labelHome, 'profiles');
    fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profilesDir, 'broken.json'), '{not json}\n', { mode: 0o600 });
    fs.mkdirSync(path.join(profilesDir, 'unsafe.json'), { mode: 0o700 });

    const { stdout, exitCode } = run(['profile', 'list'], {
      env: { STEALTH_HOME: labelHome },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('broken');
    expect(stdout).toContain('corrupted');
    expect(stdout).toContain('unsafe');
    expect(stdout).toContain('unreadable');
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

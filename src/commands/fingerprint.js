/**
 * stealth fingerprint - Check browser fingerprint and anti-detection status
 */

import ora from 'ora';
import chalk from 'chalk';
import { launchBrowser, closeBrowser, navigate, evaluate, waitForReady } from '../browser.js';
import { log } from '../output.js';

export function registerFingerprint(program) {
  program
    .command('fingerprint')
    .description('Check browser fingerprint and anti-detection status')
    .option('--profile <name>', 'Use a browser profile')
    .option('--proxy <proxy>', 'Proxy server')
    .option('--json', 'Output as JSON')
    .option('--check', 'Run anti-detection tests against bot detection sites')
    .option('--compare <n>', 'Launch N times and compare fingerprints for uniqueness', '1')
    .option('--no-headless', 'Show browser window')
    .action(async (opts) => {
      const compareCount = parseInt(opts.compare);

      if (compareCount > 1) {
        await compareFingerprints(compareCount, opts);
        return;
      }

      if (opts.check) {
        await runDetectionTests(opts);
        return;
      }

      // Default: show current fingerprint
      await showFingerprint(opts);
    });
}

async function showFingerprint(opts) {
  const spinner = ora('Collecting fingerprint...').start();
  let handle;

  try {
    handle = await launchBrowser({
      headless: opts.headless,
      profile: opts.profile,
      proxy: opts.proxy,
    });

    if (handle.isDaemon) {
      spinner.stop();
      log.error('Fingerprint check requires direct mode');
      process.exit(1);
    }

    await navigate(handle, 'about:blank');

    const fp = await evaluate(handle, `(() => {
      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory || 'N/A',
        maxTouchPoints: navigator.maxTouchPoints,
        cookieEnabled: navigator.cookieEnabled,
        doNotTrack: navigator.doNotTrack,
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenColorDepth: screen.colorDepth,
        screenPixelDepth: screen.pixelDepth,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        timezoneOffset: new Date().getTimezoneOffset(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        webdriver: navigator.webdriver,
        pdfViewerEnabled: navigator.pdfViewerEnabled,
      };
    })()`);

    // WebGL info
    const webgl = await evaluate(handle, `(() => {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return { renderer: 'N/A', vendor: 'N/A' };
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'hidden',
          vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'hidden',
        };
      } catch { return { renderer: 'error', vendor: 'error' }; }
    })()`);

    spinner.stop();

    if (opts.json) {
      console.log(JSON.stringify({ ...fp, webgl }, null, 2));
      return;
    }

    console.log(chalk.bold('\n  🦊 Browser Fingerprint\n'));

    const print = (label, value, warn) => {
      const icon = warn ? chalk.yellow('⚠') : chalk.green('✓');
      console.log(`  ${icon} ${chalk.dim(label.padEnd(22))} ${value}`);
    };

    print('User-Agent', fp.userAgent);
    print('Platform', fp.platform);
    print('Language', `${fp.language} [${fp.languages?.join(', ')}]`);
    print('Timezone', `${fp.timezone} (offset: ${fp.timezoneOffset})`);
    print('Screen', `${fp.screenWidth}x${fp.screenHeight} @${fp.devicePixelRatio}x`);
    print('Viewport', `${fp.innerWidth}x${fp.innerHeight}`);
    print('Color Depth', `${fp.screenColorDepth}bit`);
    print('CPU Cores', fp.hardwareConcurrency);
    print('Memory', `${fp.deviceMemory}GB`);
    print('Touch Points', fp.maxTouchPoints);
    print('WebGL Renderer', webgl.renderer);
    print('WebGL Vendor', webgl.vendor);
    print('WebDriver', fp.webdriver ? chalk.red('true (DETECTED!)') : 'false', fp.webdriver);
    print('Do Not Track', fp.doNotTrack || 'unset');
    print('Cookies', fp.cookieEnabled ? 'enabled' : 'disabled');

    console.log();

    if (fp.webdriver) {
      log.warn('navigator.webdriver is true — this is a detection flag!');
    } else {
      log.success('No obvious detection flags found');
    }
    console.log();
  } catch (err) {
    spinner.stop();
    log.error(`Fingerprint check failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (handle) await closeBrowser(handle);
  }
}

async function runDetectionTests(opts) {
  const spinner = ora('Running anti-detection tests...').start();
  let handle;

  const tests = [
    {
      name: 'Bot Detection (CreepJS)',
      url: 'https://abrahamjuliot.github.io/creepjs/',
      check: async (page) => {
        await page.waitForTimeout(5000);
        const score = await page.$eval('#fingerprint-data .visitor-info', (el) => el.textContent).catch(() => null);
        return { score: score || 'Unable to extract — check manually' };
      },
    },
    {
      name: 'WebDriver Detection',
      url: 'about:blank',
      check: async (page) => {
        const webdriver = await page.evaluate(() => navigator.webdriver);
        return {
          detected: webdriver,
          status: webdriver ? 'FAIL — navigator.webdriver is true' : 'PASS',
        };
      },
    },
    {
      name: 'Browser Fingerprint Consistency',
      url: 'about:blank',
      check: async (page) => {
        const data = await page.evaluate(() => {
          const ua = navigator.userAgent;
          const platform = navigator.platform;
          const isWindows = ua.includes('Windows');
          const isMac = ua.includes('Macintosh');
          const isLinux = ua.includes('Linux');

          const platformMatch =
            (isWindows && platform.startsWith('Win')) ||
            (isMac && platform.startsWith('Mac')) ||
            (isLinux && platform.startsWith('Linux'));

          return { ua: ua.slice(0, 60), platform, consistent: platformMatch };
        });
        return {
          ...data,
          status: data.consistent ? 'PASS — UA matches platform' : 'WARN — UA/platform mismatch',
        };
      },
    },
  ];

  try {
    handle = await launchBrowser({
      headless: opts.headless,
      profile: opts.profile,
      proxy: opts.proxy,
    });

    if (handle.isDaemon) {
      spinner.stop();
      log.error('Detection tests require direct mode');
      process.exit(1);
    }

    spinner.stop();
    console.log(chalk.bold('\n  🔍 Anti-Detection Test Results\n'));

    const results = [];

    for (const test of tests) {
      process.stderr.write(chalk.dim(`  Testing: ${test.name}...`));
      try {
        await handle.page.goto(test.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await waitForReady(handle.page, { timeout: 3000 });
        const result = await test.check(handle.page);
        results.push({ name: test.name, ...result });

        const icon = result.status?.startsWith('PASS') ? chalk.green(' ✓') :
          result.status?.startsWith('FAIL') ? chalk.red(' ✗') : chalk.yellow(' ⚠');
        console.log(`\r  ${icon} ${chalk.bold(test.name)}`);

        for (const [key, val] of Object.entries(result)) {
          console.log(chalk.dim(`      ${key}: ${val}`));
        }
      } catch (err) {
        console.log(`\r  ${chalk.red('✗')} ${test.name}: ${err.message}`);
        results.push({ name: test.name, error: err.message });
      }
    }

    console.log();

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    }
  } catch (err) {
    spinner.stop();
    log.error(`Detection tests failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (handle) await closeBrowser(handle);
  }
}

async function compareFingerprints(count, opts) {
  const spinner = ora(`Comparing ${count} fingerprint launches...`).start();
  const fingerprints = [];

  for (let i = 0; i < count; i++) {
    spinner.text = `Launch ${i + 1}/${count}...`;
    let handle;
    try {
      handle = await launchBrowser({
        headless: opts.headless,
        profile: opts.profile,
      });

      if (handle.isDaemon) {
        spinner.stop();
        log.error('Compare requires direct mode');
        process.exit(1);
      }

      const fp = await evaluate(handle, `(() => ({
        ua: navigator.userAgent,
        platform: navigator.platform,
        cores: navigator.hardwareConcurrency,
        memory: navigator.deviceMemory,
        screen: screen.width + 'x' + screen.height,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        lang: navigator.language,
        webdriver: navigator.webdriver,
      }))()`);

      fingerprints.push(fp);
    } finally {
      if (handle) await closeBrowser(handle);
    }
  }

  spinner.stop();

  console.log(chalk.bold(`\n  Fingerprint Comparison (${count} launches)\n`));

  // Check which fields differ
  const fields = Object.keys(fingerprints[0]);
  for (const field of fields) {
    const values = fingerprints.map((fp) => String(fp[field]));
    const unique = [...new Set(values)];
    const icon = unique.length > 1 ? chalk.green('✓ varies') : chalk.yellow('= same');
    console.log(`  ${icon}  ${chalk.dim(field.padEnd(12))} ${unique.join(' | ')}`);
  }

  console.log();
  const varyingFields = fields.filter((f) => new Set(fingerprints.map((fp) => String(fp[f]))).size > 1);
  if (varyingFields.length > 0) {
    log.success(`${varyingFields.length}/${fields.length} fields vary between launches — good fingerprint rotation`);
  } else {
    log.warn('All fields identical — fingerprints are not rotating');
  }
  console.log();
}

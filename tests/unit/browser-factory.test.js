import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('camoufox-js', () => ({
  launchOptions: vi.fn(async (options) => options),
}));

vi.mock('playwright-core', () => ({
  firefox: { launch: vi.fn(async (options) => ({ options })) },
}));

import { launchOptions } from 'camoufox-js';
import { firefox } from 'playwright-core';
import { createBrowser, getHostOS, extractPageText } from '../../src/utils/browser-factory.js';

describe('browser-factory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getHostOS should return valid OS string', () => {
    const os = getHostOS();
    expect(['macos', 'windows', 'linux']).toContain(os);
  });

  it('extractPageText should be a function', () => {
    expect(typeof extractPageText).toBe('function');
  });

  it('extractPageText source should reference DOM APIs', () => {
    const src = extractPageText.toString();
    expect(src).toContain('cloneNode');
    expect(src).toContain('script');
    expect(src).toContain('innerText');
  });

  it('should disable Playwright signal handlers for lifecycle-managed browsers', async () => {
    await createBrowser({ headless: false, os: 'linux', handleSignals: false });

    expect(launchOptions).toHaveBeenCalledWith(expect.objectContaining({
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    }));
    expect(firefox.launch).toHaveBeenCalledOnce();
  });
});

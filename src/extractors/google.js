/**
 * Google Search extractor
 *
 * Strategy:
 *   1. Navigate to google.com homepage first (not direct search URL)
 *   2. Type query into search box like a human
 *   3. Wait for async SERP rendering
 *   4. Extract structured results from multiple layout variants
 */

import { humanType, humanScroll, randomDelay } from '../humanize.js';

export const name = 'google';

export function canHandle(url) {
  return /google\.\w+\/search/.test(url);
}

/**
 * Perform Google search with human-like behavior
 * Instead of direct URL, simulates typing into search box
 *
 * @param {Page} page - Playwright page
 * @param {string} query - Search query
 * @returns {boolean} success
 */
export async function humanSearch(page, query) {
  // Step 1: Visit Google homepage
  await page.goto('https://www.google.com', {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  });
  await randomDelay(800, 2000);

  // Step 2: Handle cookie consent (EU/UK)
  try {
    const consentBtn = page.locator(
      'button:has-text("Accept all"), button:has-text("Accept"), button:has-text("Agree"), button:has-text("I agree"), [id*="accept"], [aria-label*="Accept"]',
    );
    if (await consentBtn.first().isVisible({ timeout: 1500 })) {
      await consentBtn.first().click({ timeout: 2000 });
      await randomDelay(500, 1000);
    }
  } catch {}

  // Step 3: Type query with human timing
  try {
    await humanType(page, 'textarea[name="q"], input[name="q"]', query, {
      pressEnter: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for Google results to render (they load asynchronously)
 */
export async function waitForResults(page) {
  // Multiple selectors for different Google layouts
  const selectors = [
    '#rso h3',
    '#search h3',
    '#rso [data-snhf]',
    '#rso a[href]:not([href^="/search"])',
    '.g h3',
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      return;
    } catch {}
  }

  // Last resort: wait for any meaningful content
  await randomDelay(2000, 3000);
}

/**
 * Check if Google blocked us (CAPTCHA / sorry page)
 */
export function isBlocked(url) {
  return url.includes('/sorry/') || url.includes('consent.google') || url.includes('/recaptcha/');
}

/**
 * Extract Google search results
 */
export async function extractResults(page, maxResults = 10) {
  await waitForResults(page);

  return page.evaluate((max) => {
    const results = [];

    // Strategy 1: Standard search result cards
    const items = document.querySelectorAll(
      '#rso .g, #rso [data-sokoban-container], #rso [data-snhf], #search .g, .MjjYud',
    );

    for (const item of items) {
      if (results.length >= max) break;

      const linkEl = item.querySelector(
        'a[href]:not([href^="/search"]):not([href^="#"]):not([href*="google.com/search"])',
      );
      const titleEl = item.querySelector('h3');
      const snippetEl = item.querySelector(
        '[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"], .IsZvec, .lEBKkf',
      );

      if (linkEl && titleEl) {
        const href = linkEl.href;
        if (href && href.startsWith('http') && !href.includes('google.com/search')) {
          results.push({
            title: titleEl.textContent?.trim() || '',
            url: href,
            snippet: snippetEl?.textContent?.trim() || '',
          });
        }
      }
    }

    // Strategy 2: Fallback — look for any external links with headings
    if (results.length === 0) {
      const fallbackLinks = document.querySelectorAll('#rso a[href], #search a[href]');
      const seenUrls = new Set();

      for (const link of fallbackLinks) {
        if (results.length >= max) break;
        const href = link.href;
        if (
          href?.startsWith('http') &&
          !href.includes('google.') &&
          !href.includes('gstatic.') &&
          !seenUrls.has(href)
        ) {
          seenUrls.add(href);
          const heading = link.querySelector('h3, h2, [role="heading"]');
          const text = heading?.textContent?.trim() || link.textContent?.trim();
          if (text && text.length > 3) {
            results.push({ title: text.slice(0, 200), url: href, snippet: '' });
          }
        }
      }
    }

    return results;
  }, maxResults);
}

/**
 * Extract "People also ask" questions
 */
export async function extractPeopleAlsoAsk(page, maxResults = 5) {
  return page.evaluate((max) => {
    const questions = [];
    const items = document.querySelectorAll(
      '[data-sgrd] [role="button"], .related-question-pair, [jsname="Cpkphb"]',
    );

    for (const item of items) {
      if (questions.length >= max) break;
      const text = item.textContent?.trim();
      if (text && text.length > 10) {
        questions.push(text);
      }
    }

    return questions;
  }, maxResults);
}

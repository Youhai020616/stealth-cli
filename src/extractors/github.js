/**
 * GitHub Search extractor
 */

export const name = 'github';

export function canHandle(url) {
  return /github\.com\/search/.test(url);
}

export async function waitForResults(page) {
  const selectors = [
    '[data-testid="results-list"]',
    '.repo-list',
    '[data-testid="result"]',
    '.search-title',
    '.Box-row',                    // Modern GitHub search layout
    'div[data-testid="result"]',
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      return;
    } catch {}
  }

  // GitHub search can be slow, give it more time
  await new Promise((r) => setTimeout(r, 3000));
}

export async function extractResults(page, maxResults = 10) {
  await waitForResults(page);

  return page.evaluate((max) => {
    const results = [];

    // Modern GitHub search (React)
    const items = document.querySelectorAll(
      '[data-testid="results-list"] > div, .search-title, .repo-list-item, [data-testid="result"]',
    );

    for (const item of items) {
      if (results.length >= max) break;

      // Repository link — try multiple selectors
      const linkEl = item.querySelector(
        'a[href*="github.com/"]:has(.search-match), a.v-align-middle, a[data-testid="result-title-link"]',
      );

      if (linkEl) {
        const descEl = item.querySelector('p, .mb-1, [data-testid="result-description"]');
        const langEl = item.querySelector('[itemprop="programmingLanguage"], span.repo-language-color + span');
        const starsEl = item.querySelector('a[href*="/stargazers"], [aria-label*="star"]');
        const updatedEl = item.querySelector('relative-time, [datetime]');

        results.push({
          title: linkEl.textContent?.trim() || '',
          url: linkEl.href,
          description: descEl?.textContent?.trim() || '',
          language: langEl?.textContent?.trim() || '',
          stars: starsEl?.textContent?.trim() || '',
          updated: updatedEl?.getAttribute('datetime') || updatedEl?.textContent?.trim() || '',
        });
        continue;
      }

      // Fallback: any link to a repo pattern /user/repo
      const anyLink = item.querySelector('a[href*="github.com/"]');
      if (anyLink && anyLink.href.match(/github\.com\/[\w-]+\/[\w.-]+$/)) {
        const descEl = item.querySelector('p, .mb-1');
        results.push({
          title: anyLink.textContent?.trim() || '',
          url: anyLink.href,
          description: descEl?.textContent?.trim() || '',
        });
      }
    }

    // Strategy 2: Fallback — grab all repo-like links on the page
    if (results.length === 0) {
      const allLinks = document.querySelectorAll('a[href]');
      const seenUrls = new Set();
      for (const link of allLinks) {
        if (results.length >= max) break;
        const href = link.href;
        if (
          href?.match(/github\.com\/[\w-]+\/[\w.-]+$/) &&
          !href.includes('/search') &&
          !seenUrls.has(href)
        ) {
          seenUrls.add(href);
          const text = link.textContent?.trim();
          if (text && text.length > 2 && text.includes('/')) {
            results.push({ title: text, url: href, description: '' });
          }
        }
      }
    }

    return results;
  }, maxResults);
}

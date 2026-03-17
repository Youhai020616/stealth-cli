/**
 * DuckDuckGo Search extractor
 */

export const name = 'duckduckgo';

export function canHandle(url) {
  return /duckduckgo\.com/.test(url);
}

export async function waitForResults(page) {
  const selectors = [
    '[data-result="web"]',
    'article[data-testid="result"]',
    '.result--web',
    'ol.react-results--main li',
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      return;
    } catch {}
  }
}

export async function extractResults(page, maxResults = 10) {
  await waitForResults(page);

  return page.evaluate((max) => {
    const results = [];

    // Modern DuckDuckGo layout (React-based)
    const items = document.querySelectorAll(
      'article[data-testid="result"], [data-result="web"], .result--web, ol.react-results--main > li',
    );

    for (const item of items) {
      if (results.length >= max) break;

      // Multiple title selectors for different DDG versions
      const linkEl = item.querySelector(
        'a[data-testid="result-title-a"], h2 a[href], a.result__a, a[href]:has(h2)',
      );
      const snippetEl = item.querySelector(
        '[data-testid="result-snippet"], .result__snippet, .E2eLOJr8HctVnDOTM8fs, span.kY2IgmnCmOGjharHErah',
      );
      const urlEl = item.querySelector(
        '[data-testid="result-extras-url-link"], .result__url, a.result__check',
      );

      if (linkEl) {
        const href = linkEl.href;
        const title = linkEl.textContent?.trim();
        if (href?.startsWith('http') && !href.includes('duckduckgo.com') && title) {
          results.push({
            title,
            url: href,
            snippet: snippetEl?.textContent?.trim() || '',
            displayUrl: urlEl?.textContent?.trim() || '',
          });
        }
      }
    }

    // Fallback: extract from any visible links in the results area
    if (results.length === 0) {
      const seenUrls = new Set();
      const links = document.querySelectorAll(
        '#links a[href], .results a[href], [data-testid="mainline"] a[href]',
      );

      for (const link of links) {
        if (results.length >= max) break;
        const href = link.href;
        const text = link.textContent?.trim();
        if (
          href?.startsWith('http') &&
          !href.includes('duckduckgo.com') &&
          text?.length > 5 &&
          !seenUrls.has(href)
        ) {
          seenUrls.add(href);
          results.push({ title: text.slice(0, 200), url: href, snippet: '' });
        }
      }
    }

    return results;
  }, maxResults);
}

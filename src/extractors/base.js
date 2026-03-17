/**
 * Base extractor — generic fallback for any search page
 */

export const name = 'generic';

/**
 * Check if this extractor can handle the given URL
 */
export function canHandle() {
  return true; // Fallback — always matches
}

/**
 * Wait for search results to render
 */
export async function waitForResults(page) {
  try {
    await page.waitForSelector(
      'h2 a[href], h3 a[href], li a[href], article a[href], .result a[href]',
      { timeout: 5000 },
    );
  } catch {}
}

/**
 * Extract search results
 */
export async function extractResults(page, maxResults = 10) {
  await waitForResults(page);

  return page.evaluate((max) => {
    const results = [];
    const candidates = document.querySelectorAll(
      'h2 a[href], h3 a[href], li a[href], article a[href], .result a[href]',
    );
    const seenUrls = new Set();

    for (const link of candidates) {
      if (results.length >= max) break;
      const href = link.href;
      const text = link.textContent?.trim();

      if (href?.startsWith('http') && text?.length > 3 && !seenUrls.has(href)) {
        seenUrls.add(href);
        const parent = link.closest('li, article, div, .result');
        const snippetEl = parent?.querySelector('p, .snippet, .description, span:not(:has(a))');

        results.push({
          title: text.slice(0, 200),
          url: href,
          snippet: snippetEl?.textContent?.trim().slice(0, 300) || '',
        });
      }
    }

    return results;
  }, maxResults);
}

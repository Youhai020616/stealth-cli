/**
 * Bing Search extractor
 */

export const name = 'bing';

export function canHandle(url) {
  return /bing\.com\/search/.test(url);
}

export async function waitForResults(page) {
  try {
    await page.waitForSelector('#b_results .b_algo, .b_algo', { timeout: 5000 });
  } catch {}
}

export async function extractResults(page, maxResults = 10) {
  await waitForResults(page);

  return page.evaluate((max) => {
    const results = [];
    const items = document.querySelectorAll('#b_results .b_algo, .b_algo');

    for (const item of items) {
      if (results.length >= max) break;

      const linkEl = item.querySelector('h2 a[href]');
      const snippetEl = item.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3');
      const urlEl = item.querySelector('cite, .b_attribution cite');

      if (linkEl) {
        const href = linkEl.href;
        const title = linkEl.textContent?.trim();
        if (href?.startsWith('http') && title) {
          results.push({
            title,
            url: href,
            snippet: snippetEl?.textContent?.trim() || '',
            displayUrl: urlEl?.textContent?.trim() || '',
          });
        }
      }
    }

    return results;
  }, maxResults);
}

/**
 * YouTube Search extractor
 */

export const name = 'youtube';

export function canHandle(url) {
  return /youtube\.com\/results/.test(url);
}

export async function waitForResults(page) {
  try {
    await page.waitForSelector(
      'ytd-video-renderer, ytd-channel-renderer, #contents ytd-item-section-renderer',
      { timeout: 6000 },
    );
  } catch {}

  // YouTube loads results dynamically; give extra time
  await new Promise((r) => setTimeout(r, 1500));
}

export async function extractResults(page, maxResults = 10) {
  await waitForResults(page);

  return page.evaluate((max) => {
    const results = [];

    // Video renderers
    const items = document.querySelectorAll(
      'ytd-video-renderer, ytd-channel-renderer, ytd-playlist-renderer',
    );

    for (const item of items) {
      if (results.length >= max) break;

      const isChannel = item.tagName === 'YTD-CHANNEL-RENDERER';
      const isPlaylist = item.tagName === 'YTD-PLAYLIST-RENDERER';

      // Video title link
      const titleLink = item.querySelector(
        'a#video-title, h3 a, a.channel-link, a[href*="/watch"], a[href*="/playlist"]',
      );
      if (!titleLink) continue;

      const title = titleLink.textContent?.trim() || titleLink.getAttribute('title') || '';
      const url = titleLink.href;

      if (!url || !title) continue;

      // Channel name
      const channelEl = item.querySelector(
        'ytd-channel-name a, .ytd-channel-name a, #channel-info a, #text.ytd-channel-name',
      );

      // View count and upload date
      const metaItems = item.querySelectorAll(
        '#metadata-line span, .inline-metadata-item, .ytd-video-meta-block span',
      );
      const views = metaItems[0]?.textContent?.trim() || '';
      const uploadDate = metaItems[1]?.textContent?.trim() || '';

      // Duration
      const durationEl = item.querySelector(
        'span.ytd-thumbnail-overlay-time-status-renderer, badge-shape .badge-shape-wiz__text',
      );

      // Thumbnail
      const thumbEl = item.querySelector('img#img, ytd-thumbnail img');

      const result = {
        type: isChannel ? 'channel' : isPlaylist ? 'playlist' : 'video',
        title,
        url,
        channel: channelEl?.textContent?.trim() || '',
        views,
        uploadDate,
        duration: durationEl?.textContent?.trim() || '',
        thumbnail: thumbEl?.src || '',
      };

      results.push(result);
    }

    return results;
  }, maxResults);
}

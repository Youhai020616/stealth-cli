/**
 * Extractor registry — auto-selects the best extractor for a URL/engine
 */

import * as google from './google.js';
import * as duckduckgo from './duckduckgo.js';
import * as bing from './bing.js';
import * as github from './github.js';
import * as youtube from './youtube.js';
import * as base from './base.js';

const extractors = [google, duckduckgo, bing, github, youtube];

// Map engine names to extractors
const engineMap = {
  google: google,
  duckduckgo: duckduckgo,
  bing: bing,
  github: github,
  youtube: youtube,
};

/**
 * Get the best extractor for a given engine name
 *
 * @param {string} engine - Engine name (google, bing, etc.)
 * @returns {object} Extractor module
 */
export function getExtractorByEngine(engine) {
  return engineMap[engine.toLowerCase()] || base;
}

/**
 * Get the best extractor for a given URL
 *
 * @param {string} url - Page URL
 * @returns {object} Extractor module
 */
export function getExtractorByUrl(url) {
  for (const extractor of extractors) {
    if (extractor.canHandle(url)) {
      return extractor;
    }
  }
  return base;
}

/**
 * List all available extractors
 */
export function listExtractors() {
  return [...extractors.map((e) => e.name), base.name];
}

export { google, duckduckgo, bing, github, youtube, base };

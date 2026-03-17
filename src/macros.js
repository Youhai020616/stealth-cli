/**
 * Search macros - URL templates for common search engines and sites
 * Inspired by camofox-browser (MIT License)
 */

const MACROS = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  amazon: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  reddit: (q) => `https://www.reddit.com/search?q=${encodeURIComponent(q)}`,
  wikipedia: (q) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
  twitter: (q) => `https://twitter.com/search?q=${encodeURIComponent(q)}`,
  yelp: (q) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(q)}`,
  linkedin: (q) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(q)}`,
  tiktok: (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`,
  stackoverflow: (q) => `https://stackoverflow.com/search?q=${encodeURIComponent(q)}`,
  npmjs: (q) => `https://www.npmjs.com/search?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
};

/**
 * Expand a search macro to a URL
 */
export function expandMacro(engine, query) {
  const fn = MACROS[engine.toLowerCase()];
  return fn ? fn(query) : null;
}

/**
 * Get list of supported search engines
 */
export function getSupportedEngines() {
  return Object.keys(MACROS);
}

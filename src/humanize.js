/**
 * Human behavior simulation — makes browser automation less detectable
 */

/**
 * Random delay between min and max ms
 */
export function randomDelay(min = 200, max = 800) {
  const delay = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Simulate human-like scrolling pattern
 * - Variable speed
 * - Occasional pauses
 * - Sometimes scroll back up slightly
 */
export async function humanScroll(page, opts = {}) {
  const { scrolls = 3, direction = 'down' } = opts;

  for (let i = 0; i < scrolls; i++) {
    // Variable scroll amount (200-600px)
    const amount = 200 + Math.random() * 400;
    const delta = direction === 'up' ? -amount : amount;

    await page.mouse.wheel(0, delta);

    // Random pause between scrolls (300-1200ms)
    await randomDelay(300, 1200);

    // 20% chance to scroll back slightly (human-like hesitation)
    if (Math.random() < 0.2 && i < scrolls - 1) {
      const backAmount = 50 + Math.random() * 100;
      await page.mouse.wheel(0, -backAmount * Math.sign(delta));
      await randomDelay(200, 500);
    }
  }
}

/**
 * Move mouse along a bezier curve (more natural than straight line)
 */
export async function humanMouseMove(page, targetX, targetY, opts = {}) {
  const { steps = 15 } = opts;

  // Get current or random starting position
  const startX = 100 + Math.random() * 400;
  const startY = 100 + Math.random() * 300;

  // Generate control points for bezier curve
  const cp1x = startX + (targetX - startX) * 0.3 + (Math.random() - 0.5) * 100;
  const cp1y = startY + (targetY - startY) * 0.1 + (Math.random() - 0.5) * 100;
  const cp2x = startX + (targetX - startX) * 0.7 + (Math.random() - 0.5) * 80;
  const cp2y = startY + (targetY - startY) * 0.9 + (Math.random() - 0.5) * 80;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // Cubic bezier interpolation
    const x = cubicBezier(t, startX, cp1x, cp2x, targetX);
    const y = cubicBezier(t, startY, cp1y, cp2y, targetY);

    await page.mouse.move(x, y);

    // Variable speed: slower at start and end (ease-in-out)
    const speedFactor = Math.sin(t * Math.PI); // 0→1→0
    const delay = 5 + (1 - speedFactor) * 15;
    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * Type text with human-like timing
 * - Variable delay between keystrokes
 * - Occasional longer pauses (thinking)
 * - Optionally make typos and correct them
 */
export async function humanType(page, selector, text, opts = {}) {
  const { typoRate = 0, pressEnter = false } = opts;

  // Click the input first
  await page.click(selector, { timeout: 5000 });
  await randomDelay(200, 500);

  // Clear existing content
  await page.fill(selector, '');
  await randomDelay(100, 300);

  // Type character by character
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Simulate typo (if enabled)
    if (typoRate > 0 && Math.random() < typoRate) {
      // Type wrong character
      const wrongChar = String.fromCharCode(char.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1));
      await page.keyboard.type(wrongChar, { delay: 30 + Math.random() * 50 });
      await randomDelay(100, 300);

      // Delete it
      await page.keyboard.press('Backspace');
      await randomDelay(50, 150);
    }

    // Type correct character
    await page.keyboard.type(char, { delay: 30 + Math.random() * 80 });

    // Occasional longer pause (thinking / reading)
    if (Math.random() < 0.05) {
      await randomDelay(300, 800);
    }
  }

  if (pressEnter) {
    await randomDelay(300, 600);
    await page.keyboard.press('Enter');
  }
}

/**
 * Simulate human click with mouse movement
 */
export async function humanClick(page, selector, opts = {}) {
  const { timeout = 5000 } = opts;

  const element = page.locator(selector);
  const box = await element.boundingBox({ timeout });

  if (!box) {
    // Fallback to regular click
    await element.click({ timeout });
    return;
  }

  // Move to element with slight offset (humans don't click exact center)
  const offsetX = (Math.random() - 0.5) * box.width * 0.4;
  const offsetY = (Math.random() - 0.5) * box.height * 0.3;
  const targetX = box.x + box.width / 2 + offsetX;
  const targetY = box.y + box.height / 2 + offsetY;

  await humanMouseMove(page, targetX, targetY);
  await randomDelay(50, 150);

  // Mouse down → small pause → mouse up (human click duration)
  await page.mouse.down();
  await randomDelay(30, 80);
  await page.mouse.up();
}

/**
 * Warmup routine - perform natural browsing actions before target URL
 * This helps establish a "normal" browsing fingerprint
 */
export async function warmup(page, opts = {}) {
  const { sites = null, scrollAfter = true } = opts;

  const defaultSites = [
    'https://www.wikipedia.org',
    'https://www.github.com',
    'https://news.ycombinator.com',
  ];

  const warmupSites = sites || defaultSites;

  // Pick 1 random warmup site
  const site = warmupSites[Math.floor(Math.random() * warmupSites.length)];

  try {
    await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await randomDelay(1000, 3000);

    if (scrollAfter) {
      await humanScroll(page, { scrolls: 2 });
    }

    // Random mouse movement
    await humanMouseMove(page, 300 + Math.random() * 600, 200 + Math.random() * 400);
    await randomDelay(500, 1500);
  } catch {
    // Warmup failure is not critical
  }
}

/**
 * Post-navigation human behavior — run after page loads
 */
export async function postNavigationBehavior(page, opts = {}) {
  const { scroll = true, mouseMove = true, minDelay = 500, maxDelay = 1500 } = opts;

  // Wait a natural amount before interacting
  await randomDelay(minDelay, maxDelay);

  // Slight mouse movement (human looking at page)
  if (mouseMove) {
    await humanMouseMove(page, 300 + Math.random() * 600, 150 + Math.random() * 300);
  }

  // Natural scroll to show content loading
  if (scroll) {
    await humanScroll(page, { scrolls: 1 });
  }
}

// --- Math helpers ---

function cubicBezier(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

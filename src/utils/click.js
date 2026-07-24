/**
 * Click helpers for API/MCP automation.
 *
 * Playwright's pointer-based click can hang in Camoufox while performing the
 * low-level mouse action. For remote tool calls, a DOM click is the safer
 * semantic: verify the element exists, scroll it into view, then dispatch click
 * in the page context.
 */

export async function clickElement(page, selector, opts = {}) {
  const { timeout = 5000 } = opts;
  if (!selector) throw new Error('selector is required');

  await page.locator(selector).first().waitFor({ state: 'attached', timeout });

  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: `Element not found: ${sel}` };

    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    if (disabled) return { ok: false, error: `Element is disabled: ${sel}` };

    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }

    if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    }

    return { ok: true };
  }, selector);

  if (!result.ok) throw new Error(result.error);
}

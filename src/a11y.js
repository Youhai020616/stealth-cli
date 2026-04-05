/**
 * Accessibility tree with @ref element targeting
 *
 * Builds a structured accessibility tree of the page with [ref=eN] markers
 * on interactive elements. Agents can use these refs to click, type, and
 * interact with elements without needing CSS selectors.
 *
 * Design:
 *   1. page.evaluate() injects JS to traverse DOM
 *   2. Interactive elements get data-stealth-ref="eN" attributes
 *   3. Tree is rendered as indented text (Playwright MCP compatible format)
 *   4. Interaction by ref uses [data-stealth-ref="eN"] CSS selector
 */

// --- Role classification sets ---

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem',
  'option', 'treeitem', 'menuitemcheckbox', 'menuitemradio', 'listbox',
]);

const STRUCTURAL_ROLES = new Set([
  'heading', 'list', 'listitem', 'navigation', 'banner', 'main',
  'complementary', 'contentinfo', 'form', 'table', 'row', 'cell',
  'dialog', 'alert', 'alertdialog', 'article', 'region', 'group',
  'toolbar', 'menu', 'menubar', 'tablist', 'tabpanel', 'tree',
  'grid', 'separator', 'img', 'figure', 'status', 'progressbar',
  'meter', 'rowgroup', 'columnheader', 'rowheader', 'gridcell',
  'search', 'note', 'definition', 'term', 'feed', 'log',
  'directory', 'math', 'document',
]);

/**
 * JavaScript function injected into the page to build the accessibility tree.
 * Self-contained — no external dependencies, runs in browser context.
 *
 * @returns {{ tree: string, refs: Object<string, {role: string, name: string, tag: string}>, totalRefs: number }}
 */
const BUILD_A11Y_TREE = () => {
  let refCounter = 0;

  // --- Role sets (duplicated inside evaluate — cannot reference outer scope) ---

  const INTERACTIVE = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem',
    'option', 'treeitem', 'menuitemcheckbox', 'menuitemradio', 'listbox',
  ]);

  const STRUCTURAL = new Set([
    'heading', 'list', 'listitem', 'navigation', 'banner', 'main',
    'complementary', 'contentinfo', 'form', 'table', 'row', 'cell',
    'dialog', 'alert', 'alertdialog', 'article', 'region', 'group',
    'toolbar', 'menu', 'menubar', 'tablist', 'tabpanel', 'tree',
    'grid', 'separator', 'img', 'figure', 'status', 'progressbar',
    'meter', 'rowgroup', 'columnheader', 'rowheader', 'gridcell',
    'search', 'note', 'definition', 'term', 'feed', 'log',
    'directory', 'math', 'document',
  ]);

  // --- Implicit role mapping ---

  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : null;
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'h1': case 'h2': case 'h3':
      case 'h4': case 'h5': case 'h6': return 'heading';
      case 'input': {
        const m = {
          button: 'button', submit: 'button', reset: 'button', image: 'button',
          checkbox: 'checkbox', radio: 'radio', range: 'slider',
          number: 'spinbutton', search: 'searchbox',
        };
        return m[type] || 'textbox';
      }
      case 'textarea': return 'textbox';
      case 'select': return el.multiple ? 'listbox' : 'combobox';
      case 'option': return 'option';
      case 'img': return (el.getAttribute('alt') !== null || el.getAttribute('aria-label')) ? 'img' : null;
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'form': return 'form';
      case 'ul': case 'ol': return 'list';
      case 'li': return 'listitem';
      case 'table': return 'table';
      case 'tr': return 'row';
      case 'td': case 'th': return 'cell';
      case 'dialog': return 'dialog';
      case 'details': return 'group';
      case 'fieldset': return 'group';
      case 'article': return 'article';
      case 'section':
        return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) ? 'region' : null;
      case 'progress': return 'progressbar';
      case 'meter': return 'meter';
      case 'output': return 'status';
      case 'hr': return 'separator';
      case 'figure': return 'figure';
      case 'menu': return 'menu';
      case 'search': return 'search';
      default: return null;
    }
  }

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    return getImplicitRole(el);
  }

  // --- Accessible name computation (simplified W3C algorithm) ---

  function getAccessibleName(el) {
    // 1. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // 2. aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const texts = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (texts.length) return texts.join(' ');
    }

    const tag = el.tagName.toLowerCase();

    // 3. Input elements: associated label, placeholder, title
    if (['input', 'textarea', 'select'].includes(tag)) {
      if (el.id) {
        try {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) return label.textContent?.trim() || '';
        } catch { /* invalid id */ }
      }
      const parentLabel = el.closest('label');
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        clone.querySelectorAll('input, textarea, select').forEach(e => e.remove());
        const labelText = clone.textContent?.trim();
        if (labelText) return labelText;
      }
      if (el.placeholder) return el.placeholder;
      if (el.title) return el.title;
      return '';
    }

    // 4. Images: alt text
    if (tag === 'img') return el.getAttribute('alt') || '';

    // 5. Title attribute as fallback for elements without visible text
    if (el.title && !el.textContent?.trim()) return el.title;

    // 6. Descendant text content (for buttons, links, headings, etc.)
    const text = el.textContent?.trim();
    if (text) return text.slice(0, 100);

    return '';
  }

  // --- Visibility check ---

  function isVisible(el) {
    if (el.hidden) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    return true;
  }

  // --- Interactivity check ---

  function isInteractive(el, role) {
    if (INTERACTIVE.has(role)) return true;
    if (el.contentEditable === 'true' || el.contentEditable === 'plaintext-only') return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1' && !STRUCTURAL.has(role)) return true;
    return false;
  }

  // --- Tree traversal ---

  function traverse(el, depth) {
    if (!isVisible(el)) return [];

    const role = getRole(el);
    const interactive = role ? isInteractive(el, role) : false;

    // Assign ref for interactive elements
    let ref = null;
    if (interactive) {
      refCounter++;
      ref = `e${refCounter}`;
      el.setAttribute('data-stealth-ref', ref);
    }

    // Determine if this node should appear as a tree node
    const showNode = (role && (INTERACTIVE.has(role) || STRUCTURAL.has(role))) || ref;

    // Process children — if this node is shown, children indent one more level
    const childDepth = showNode ? depth + 1 : depth;
    const childLines = [];
    for (const child of el.children) {
      childLines.push(...traverse(child, childDepth));
    }

    // Transparent container: skip node, pass children through
    if (!showNode) return childLines;

    // Build node line
    const indent = '  '.repeat(depth);
    let line = `${indent}- ${role}`;

    const name = getAccessibleName(el);
    if (name) {
      const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      line += ` "${escaped.slice(0, 80)}"`;
    }

    // ARIA / HTML attributes
    const attrs = [];
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) attrs.push(`level=${tag[1]}`);
    if (el.checked) attrs.push('checked');
    if (el.disabled) attrs.push('disabled');
    if (el.required) attrs.push('required');
    if (el.readOnly) attrs.push('readonly');

    const expanded = el.getAttribute('aria-expanded');
    if (expanded !== null) attrs.push(`expanded=${expanded}`);
    const selected = el.getAttribute('aria-selected');
    if (selected !== null) attrs.push(`selected=${selected}`);
    const pressed = el.getAttribute('aria-pressed');
    if (pressed !== null) attrs.push(`pressed=${pressed}`);
    const value = el.getAttribute('aria-valuenow');
    if (value !== null) attrs.push(`value=${value}`);

    if (attrs.length) line += ` [${attrs.join(', ')}]`;
    if (ref) line += ` [ref=${ref}]`;

    if (childLines.length > 0) {
      return [line + ':', ...childLines];
    }
    return [line];
  }

  // Clear old refs from previous snapshots
  document.querySelectorAll('[data-stealth-ref]').forEach(el => {
    el.removeAttribute('data-stealth-ref');
  });

  const lines = traverse(document.body, 0);

  // Collect ref map from DOM (ground truth after traversal)
  const refs = {};
  document.querySelectorAll('[data-stealth-ref]').forEach(el => {
    const r = el.getAttribute('data-stealth-ref');
    refs[r] = {
      role: getRole(el) || el.tagName.toLowerCase(),
      name: getAccessibleName(el),
      tag: el.tagName.toLowerCase(),
    };
  });

  return { tree: lines.join('\n'), refs, totalRefs: refCounter };
};

// --- Public API ---

/**
 * Build accessibility tree with [ref=eN] markers on interactive elements.
 *
 * @param {import('playwright-core').Page} page - Playwright page
 * @returns {Promise<{ tree: string, refs: Object<string, {role: string, name: string, tag: string}>, totalRefs: number }>}
 */
export async function buildA11yTree(page) {
  return page.evaluate(BUILD_A11Y_TREE);
}

/**
 * Get CSS selector for a ref ID.
 *
 * @param {string} ref - Ref ID (e.g. "e3" or just "3")
 * @returns {string} CSS selector like [data-stealth-ref="e3"]
 */
export function refSelector(ref) {
  const id = ref.startsWith('e') ? ref : `e${ref}`;
  return `[data-stealth-ref="${id}"]`;
}

/**
 * Click element by ref.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} ref - Ref ID from accessibility snapshot
 */
export async function clickByRef(page, ref) {
  await page.click(refSelector(ref), { timeout: 5000 });
}

/**
 * Type text into an element by ref.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} ref - Ref ID from accessibility snapshot
 * @param {string} text - Text to type
 * @param {object} [opts]
 * @param {boolean} [opts.slowly] - Type character by character (useful for autocomplete)
 * @param {boolean} [opts.submit] - Press Enter after typing
 * @param {boolean} [opts.clear] - Clear existing content before typing (default: true for fill)
 */
export async function typeByRef(page, ref, text, opts = {}) {
  const selector = refSelector(ref);
  if (opts.slowly) {
    await page.click(selector, { timeout: 5000 });
    if (opts.clear !== false) {
      await page.fill(selector, '');
    }
    await page.keyboard.type(text, { delay: 50 + Math.random() * 30 });
  } else {
    await page.fill(selector, text);
  }
  if (opts.submit) {
    await page.keyboard.press('Enter');
  }
}

/**
 * Hover over an element by ref.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} ref - Ref ID from accessibility snapshot
 */
export async function hoverByRef(page, ref) {
  await page.hover(refSelector(ref), { timeout: 5000 });
}

/**
 * Select option(s) in a dropdown by ref.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} ref - Ref ID of the select element
 * @param {string|string[]} values - Value(s) to select
 */
export async function selectByRef(page, ref, values) {
  await page.selectOption(refSelector(ref), values);
}

// Re-export role sets for use in tests
export { INTERACTIVE_ROLES, STRUCTURAL_ROLES };

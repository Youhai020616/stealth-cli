import { describe, it, expect, vi } from 'vitest';
import { clickElement } from '../../src/utils/click.js';

describe('clickElement', () => {
  it('waits for the selector and clicks in the page context', async () => {
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const page = {
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({ waitFor }),
      }),
      evaluate: vi.fn().mockResolvedValue({ ok: true }),
    };

    await clickElement(page, '#submit', { timeout: 1234 });

    expect(page.locator).toHaveBeenCalledWith('#submit');
    expect(waitFor).toHaveBeenCalledWith({ state: 'attached', timeout: 1234 });
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), '#submit');
  });

  it('throws page-context click errors', async () => {
    const page = {
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          waitFor: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      evaluate: vi.fn().mockResolvedValue({ ok: false, error: 'Element is disabled: #submit' }),
    };

    await expect(clickElement(page, '#submit')).rejects.toThrow('Element is disabled');
  });

  it('requires a selector', async () => {
    await expect(clickElement({}, '')).rejects.toThrow('selector is required');
  });
});

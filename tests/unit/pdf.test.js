import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeJpegPdf } from '../../src/utils/pdf.js';

describe('writeJpegPdf', () => {
  it('writes a PDF file containing the JPEG image object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stealth-pdf-'));
    const output = join(dir, 'page.pdf');

    try {
      writeJpegPdf(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 640, 480, output);
      const pdf = readFileSync(output);
      const text = pdf.toString('binary');

      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text).toContain('/Subtype /Image');
      expect(text).toContain('/Filter /DCTDecode');
      expect(text).toContain('/MediaBox [0 0 640 480]');
      expect(text).toContain('%%EOF');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

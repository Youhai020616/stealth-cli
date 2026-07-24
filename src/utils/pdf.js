import { writeFileSync } from 'fs';

function pdfString(value) {
  return Buffer.from(value, 'binary');
}

function objectBuffer(id, body) {
  return pdfString(`${id} 0 obj\n${body}\nendobj\n`);
}

function streamObjectBuffer(id, dict, stream) {
  return Buffer.concat([
    pdfString(`${id} 0 obj\n${dict}\nstream\n`),
    stream,
    pdfString('\nendstream\nendobj\n'),
  ]);
}

/**
 * Write a single-page PDF that embeds a JPEG screenshot.
 *
 * @param {Buffer} jpegBuffer
 * @param {number} width
 * @param {number} height
 * @param {string} outputPath
 */
export function writeJpegPdf(jpegBuffer, width, height, outputPath) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const chunks = [pdfString('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = [0];

  const add = (buffer) => {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(buffer);
  };

  add(objectBuffer(1, '<< /Type /Catalog /Pages 2 0 R >>'));
  add(objectBuffer(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  add(objectBuffer(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${safeWidth} ${safeHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  ));
  add(streamObjectBuffer(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${safeWidth} /Height ${safeHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBuffer.length} >>`,
    jpegBuffer,
  ));

  const draw = pdfString(`q\n${safeWidth} 0 0 ${safeHeight} 0 0 cm\n/Im0 Do\nQ\n`);
  add(streamObjectBuffer(5, `<< /Length ${draw.length} >>`, draw));

  const body = Buffer.concat(chunks);
  const xrefOffset = body.length;
  const xrefLines = [
    'xref',
    `0 ${offsets.length}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${offsets.length} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ];

  writeFileSync(outputPath, Buffer.concat([body, pdfString(xrefLines.join('\n'))]));
}

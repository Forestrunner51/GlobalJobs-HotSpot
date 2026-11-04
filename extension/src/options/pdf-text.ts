// A PDF's text as lines, using PDF.js inside the extension (nothing leaves the browser).
// The legacy build keeps it working back to the manifest's minimum Chrome version.

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

interface Piece {
  str: string;
  x: number;
  y: number;
  width: number;
}

export async function pdfText(data: Uint8Array): Promise<string> {
  const task = getDocument({ data });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    const pieces: Piece[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      pieces.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width });
    }
    // Pieces on the same baseline (within 2pt) are one line, read left to right, so a right-aligned
    // date stays on its job title's line.
    pieces.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Piece[][] = [];
    for (const p of pieces) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line[0].y - p.y) <= 2) line.push(p);
      else lines.push([p]);
    }
    pages.push(lines.map((line) => {
      line.sort((a, b) => a.x - b.x);
      return line.reduce((text, p, i) => {
        const prev = line[i - 1];
        const gap = prev ? p.x - (prev.x + prev.width) : 0;
        return text + (prev && gap > 1 && !text.endsWith(' ') && !p.str.startsWith(' ') ? ' ' : '') + p.str;
      }, '');
    }).join('\n'));
  }
  await task.destroy();
  return pages.join('\n');
}

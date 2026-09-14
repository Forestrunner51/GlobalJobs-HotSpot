// Resume text extraction. Everything here runs locally: files are read with
// the File API and parsed by vendored libraries served from this site.

import { loadScript } from './util.js';

export class ResumeError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const MIN_CHARS_PER_PAGE = 40;

async function extractPdf(file) {
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
    disableFontFace: true,
    stopAtErrors: false,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  await doc.destroy();
  return { text: pages.join('\n'), pages: doc.numPages };
}

async function extractDocx(file) {
  await loadScript('vendor/mammoth.browser.min.js');
  const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return { text: value, pages: null };
}

export async function extractText(file) {
  const name = file.name.toLowerCase();
  let result;
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    try {
      result = await extractPdf(file);
    } catch (err) {
      if (err?.name === 'PasswordException') throw new ResumeError('encrypted', 'This PDF is password-protected. Export an unlocked copy and try again.');
      throw new ResumeError('unreadable', `Could not read this PDF (${err?.message || err}).`);
    }
    const chars = result.text.replace(/\s/g, '').length;
    if (chars < MIN_CHARS_PER_PAGE * Math.max(1, result.pages)) {
      throw new ResumeError('scan',
        'This PDF has almost no selectable text; it looks like a scanned image. '
        + 'Export the resume as a text-based PDF or DOCX, or pick occupations manually.');
    }
  } else if (name.endsWith('.docx')) {
    try {
      result = await extractDocx(file);
    } catch (err) {
      throw new ResumeError('unreadable', `Could not read this DOCX (${err?.message || err}).`);
    }
  } else if (name.endsWith('.doc')) {
    throw new ResumeError('unsupported', 'Legacy .doc files are not supported. Save as .docx or PDF.');
  } else if (file.type.startsWith('text/') || /\.(txt|md|text)$/.test(name)) {
    result = { text: await file.text(), pages: null };
  } else {
    throw new ResumeError('unsupported', 'Unsupported file type. Use PDF, DOCX or plain text.');
  }

  const words = result.text.split(/\s+/).filter(Boolean).length;
  if (words < 15) {
    throw new ResumeError('empty', 'Almost no text was found in this file. Try another format, or pick occupations manually.');
  }
  return { ...result, words };
}

const fs = require('fs');
const path = require('path');

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';

const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.webp': 'image/webp',
};

async function extractTextFromFile(filePath, originalName, mimeType) {
  const ext = path.extname(originalName).toLowerCase();
  const resolvedMime = MIME_MAP[ext] || mimeType;

  const base64 = fs.readFileSync(filePath).toString('base64');
  const dataUrl = `data:${resolvedMime};base64,${base64}`;

  const isPDF = resolvedMime === 'application/pdf';

  const body = {
    model: 'mistral-ocr-latest',
    document: isPDF
      ? { type: 'document_url', document_url: dataUrl }
      : { type: 'image_url', image_url: dataUrl },
  };

  const response = await fetch(MISTRAL_OCR_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Mistral OCR failed (${response.status}): ${err}`);
  }

  const result = await response.json();

  // Mistral OCR returns pages array, each with markdown text
  const text = result.pages
    ? result.pages.map((p) => p.markdown || '').join('\n\n').trim()
    : (result.text || '').trim();

  return text;
}

module.exports = { extractTextFromFile };

'use strict';
/* Inspects a file and decides what it actually is, without trusting the extension or the client.
   A browser sends no usable content type for uploads, and an extension can lie, so the bytes win
   when they are recognisable. */

const fs = require('node:fs');
const path = require('node:path');

const MAGIC = [
  {kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF', note: 'PDF text extraction is not implemented yet. The file is stored and can be opened, but its text is not read.'},
  {kind: 'image', bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG'},
  {kind: 'image', bytes: [0xff, 0xd8, 0xff], label: 'JPEG'},
  {kind: 'image', bytes: [0x47, 0x49, 0x46, 0x38], label: 'GIF'},
  {kind: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP container', note: 'A ZIP container, such as DOCX or a zipped archive. Extraction is not implemented yet.'},
  {kind: 'container', bytes: [0x52, 0x49, 0x46, 0x46], label: 'RIFF container'},
  {kind: 'container', bytes: [0x4f, 0x67, 0x67, 0x53], label: 'Ogg container'},
  {kind: 'container', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, label: 'MP4 container'},
  {kind: 'container', bytes: [0x1a, 0x45, 0xdf, 0xa3], label: 'Matroska or WebM container'}
];

const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.srt', '.vtt', '.yml', '.yaml'];
const UNSUPPORTED = [
  {extensions: ['.docx', '.doc'], reason: 'Word document extraction is not implemented yet. Export it to text and import that instead.'},
  {extensions: ['.xlsx', '.xls'], reason: 'Spreadsheet extraction is not implemented yet. Export it to CSV and import that instead.'},
  {extensions: ['.pptx', '.ppt'], reason: 'Presentation extraction is not implemented yet.'},
  {extensions: ['.svg', '.ttf', '.otf', '.woff', '.woff2'], reason: 'Brand assets are stored as-is. There is no text or media metadata to extract.'}
];

function head(filePath, length = 16) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(descriptor, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

function matchesMagic(bytes, entry) {
  const offset = entry.offset || 0;
  if (bytes.length < offset + entry.bytes.length) return false;
  for (let i = 0; i < entry.bytes.length; i++) if (bytes[offset + i] !== entry.bytes[i]) return false;
  return true;
}

/* True when the sample contains a NUL byte or too many control characters to be text. */
function looksBinary(buffer) {
  let suspicious = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return buffer.length > 0 && suspicious / buffer.length > 0.05;
}

function classify(filePath, options = {}) {
  const originalName = options.name || path.basename(filePath);
  const extension = path.extname(originalName).toLowerCase();
  const mime = String(options.mime || '');
  const bytes = head(filePath);

  for (const entry of MAGIC) {
    if (!matchesMagic(bytes, entry)) continue;
    if (entry.kind === 'image') return {kind: 'media', label: entry.label, detail: 'image'};
    if (entry.kind === 'container') return {kind: 'media', label: entry.label, detail: 'container'};
    if (entry.kind === 'pdf') return {kind: 'pdf', label: 'PDF'};
    return {kind: 'unsupported', label: entry.label, reason: entry.note};
  }

  if (TEXT_EXTENSIONS.includes(extension)) return {kind: 'text', label: 'text file'};
  if (mime.startsWith('text/')) return {kind: 'text', label: 'text file'};
  if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) return {kind: 'media', label: mime.split('/')[0]};

  for (const entry of UNSUPPORTED) {
    if (entry.extensions.includes(extension)) return {kind: 'unsupported', label: extension.replace('.', '').toUpperCase(), reason: entry.reason};
  }

  // Last resort: a text-looking body with an unknown extension is still text.
  if (!looksBinary(head(filePath, 512))) return {kind: 'text', label: 'text-like file'};
  return {kind: 'unsupported', label: extension ? extension.replace('.', '').toUpperCase() : 'unknown', reason: 'This file type is not recognised, so no text or media metadata can be extracted.'};
}

/* Image dimensions straight from the header, so an image gets real metadata even without ffprobe.
   `bytes` must be a magic sample of at least 10 bytes, as classify() and the analyze path both pass.
   Returns null when the format is not recognised; a wrong guess would be worse than none. */
function imageSize(filePath, bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const header = head(filePath, 24);
    if (header.length < 24) return null;
    return {width: header.readUInt32BE(16), height: header.readUInt32BE(20), format: 'png'};
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const buffer = head(filePath, 65536);
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: 'jpeg'};
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const header = head(filePath, 10);
    if (header.length < 10) return null;
    return {width: header.readUInt16LE(6), height: header.readUInt16LE(8), format: 'gif'};
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const header = head(filePath, 26);
    if (header.length < 26) return null;
    return {width: header.readInt32LE(18), height: Math.abs(header.readInt32LE(22)), format: 'bmp'};
  }
  return null;
}

module.exports = {classify, looksBinary, head, imageSize};
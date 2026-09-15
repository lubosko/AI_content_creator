'use strict';
/* Text extraction for PDFs that carry a real text layer.
   Pure Node, no dependency: streams are inflated with zlib and content operators are read directly.
   A scanned PDF has no text layer, which is reported plainly rather than as an empty success. */

const fs = require('node:fs');
const zlib = require('node:zlib');

const MAX_TEXT_CHARACTERS = 20000;
const MAX_INFLATED_BYTES = 24 * 1024 * 1024;

function decodeAscii85(buffer) {
  const text = buffer.toString('latin1').replace(/<~|~>/g, '').replace(/\s+/g, '');
  const out = [];
  let tuple = 0, count = 0;
  for (const char of text) {
    if (char === 'z' && count === 0) { out.push(0, 0, 0, 0); continue; }
    const code = char.charCodeAt(0);
    if (code < 33 || code > 117) continue;
    tuple = tuple * 85 + (code - 33);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
  }
  return Buffer.from(out);
}

/* Reads a PDF literal string, honouring backslash escapes and balanced parentheses. */
function readLiteralString(content, start) {
  let depth = 0, index = start, out = '';
  while (index < content.length) {
    const char = content[index];
    if (char === '\\') {
      const next = content[index + 1];
      const simple = {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f', '(': '(', ')': ')', '\\': '\\'};
      if (Object.prototype.hasOwnProperty.call(simple, next)) { out += simple[next]; index += 2; continue; }
      const octal = content.slice(index + 1, index + 4).match(/^[0-7]{1,3}/);
      if (octal) { out += String.fromCharCode(parseInt(octal[0], 8)); index += 1 + octal[0].length; continue; }
      index += 2; continue;
    }
    if (char === '(') {
      depth++;
      // The opening parenthesis that starts the string is not content.
      if (depth > 1) out += char;
      index++;
      continue;
    }
    if (char === ')') {
      depth--;
      if (depth === 0) return {value: out, next: index + 1};
      out += char;
      index++;
      continue;
    }
    out += char;
    index++;
  }
  return {value: out, next: index};
}

function readHexString(content, start) {
  const end = content.indexOf('>', start);
  if (end < 0) return {value: '', next: content.length};
  const digits = content.slice(start, end).replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < digits.length; i += 2) out += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16));
  return {value: out, next: end + 1};
}

/* Pulls the visible text out of one decoded content stream. Tokens are read whole, so a string is
   only emitted when a text-showing operator consumes it and operators never leak into the output. */
function textFromContent(content) {
  let out = '';
  let index = 0;
  let pending = '';

  function emitLineBreak() {
    if (pending) { out += pending; pending = ''; }
    if (out && !out.endsWith('\n')) out += '\n';
  }

  while (index < content.length) {
    const char = content[index];
    if (char === '(') {
      // readLiteralString expects the index of the opening parenthesis itself.
      const read = readLiteralString(content, index);
      pending += read.value;
      index = read.next;
      continue;
    }
    if (char === '<' && content[index + 1] !== '<') {
      const read = readHexString(content, index + 1);
      pending += read.value;
      index = read.next;
      continue;
    }
    if (/[A-Za-z'"]/.test(char)) {
      let end = index;
      while (end < content.length && /[A-Za-z*'"]/.test(content[end])) end++;
      const operator = content.slice(index, end);
      if (operator === 'Tj' || operator === 'TJ' || operator === "'" || operator === '"') {
        if (pending) { out += pending; pending = ''; }
        if (operator === "'" || operator === '"') out += '\n';
      } else if (operator === 'Td' || operator === 'TD' || operator === 'T*' || operator === 'ET') {
        emitLineBreak();
      }
      index = end;
      continue;
    }
    index++;
  }

  if (pending) out += pending;
  return out;
}

function interestingStreams(buffer) {
  const streams = [];
  const text = buffer.toString('latin1');
  let index = 0;
  while ((index = buffer.indexOf('stream', index)) >= 0) {
    // The keyword must stand alone: "endstream" also contains "stream", and matching it would
    // desynchronise the scan and swallow the next object's dictionary.
    const before = text.slice(Math.max(0, index - 9), index);
    const after = text[index + 6];
    const isEnd = before === 'endstream';
    const isToken = after !== undefined && /[A-Za-z0-9]/.test(after);
    if (isEnd || isToken) { index += 6; continue; }

    // The dictionary immediately precedes the keyword.
    const dictionary = text.slice(Math.max(0, index - 800), index);
    let start = index + 6;
    if (buffer[start] === 0x0d) start++;
    if (buffer[start] === 0x0a) start++;
    let end = buffer.indexOf('endstream', start);
    if (end < 0) break;
    let stop = end;
    while (stop > start && (buffer[stop - 1] === 0x0a || buffer[stop - 1] === 0x0d)) stop--;
    streams.push({dictionary, data: buffer.subarray(start, stop)});
    index = end + 9;
  }
  return streams;
}

function decodeStream(entry) {
  const dict = entry.dictionary;
  // An image or an already-compressed payload contains no text operators.
  if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict)) return null;
  let data = entry.data;
  try {
    if (/\/FlateDecode/.test(dict)) {
      data = zlib.inflateSync(data, {maxOutputLength: MAX_INFLATED_BYTES});
    } else if (/\/ASCII85Decode/.test(dict)) {
      data = decodeAscii85(data);
      if (/\/FlateDecode/.test(dict)) data = zlib.inflateSync(data, {maxOutputLength: MAX_INFLATED_BYTES});
    } else if (/\/Filter/.test(dict)) {
      return null; // An unsupported filter: do not guess at the bytes.
    }
  } catch (error) {
    return null;
  }
  return data.toString('latin1');
}

/* Extracts text from a PDF. Never throws for a bad PDF; returns a structured outcome instead. */
function extractPdfText(filePath, options = {}) {
  let buffer;
  try { buffer = fs.readFileSync(filePath); } catch (error) { return {ok: false, reason: 'The saved PDF could not be read.'}; }

  const head = buffer.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) return {ok: false, reason: 'This file is not a valid PDF.'};
  if (/\/Encrypt\b/.test(buffer.subarray(0, Math.min(buffer.length, 200000)).toString('latin1'))) {
    return {ok: false, reason: 'This PDF is encrypted, so its text cannot be extracted.', retryable: false};
  }

  const chunks = [];
  for (const entry of interestingStreams(buffer)) {
    const decoded = decodeStream(entry);
    if (!decoded) continue;
    const text = textFromContent(decoded);
    if (text.trim()) chunks.push(text);
  }

  const joined = chunks.join('\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(line => line.replace(/\s+$/g, '')).join('\n')
    .trim();

  // Strip replacement characters that come from subset font encodings with no usable Unicode map.
  const cleaned = joined.replace(/\u0000/g, '').replace(/[\uFFFD]/g, '').trim();
  const meaningful = cleaned.replace(/[^A-Za-z0-9]/g, '').length;

  if (meaningful < 20) {
    return {
      ok: false,
      retryable: false,
      reason: 'No text layer was found in this PDF. It is most likely a scan or an image-only export, which needs OCR. OCR is not implemented yet.'
    };
  }

  const truncated = cleaned.length > MAX_TEXT_CHARACTERS;
  const titleMatch = buffer.subarray(0, Math.min(buffer.length, 400000)).toString('latin1').match(/\/Title\s*\(([^)]{0,300})\)/);
  return {
    ok: true,
    content: {
      text: cleaned.slice(0, MAX_TEXT_CHARACTERS),
      characters: cleaned.length,
      truncated,
      title: titleMatch ? titleMatch[1].replace(/\\([()\\])/g, '$1').trim() : null
    },
    note: truncated ? 'Only the beginning of this PDF was read.' : null,
    pages: (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
  };
}

module.exports = {extractPdfText, textFromContent, decodeAscii85, MAX_TEXT_CHARACTERS};
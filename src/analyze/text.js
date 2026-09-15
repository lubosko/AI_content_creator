'use strict';
/* Text extraction for local text files and URL references.
   Limits are explicit so a large or awkward source degrades honestly instead of silently. */

const fs = require('node:fs');
const {looksBinary} = require('./detect');

const MAX_TEXT_BYTES = 256 * 1024;
const TEXT_CHARACTER_LIMIT = 20000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function decode(buffer) {
  // Strip a UTF-8 BOM so it does not appear as a stray character in the extracted text.
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function clampText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  return {text: clean.slice(0, TEXT_CHARACTER_LIMIT), characters: clean.length, truncated: clean.length > TEXT_CHARACTER_LIMIT};
}

function extractTextFile(filePath, options = {}) {
  const maxBytes = options.maxBytes || MAX_TEXT_BYTES;
  let stat;
  try { stat = fs.statSync(filePath); } catch (error) { return {ok: false, reason: 'The saved original could not be read.'}; }

  const readBytes = Math.min(stat.size, maxBytes);
  const descriptor = fs.openSync(filePath, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(readBytes);
    const read = fs.readSync(descriptor, buffer, 0, readBytes, 0);
    buffer = buffer.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }

  if (buffer.length === 0) return {ok: false, reason: 'The file is empty, so there is no text to extract.'};
  // A .txt file can still contain binary data; report that rather than emitting garbage.
  if (looksBinary(buffer.subarray(0, Math.min(buffer.length, 4096)))) {
    return {ok: false, reason: 'This file is named like a text file but contains binary data.'};
  }

  const clamped = clampText(decode(buffer));
  return {
    ok: true,
    content: {
      text: clamped.text,
      characters: clamped.characters,
      truncated: clamped.truncated || stat.size > maxBytes,
      note: clamped.truncated || stat.size > maxBytes ? 'Only the beginning of this file was read. The rest was not analyzed.' : null
    }
  };
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(line => line.trim()).join('\n')
    .trim();
}

function title(head, url) {
  const match = head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (match) {
    const text = stripHtml(match[1]).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  try { return new URL(url).hostname; } catch (error) { return url; }
}

/* Blocks obvious server-side request forgery: this tool runs locally, and a stored URL must not be
   able to make the server read its own private network. */
function blockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'The URL has no host.';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'Local network addresses are not fetched.';
  if (host === '::1' || host === '0.0.0.0') return 'Local network addresses are not fetched.';
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some(part => part > 255)) return 'That is not a valid address.';
    const [a, b] = parts;
    if (a === 127 || a === 10 || a === 0) return 'Local network addresses are not fetched.';
    if (a === 172 && b >= 16 && b <= 31) return 'Private network addresses are not fetched.';
    if (a === 192 && b === 168) return 'Private network addresses are not fetched.';
    if (a === 169 && b === 254) return 'Link-local addresses are not fetched.';
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return 'Private network addresses are not fetched.';
  return null;
}

/* Fetches a URL reference and extracts readable text. Returns a structured outcome. */
async function extractUrl(url, options = {}) {
  let parsed;
  try { parsed = new URL(url); } catch (error) { return {ok: false, reason: 'That is not a valid URL.'}; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return {ok: false, reason: 'Only http and https URLs are fetched.'};
  const blocked = blockedHost(parsed.hostname);
  if (blocked) return {ok: false, reason: blocked};

  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(parsed.href, {
      redirect: 'follow',
      headers: {'user-agent': 'ai-social-content-agent/0.1 (local material analysis)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5'},
      signal: AbortSignal.timeout(options.timeoutMs || FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {ok: false, reason: timedOut ? 'The page did not respond in time.' : 'The page could not be reached. Check the address and your connection.'};
  }

  if (!response.ok) return {ok: false, reason: 'The page returned HTTP ' + response.status + '.', status: response.status};
  // Re-check after redirects: a public URL must not redirect into the private network.
  const finalBlocked = blockedHost(new URL(response.url || parsed.href).hostname);
  if (finalBlocked) return {ok: false, reason: 'The address redirected to a blocked location.'};

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !/text\/|json|xml/.test(contentType)) {
    return {ok: false, reason: 'That address is not a text page (content type: ' + contentType.split(';')[0] + ').'};
  }

  let body;
  try { body = await response.text(); } catch (error) { return {ok: false, reason: 'The page body could not be read.'}; }
  const truncated = body.length > MAX_HTML_BYTES;
  const limited = truncated ? body.slice(0, MAX_HTML_BYTES) : body;
  const isHtml = /html/.test(contentType) || /<html|<body|<div|<p[\s>]/i.test(limited.slice(0, 2000));
  const text = isHtml ? stripHtml(limited) : limited.trim();
  if (!text) return {ok: false, reason: 'No readable text was found at this address.'};

  const clamped = clampText(text);
  return {
    ok: true,
    content: {
      text: clamped.text,
      characters: clamped.characters,
      truncated: clamped.truncated || truncated,
      title: title(limited, parsed.href),
      fetchedAt: new Date().toISOString(),
      note: clamped.truncated || truncated ? 'Only the beginning of this page was read.' : null
    }
  };
}

module.exports = {extractTextFile, extractUrl, stripHtml, blockedHost, MAX_TEXT_BYTES, TEXT_CHARACTER_LIMIT};
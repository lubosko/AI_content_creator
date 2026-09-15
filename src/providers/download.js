'use strict';
/* One downloader for every media source, so a new provider cannot invent its own size limits,
   timeouts, or partial-file behaviour. Pexels, Archive.org and Openverse all write through here. */

const fs = require('node:fs');
const path = require('node:path');

function fail(message, status = 502) { throw Object.assign(new Error(message), {status}); }

async function downloadFile({url, targetPath, fetchImpl = fetch, timeoutMs = 120000, maxBytes = 200 * 1024 * 1024, label = 'media file'}) {
  let response;
  try {
    response = await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs), redirect: 'follow'});
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    fail(timedOut ? 'The ' + label + ' download timed out.' : 'The ' + label + ' could not be downloaded.');
  }
  if (!response.ok) fail('The ' + label + ' could not be downloaded (HTTP ' + response.status + ').');
  const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
  if (declared && declared > maxBytes) fail('The ' + label + ' is unexpectedly large and was not downloaded.');

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) fail('The ' + label + ' download was empty.');
  if (buffer.length > maxBytes) fail('The ' + label + ' is unexpectedly large and was not saved.');
  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  fs.writeFileSync(targetPath, buffer);
  return {path: targetPath, bytes: buffer.length};
}

/* The stock-media name, kept so existing callers and tests keep working. */
function downloadClip(options) { return downloadFile({...options, label: 'stock clip'}); }

module.exports = {downloadFile, downloadClip, fail};
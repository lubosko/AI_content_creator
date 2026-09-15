'use strict';
/* Archive.org as a free-licence video source. Unlike a stock library, archive.org items carry mixed
   and sometimes absent rights, so the licence is resolved per item from its metadata and anything
   that cannot be resolved is refused here rather than downloaded and hoped about. */

const licensing = require('../lib/licensing');

const PROVIDER = {
  id: 'archive',
  short: 'Archive.org',
  name: 'Internet Archive',
  searchEndpoint: 'https://archive.org/advancedsearch.php',
  metadataEndpoint: 'https://archive.org/metadata/',
  downloadEndpoint: 'https://archive.org/download/',
  licence: 'Per item: the licence recorded on the archive.org item itself.',
  attributionRequired: 'per item',
  needsKey: false
};

function fail(message, status = 502) { throw Object.assign(new Error(message), {status}); }

function messageFor(status) {
  return {
    403: 'Archive.org refused the request. Retry later.',
    429: 'Archive.org rate-limited the request. Retry later.'
  }[status] || ('Archive.org search failed (HTTP ' + status + '). Retry later.');
}

/* The collections that are public domain by definition. Used only as a fallback when the item
   records no licence of its own. */
const PUBLIC_DOMAIN_COLLECTIONS = ['prelinger', 'classic_tv', 'feature_films', 'moviesandfilms', 'publicmovies'];

/* Resolves one item's rights. Returns a rights record the gate understands, or null when the item
   does not say enough to be used. */
function rightsFor(metadata) {
  const info = (metadata && metadata.metadata) || {};
  const raw = Array.isArray(info.licenseurl) ? info.licenseurl[0] : info.licenseurl;
  const basis = licensing.creativeCommonsBasis(raw);
  const identifier = info.identifier || (metadata && metadata.metadata && metadata.metadata.identifier) || null;
  const source = identifier ? PROVIDER.downloadEndpoint + encodeURIComponent(identifier) : null;
  const title = Array.isArray(info.title) ? info.title[0] : info.title;
  const creator = Array.isArray(info.creator) ? info.creator[0] : info.creator;

  if (basis !== 'unknown') {
    // Recorded as declared, not as verified: archive.org licences are self-declared by uploaders.
    return {basis, title: title || null, holder: creator || null, source_url: source, licence_url: raw || null, note: 'Licence declared by the uploader on archive.org and recorded here as declared, not verified.'};
  }
  // A rights statement is not a licence, but an explicit public-domain statement is usable.
  const rights = String(info.rights || '');
  const collections = [].concat(info.collection || []).map(String);
  if (/public domain|no known copyright/i.test(rights)) {
    return {basis: 'public_domain', title: title || null, holder: creator || null, source_url: source, licence_url: null, note: 'Item states it is in the public domain.'};
  }
  if (!rights && collections.some(name => PUBLIC_DOMAIN_COLLECTIONS.includes(name))) {
    return {basis: 'public_domain', title: title || null, holder: creator || null, source_url: source, licence_url: null, note: 'Item belongs to a public-domain collection on archive.org.'};
  }
  return null;
}

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'mpg', 'mpeg', 'mov'];
const MAX_FILE_BYTES = 200 * 1024 * 1024;

function videoFiles(metadata) {
  const files = Array.isArray(metadata && metadata.files) ? metadata.files : [];
  return files.map(file => {
    const name = String(file && file.name || '');
    const extension = name.split('.').pop().toLowerCase();
    return {file, name, extension, size: Number(file.size) || 0, length: Number(file.length) || 0};
  }).filter(item => item.name && VIDEO_EXTENSIONS.includes(item.extension) && item.size > 0);
}

/* Why no file could be chosen, so a scene with no media reports the real cause. A 4.6 GB item and
   an item with no video at all are different problems, and saying "not a usable format" for both
   sends the operator looking for the wrong thing. */
function fileReason(metadata) {
  const videos = videoFiles(metadata);
  if (!videos.length) return 'the item has no downloadable video file';
  if (videos.every(item => item.size > MAX_FILE_BYTES)) {
    return 'every video file is larger than the ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + ' MB download ceiling';
  }
  return 'no video file in a usable format';
}

function pickVideoFile(metadata) {
  const usable = videoFiles(metadata).filter(item => item.size <= MAX_FILE_BYTES);
  if (!usable.length) return null;
  // Prefer mp4 (cuts into the timeline without a transcode); within a format, take the smallest
  // file, so a 4K derivative does not dominate the download. Compared as two keys rather than one
  // arithmetic score, which silently stops working once file sizes exceed the multiplier.
  const tier = item => (item.extension === 'mp4' ? 0 : 1);
  return usable.sort((left, right) => (tier(left) - tier(right)) || (left.size - right.size))[0];
}

function downloadUrl(identifier, fileName) {
  return PROVIDER.downloadEndpoint + encodeURIComponent(identifier) + '/' + encodeURIComponent(fileName).replace(/%2F/gi, '/');
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) return {ok: false, reason: messageFor(response.status), retryable: response.status === 429 || response.status >= 500};
  try { return {ok: true, payload: await response.json()}; }
  catch (error) { return {ok: false, reason: 'Archive.org returned a response that could not be read.'}; }
}

/* Searches for one clip. Candidates are checked in order until one has both a usable file and a
   licence that can be resolved; the reasons the others were passed over are reported. */
async function searchVideo({query, minDurationSeconds, fetchImpl = fetch, timeoutMs = 30000, rows = 12, inspectLimit = 8}) {
  const url = new URL(PROVIDER.searchEndpoint);
  const cleaned = String(query || '').replace(/[\r\n]+/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  // Restricted to items that declare a licence, or that sit in a public-domain collection. Without
  // this most of the archive is offered and then refused for having no licence at all.
  url.searchParams.set('q', 'mediatype:movies AND (licenseurl:* OR collection:prelinger) AND (' + (cleaned || 'b roll') + ')');
  url.searchParams.set('fl[]', 'identifier');
  url.searchParams.append('fl[]', 'title');
  url.searchParams.set('sort[]', 'downloads desc');
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('page', '1');
  url.searchParams.set('output', 'json');

  let search;
  try { search = await fetchJson(fetchImpl, url.href, timeoutMs); }
  catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {ok: false, reason: timedOut ? 'The Archive.org search timed out.' : 'Could not reach Archive.org.'};
  }
  if (!search.ok) return search;

  const docs = ((search.payload && search.payload.response) || {}).docs || [];
  const skipped = [];
  for (const doc of docs.slice(0, Math.max(1, inspectLimit))) {
    const identifier = doc && doc.identifier;
    if (!identifier) continue;
    let metadata;
    try { metadata = await fetchJson(fetchImpl, PROVIDER.metadataEndpoint + encodeURIComponent(identifier), timeoutMs); }
    catch (error) { skipped.push({identifier, reason: 'metadata could not be read'}); continue; }
    if (!metadata.ok) { skipped.push({identifier, reason: metadata.reason}); continue; }

    const file = pickVideoFile(metadata.payload);
    if (!file) { skipped.push({identifier, reason: fileReason(metadata.payload)}); continue; }
    const rights = rightsFor(metadata.payload);
    if (!rights) { skipped.push({identifier, reason: 'the item does not record a licence, so it cannot be used'}); continue; }

    const wanted = Number(minDurationSeconds) || 0;
    return {
      ok: true,
      clip: {
        provider: PROVIDER.id,
        provider_id: String(identifier),
        url: downloadUrl(identifier, file.name),
        page_url: 'https://archive.org/details/' + encodeURIComponent(identifier),
        media_kind: 'video',
        extension: file.extension,
        width: null,
        height: null,
        duration_seconds: file.length || null,
        author: rights.holder || null,
        licence: rights.basis,
        attribution_required: licensing.licenceFor(rights.basis).attribution,
        rights,
        short_enough: wanted ? (file.length || 0) >= wanted : true,
        query: cleaned,
        skipped: skipped.length ? skipped : undefined
      }
    };
  }
  return {ok: false, reason: docs.length
    ? 'No Archive.org item with a usable file and a recorded licence matched that description. ' + skipped.map(item => item.identifier + ': ' + item.reason).slice(0, 3).join('; ')
    : 'No Archive.org item matched that description.'};
}

async function downloadClip({url, targetPath, fetchImpl = fetch, timeoutMs = 120000, maxBytes = 200 * 1024 * 1024}) {
  const {downloadFile} = require('./download');
  return downloadFile({url, targetPath, fetchImpl, timeoutMs, maxBytes, label: 'Archive.org item'});
}

module.exports = {PROVIDER, rightsFor, pickVideoFile, videoFiles, fileReason, downloadUrl, searchVideo, downloadClip};
'use strict';
/* Openverse as a free-licence still-image source. Its search is filtered to licences that permit
   commercial use and modification, so every candidate it returns can actually pass the rights gate.
   Openverse indexes images and audio, not video, so these become stills the composer holds on
   screen for the length of a scene. */

const licensing = require('../lib/licensing');

const PROVIDER = {
  id: 'openverse',
  short: 'Openverse',
  name: 'Openverse (Creative Commons search)',
  endpoint: 'https://api.openverse.org/v1/images/',
  licence: 'Creative Commons licences, recorded per image and credited in the export.',
  attributionRequired: 'per licence',
  needsKey: false,
  mediaKinds: ['image']
};

function messageFor(status) {
  return {
    401: 'Openverse rejected the access token.',
    403: 'Openverse refused the request.',
    429: 'Openverse rate-limited anonymous searches. Add an access token in the environment to raise the limit, or retry later.'
  }[status] || ('Openverse search failed (HTTP ' + status + '). Retry later.');
}

function searchQuery(intent, fallback) {
  const clean = String(intent || fallback || '').replace(/[\r\n]+/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.split(' ').filter(Boolean).slice(0, 8).join(' ') || 'b roll';
}

const IMAGE_EXTENSIONS = {jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp'};

/* Prefers a landscape image wide enough to fill a 16:9 frame without upscaling. */
function pickImage(results) {
  const usable = (results || []).filter(item => item && item.url && IMAGE_EXTENSIONS[String(item.filetype || '').toLowerCase()]);
  const landscape = usable.filter(item => (item.width || 0) >= (item.height || 0));
  const pool = landscape.length ? landscape : usable;
  const rank = item => ((item.width || 0) >= 1920 ? 0 : 1) * 1000000 + Math.abs((item.width || 0) - 1920);
  return pool.slice().sort((left, right) => rank(left) - rank(right))[0] || null;
}

/* Builds the rights record from the licence the search result carries. A result whose licence this
   code does not recognise is refused rather than recorded as usable. */
function rightsFor(result) {
  const basis = licensing.creativeCommonsBasis(result && (result.license || result.license_url));
  if (basis === 'unknown') return null;
  return {
    basis,
    title: result.title ? String(result.title).slice(0, 300) : null,
    holder: result.creator ? String(result.creator).slice(0, 300) : null,
    source_url: result.foreign_landing_url || result.url || null,
    licence_url: result.license_url || null,
    note: 'Licence recorded by Openverse for this image.'
  };
}

async function searchImage({query, apiKey, fetchImpl = fetch, timeoutMs = 30000, pageSize = 12, orientation = 'landscape'}) {
  const url = new URL(PROVIDER.endpoint);
  url.searchParams.set('q', searchQuery(query));
  url.searchParams.set('license_type', 'commercial,modification');
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('mature', 'false');
  if (orientation) url.searchParams.set('aspect_ratio', orientation === 'landscape' ? 'wide' : 'tall');

  let response;
  try {
    const headers = apiKey ? {authorization: 'Bearer ' + apiKey} : {};
    response = await fetchImpl(url.href, {headers, signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {ok: false, reason: timedOut ? 'The Openverse search timed out.' : 'Could not reach Openverse.'};
  }
  if (!response.ok) return {ok: false, reason: messageFor(response.status), retryable: response.status === 429 || response.status >= 500};

  let payload;
  try { payload = await response.json(); } catch (error) { return {ok: false, reason: 'Openverse returned a response that could not be read.'}; }
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  const chosen = pickImage(results);
  if (!chosen) return {ok: false, reason: 'No Openverse image matched that description.'};

  const rights = rightsFor(chosen);
  if (!rights) {
    return {ok: false, reason: 'The Openverse result did not record a licence this app recognises, so it was not used.'};
  }
  const extension = IMAGE_EXTENSIONS[String(chosen.filetype || '').toLowerCase()];
  return {
    ok: true,
    clip: {
      provider: PROVIDER.id,
      provider_id: String(chosen.id || ''),
      url: chosen.url,
      page_url: chosen.foreign_landing_url || null,
      media_kind: 'image',
      extension,
      width: chosen.width || null,
      height: chosen.height || null,
      duration_seconds: null,
      author: rights.holder || null,
      licence: rights.basis,
      attribution_required: licensing.licenceFor(rights.basis).attribution,
      rights,
      query: searchQuery(query)
    }
  };
}

async function downloadClip({url, targetPath, fetchImpl = fetch, timeoutMs = 120000, maxBytes = 200 * 1024 * 1024}) {
  const {downloadFile} = require('./download');
  return downloadFile({url, targetPath, fetchImpl, timeoutMs, maxBytes, label: 'Openverse image'});
}

module.exports = {PROVIDER, rightsFor, pickImage, searchImage, downloadClip};
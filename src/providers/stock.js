'use strict';
/* Stock media behind a replaceable adapter, for shots that no own material covers.
   Pexels is the first implementation. The workflow only knows it asked for footage matching a
   description; it never speaks HTTP to a vendor. */

const {downloadClip: downloadFile} = require('./download');

const PROVIDERS = {
  pexels: {
    id: 'pexels',
    name: 'Pexels',
    keyEnv: 'PEXELS_API_KEY',
    videoEndpoint: 'https://api.pexels.com/videos/search',
    photoEndpoint: 'https://api.pexels.com/v1/search',
    licence: 'Pexels licence: free to use, attribution not required but appreciated.',
    // Credit is recorded per asset so provenance survives into the project.
    attributionRequired: false
  }
};

function fail(message, status = 502) { throw Object.assign(new Error(message), {status}); }
function providerConfig(id) { return PROVIDERS[id] || null; }
function providerIds() { return Object.keys(PROVIDERS); }

function messageFor(status) {
  return {
    400: 'The stock search was rejected. Check the query.',
    401: 'The stock provider key was rejected. Check the key in Settings.',
    403: 'This stock provider key does not have permission.',
    429: 'The stock provider rate limit was reached. Retry later.'
  }[status] || ('Stock search failed (HTTP ' + status + '). Retry later.');
}

/* Limits a model-written description to something a search API can use. */
function searchQuery(intent, fallback) {
  const clean = String(intent || fallback || '').replace(/[\r\n]+/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean).slice(0, 8);
  return words.join(' ') || 'b roll';
}

function pickVideoFile(video) {
  const files = Array.isArray(video && video.video_files) ? video.video_files : [];
  // Prefer a landscape HD file: it cuts into a 16:9 timeline without upscaling.
  const usable = files.filter(file => file && file.link && (!file.file_type || file.file_type === 'video/mp4'));
  const landscape = usable.filter(file => (file.width || 0) >= (file.height || 0));
  const sorted = (landscape.length ? landscape : usable).sort((left, right) => {
    const score = file => (file.width >= 1920 ? 0 : 1) * 1000 + Math.abs((file.width || 0) - 1920);
    return score(left) - score(right);
  });
  return sorted[0] || null;
}

/* Searches for one clip matching a scene. Returns a structured outcome, never throws for a miss. */
async function searchVideo({query, apiKey, minDurationSeconds, orientation = 'landscape', fetchImpl = fetch, timeoutMs = 30000, perPage = 15}) {
  if (!apiKey) return {ok: false, reason: 'No stock media key is configured. Add one in Settings, or supply your own footage.'};
  const url = new URL(PROVIDERS.pexels.videoEndpoint);
  url.searchParams.set('query', searchQuery(query));
  url.searchParams.set('orientation', orientation);
  url.searchParams.set('per_page', String(perPage));
  if (minDurationSeconds) url.searchParams.set('size', 'medium');

  let response;
  try {
    response = await fetchImpl(url.href, {headers: {authorization: apiKey}, signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {ok: false, reason: timedOut ? 'The stock search timed out.' : 'Could not reach the stock media provider.'};
  }
  if (!response.ok) return {ok: false, reason: messageFor(response.status), retryable: response.status === 429 || response.status >= 500};

  let payload;
  try { payload = await response.json(); } catch (error) { return {ok: false, reason: 'The stock provider returned a response that could not be read.'}; }
  const videos = Array.isArray(payload && payload.videos) ? payload.videos : [];
  const wanted = Number(minDurationSeconds) || 0;
  // Prefer a clip long enough to cover the scene; fall back to the first usable result.
  const candidates = videos.map(video => ({video, file: pickVideoFile(video)})).filter(item => item.file);
  const longEnough = candidates.filter(item => (item.video.duration || 0) >= wanted);
  const chosen = (longEnough.length ? longEnough : candidates)[0];
  if (!chosen) return {ok: false, reason: 'No stock footage matched that description.'};

  return {
    ok: true,
    clip: {
      provider: 'pexels',
      provider_id: String(chosen.video.id),
      url: chosen.file.link,
      page_url: chosen.video.url || null,
      media_kind: 'video',
      width: chosen.file.width || chosen.video.width || null,
      height: chosen.file.height || chosen.video.height || null,
      duration_seconds: chosen.video.duration || null,
      author: chosen.video.user ? chosen.video.user.name : null,
      licence: PROVIDERS.pexels.licence,
      attribution_required: PROVIDERS.pexels.attributionRequired,
      // The same rights shape as own material, so the gate judges every source the same way.
      rights: {
        basis: 'stock_licence',
        title: searchQuery(query),
        holder: chosen.video.user ? chosen.video.user.name : 'Pexels contributor',
        source_url: chosen.video.url || null,
        licence_url: null,
        note: PROVIDERS.pexels.licence
      },
      query: searchQuery(query)
    }
  };
}

/* Downloads a chosen clip to the project. Returns the written path and size. */
function downloadClip(options) { return downloadFile({...options, label: 'stock clip'}); }

module.exports = {PROVIDERS, providerIds, providerConfig, searchVideo, downloadClip, searchQuery, pickVideoFile};
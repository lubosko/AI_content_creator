'use strict';
/* The media sourcing chain. A scene asks for footage by description; every free-licence source is
   tried in order and the first usable result wins. Sources that were tried and did not deliver are
   reported with the real reason, so a scene with no media explains itself instead of showing a gap
   with no cause. */

const {downloadFile} = require('../providers/download');

/* Pexels first (authored, no attribution obligation, reliably 16:9 video), then Archive.org (video
   with a resolvable licence), then Openverse (stills, for scenes no video matches). */
function createSourcing({sources, unavailable, download = downloadFile} = {}) {
  const active = (sources || []).filter(Boolean);
  const missing = (unavailable || []).filter(Boolean);

  async function search({query, minDurationSeconds}) {
    const attempts = [];
    for (const source of active) {
      let result;
      try { result = await source.search({query, minDurationSeconds}); }
      catch (error) { result = {ok: false, reason: error.message}; }
      if (result && result.ok) return {...result, provider: source.id, attempts};
      attempts.push({provider: source.id, short: source.short || source.id, reason: (result && result.reason) || 'no result', retryable: !!(result && result.retryable)});
    }
    const reasons = attempts.map(item => item.short + ': ' + item.reason).concat(missing.map(item => item.short + ': ' + item.reason));
    return {
      ok: false,
      attempts,
      reason: reasons.length ? reasons.join(' ') : 'No media source is available.',
      retryable: attempts.some(item => item.retryable)
    };
  }

  function downloadClip({url, targetPath}) { return download({url, targetPath, label: 'sourced media'}); }

  /* What the interface and the asset manifest report about sourcing, so "no key" is visible as a
     reason rather than as an unexplained absence of footage. */
  function describe() {
    return {
      ready: active.length > 0,
      sources: active.map(source => ({id: source.id, short: source.short || source.id, media_kinds: source.mediaKinds || ['video'], reason: null})),
      unavailable: missing.map(item => ({id: item.id, short: item.short || item.id, media_kinds: item.mediaKinds || ['video'], reason: item.reason}))
    };
  }

  return {search, download: downloadClip, describe, sources: active, unavailable: missing};
}

module.exports = {createSourcing};
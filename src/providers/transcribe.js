'use strict';
/* Speech-to-text behind a replaceable adapter. OpenAI Whisper is the first implementation.
   The core workflow only knows that it asked for a transcript; it never speaks HTTP to a vendor. */

const fs = require('node:fs');
const path = require('node:path');
const {toVtt, toPlainText} = require('../analyze/audio');

const PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'whisper-1',
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    // Published per-minute price, used only to show an estimate before a long transcription.
    pricePerMinuteUsd: 0.006,
    supportedFormats: ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm']
  }
};

function fail(message, status = 502) { throw Object.assign(new Error(message), {status}); }

function providerIds() { return Object.keys(PROVIDERS); }
function providerConfig(id) { return PROVIDERS[id] || null; }

function estimateCost(durationSeconds, id = 'openai') {
  const config = providerConfig(id);
  if (!config || !config.pricePerMinuteUsd || !Number.isFinite(durationSeconds)) return null;
  const minutes = durationSeconds / 60;
  return {minutes: Math.round(minutes * 10) / 10, usd: Math.round(minutes * config.pricePerMinuteUsd * 10000) / 10000, pricePerMinuteUsd: config.pricePerMinuteUsd};
}

function messageFor(status) {
  return {
    400: 'The transcription request was rejected. Check the model and that the audio is a supported format.',
    401: 'The transcription API key was rejected. Check the key in Settings.',
    403: 'This key does not have permission to use the transcription API.',
    404: 'The transcription model was not found. Check the model name in Settings.',
    413: 'The audio file is too large for one request.',
    429: 'The transcription rate or usage limit was reached. Retry later.',
    500: 'The transcription service had an error. Retry later.',
    502: 'The transcription service was unavailable. Retry later.',
    503: 'The transcription service was unavailable. Retry later.'
  }[status] || ('Transcription failed (HTTP ' + status + '). Retry later.');
}

/* One request per audio file. Returns {text, segments, language, durationSeconds}. */
async function transcribeFile({filePath, apiKey, model, language, timeoutMs = 180000, fetchImpl = fetch}) {
  if (!apiKey) fail('No transcription API key is configured. Add one in Settings.', 409);
  const form = new FormData();
  const buffer = fs.readFileSync(filePath);
  form.append('file', new Blob([buffer]), path.basename(filePath));
  form.append('model', model || PROVIDERS.openai.defaultModel);
  // Verbose JSON returns per-segment timings, which the composer needs for captions.
  form.append('response_format', 'verbose_json');
  if (language) form.append('language', language);

  let response;
  try {
    response = await fetchImpl(PROVIDERS.openai.endpoint, {
      method: 'POST',
      headers: {'authorization': 'Bearer ' + apiKey},
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    fail(timedOut ? 'Transcription timed out. Your material is unchanged. Retry when ready.' : 'Could not reach the transcription service. Check your connection and retry.');
  }

  if (!response.ok) {
    // Never echo the provider body: it can contain request content.
    fail(messageFor(response.status), response.status);
  }

  let payload;
  try { payload = await response.json(); } catch (error) { fail('The transcription service returned a response that could not be read.'); }
  return {
    text: String(payload.text || '').trim(),
    segments: Array.isArray(payload.segments)
      ? payload.segments.map(segment => ({start: Number(segment.start) || 0, end: Number(segment.end) || 0, text: String(segment.text || '').trim()})).filter(segment => segment.text)
      : [],
    language: payload.language || null,
    durationSeconds: Number(payload.duration) || null,
    model: model || PROVIDERS.openai.defaultModel
  };
}

/* Transcribes one or many parts and stitches the result into a single transcript, shifting each
   part's timings so the captions line up with the original media. */
async function transcribeParts({parts, apiKey, model, language, fetchImpl, timeoutMs, onProgress}) {
  const collected = [];
  let detectedLanguage = null;
  for (const part of parts) {
    if (onProgress) onProgress({part: part.index, total: parts.length, startSeconds: part.startSeconds});
    const result = await transcribeFile({filePath: part.path, apiKey, model, language, fetchImpl, timeoutMs});
    if (!detectedLanguage && result.language) detectedLanguage = result.language;
    const offset = part.startSeconds || 0;
    for (const segment of result.segments) collected.push({start: segment.start + offset, end: segment.end + offset, text: segment.text});
    if (!result.segments.length && result.text) collected.push({start: offset, end: offset + 2, text: result.text});
  }
  return {
    segments: collected,
    text: toPlainText(collected),
    vtt: toVtt(collected),
    language: detectedLanguage,
    model: model || PROVIDERS.openai.defaultModel,
    parts: parts.length
  };
}

module.exports = {PROVIDERS, providerIds, providerConfig, estimateCost, transcribeFile, transcribeParts, messageFor};
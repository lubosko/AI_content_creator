'use strict';
/* Narration through a speech-synthesis provider. OpenAI is the first implementation.
   The core workflow only knows it asked for a voice track; it never speaks HTTP to a vendor. */

const fs = require('node:fs');

const PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/audio/speech',
    // The transcription model stored for speech-to-text cannot synthesize speech, so a separate
    // default is used when the configured model is clearly a transcription model.
    defaultModel: 'gpt-4o-mini-tts',
    defaultVoice: 'alloy',
    voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
    // Published per-million-character price for the small TTS model, used only for an estimate.
    pricePerMillionCharsUsd: 15,
    maxCharsPerRequest: 4000
  }
};

function fail(message, status = 502) { throw Object.assign(new Error(message), {status}); }

function providerConfig(id) { return PROVIDERS[id] || null; }
function providerIds() { return Object.keys(PROVIDERS); }

/* A transcription model cannot speak. Fall back rather than sending a request that must fail. */
function resolveModel(requested, id = 'openai') {
  const config = providerConfig(id);
  if (!config) return null;
  const model = String(requested || '').trim();
  if (!model) return config.defaultModel;
  if (/whisper|transcribe/i.test(model)) return config.defaultModel;
  return model;
}

function estimateCost(characters, id = 'openai') {
  const config = providerConfig(id);
  if (!config || !Number.isFinite(characters)) return null;
  return {
    characters,
    usd: Math.round((characters / 1000000) * config.pricePerMillionCharsUsd * 10000) / 10000,
    pricePerMillionCharsUsd: config.pricePerMillionCharsUsd
  };
}

function messageFor(status) {
  return {
    400: 'The speech request was rejected. Check the voice and model.',
    401: 'The speech API key was rejected. Check the key in Settings.',
    403: 'This key does not have permission to use speech synthesis.',
    404: 'The speech model was not found. Check the model name in Settings.',
    429: 'The speech rate or usage limit was reached. Retry later.',
    500: 'The speech service had an error. Retry later.',
    503: 'The speech service was unavailable. Retry later.'
  }[status] || ('Speech synthesis failed (HTTP ' + status + '). Retry later.');
}

/* Splits text into chunks a single request can carry, preferring sentence boundaries. */
function splitText(text, limit = 4000) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > limit && current) { chunks.push(current.trim()); current = ''; }
    // A single sentence longer than the limit is hard-split; there is no better boundary.
    if (sentence.length > limit) {
      for (let index = 0; index < sentence.length; index += limit) chunks.push(sentence.slice(index, index + limit).trim());
      continue;
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

/* Synthesizes one piece of text to a file. Returns the written path and byte size. */
async function speak({text, targetPath, apiKey, model, voice, speed, format = 'mp3', fetchImpl = fetch, timeoutMs = 180000}) {
  if (!apiKey) fail('No speech API key is configured. Add one in Settings.', 409);
  const chunks = splitText(text, PROVIDERS.openai.maxCharsPerRequest);
  if (!chunks.length) fail('There is no narration text to speak.', 400);

  const buffers = [];
  for (const chunk of chunks) {
    let response;
    try {
      response = await fetchImpl(PROVIDERS.openai.endpoint, {
        method: 'POST',
        headers: {'authorization': 'Bearer ' + apiKey, 'content-type': 'application/json'},
        body: JSON.stringify({
          model: resolveModel(model),
          voice: voice || PROVIDERS.openai.defaultVoice,
          input: chunk,
          response_format: format,
          ...(speed ? {speed} : {})
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      fail(timedOut ? 'Speech synthesis timed out. Nothing was saved. Retry when ready.' : 'Could not reach the speech service. Check your connection and retry.');
    }
    if (!response.ok) fail(messageFor(response.status), response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) fail('The speech service returned an empty audio file.');
    buffers.push(buffer);
  }

  // A single request is already a valid audio file; multiple chunks are concatenated as MP3 frames,
  // which players accept because MP3 is a sequence of self-contained frames.
  fs.mkdirSync(require('node:path').dirname(targetPath), {recursive: true});
  fs.writeFileSync(targetPath, Buffer.concat(buffers));
  return {path: targetPath, bytes: fs.statSync(targetPath).size, chunks: chunks.length, characters: String(text).length, model: resolveModel(model), voice: voice || PROVIDERS.openai.defaultVoice};
}

module.exports = {PROVIDERS, providerIds, providerConfig, resolveModel, estimateCost, speak, splitText, messageFor};
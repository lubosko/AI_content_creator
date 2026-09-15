'use strict';
/* OpenAI adapter. Speech transcription lives in transcribe.js; this module covers the connection
   check so Settings can verify a key and model before anything is paid for. */

const DEFAULT_BASE = 'https://api.openai.com/v1';

function fail(message, status = 502) { throw Object.assign(new Error(message), {status}); }

/* Confirms the key works and reports which models carry audio transcription.
   This is free: it lists models and never uploads audio, so no transcription is billed. */
async function testConnection({apiKey, model, fetchImpl = fetch, baseUrl = DEFAULT_BASE, timeoutMs = 20000} = {}) {
  if (!apiKey) fail('OpenAI is not configured. Add your API key in Settings.', 409);
  let response;
  try {
    response = await fetchImpl(baseUrl + '/models', {
      method: 'GET',
      redirect: 'error',
      headers: {authorization: 'Bearer ' + apiKey},
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    fail(timedOut ? 'OpenAI timed out. Retry when ready.' : 'Could not reach OpenAI. Check your internet connection and retry.');
  }
  if (!response.ok) {
    // Never echo the provider body: it can contain request content.
    const messages = {
      401: 'OpenAI rejected the API key. Check the saved key in Settings.',
      403: 'This API key does not have permission to list models. A restricted key may not work for transcription.',
      429: 'OpenAI rate or usage limit reached. Retry later.'
    };
    fail(messages[response.status] || 'OpenAI request failed (HTTP ' + response.status + '). Retry later.');
  }

  let payload;
  try { payload = await response.json(); } catch (error) { fail('OpenAI returned a response that could not be read.'); }
  const ids = Array.isArray(payload && payload.data) ? payload.data.map(item => String(item.id || '')) : [];
  const transcriptionModels = ids.filter(id => /whisper|transcribe/i.test(id));
  const requested = model || 'whisper-1';
  const available = ids.includes(requested);

  return {
    provider: 'openai',
    connected: true,
    model: requested,
    modelAvailable: available,
    transcriptionModels,
    message: available
      ? 'API key and model access verified. The key works and "' + requested + '" is available to this account. Transcribing audio is billed separately.'
      : 'The key works, but "' + requested + '" is not in this account\'s model list. Available transcription models: ' + (transcriptionModels.join(', ') || 'none reported') + '.'
  };
}

module.exports = {testConnection};
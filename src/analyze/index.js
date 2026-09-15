'use strict';
/* Analysis registry and orchestrator. One entry point, one honest outcome per asset.
   Import success never implies analysis success: every analyzer returns either content or a reason. */

const fs = require('node:fs');
const path = require('node:path');
const {classify, imageSize, head} = require('./detect');
const {probeMedia, extractThumbnail, aspectRatio: aspectRatioOf} = require('./media');
const {extractTextFile, extractUrl} = require('./text');
const {extractPdfText} = require('./pdf');
const {extractAudio, splitAudio, audioDuration, toVtt} = require('./audio');
const {estimateCost} = require('../providers/transcribe');
const {detectMediaTools} = require('../config/capabilities');

/* Transcription costs money per minute, so anything longer than this asks first unless the caller
   has already confirmed. The estimate shown to the user comes from the provider's own price. */
const TRANSCRIBE_CONFIRM_SECONDS = 600;

/* Every prompt-visible message about analysis lives here, so the UI never has to guess. */
const MESSAGES = {
  awaiting: 'Imported. Not analyzed yet.',
  analyzing: 'Analyzing...',
  analyzed: 'Analyzed.',
  failed: 'Analysis failed.',
  unsupported: 'Stored, but this type cannot be analyzed yet.',
  needsConfirmation: 'This file is long. Confirm before paying for transcription.'
};

/* retryable distinguishes a failure a retry could fix (missing tool, unreachable page) from one
   that is a property of the file itself. Without it a sweep would retry the same file forever. */
function unsupportedOutcome(reason) {
  return {state: 'unsupported', reason, supported: false, retryable: false};
}

function failedOutcome(reason, retryable = true) {
  return {state: 'failed', reason, supported: true, retryable};
}

async function analyzeFile(asset, options) {
  const filePath = options.filePath;
  if (!fs.existsSync(filePath)) return failedOutcome('The saved original is missing. Import the file again.');

  const detected = classify(filePath, {name: asset.name, mime: asset.mime});
  if (detected.kind === 'unsupported') return unsupportedOutcome(detected.reason);

  if (detected.kind === 'text') {
    const extracted = extractTextFile(filePath, options);
    // Binary content behind a .txt name is a property of the file; retrying will not help.
    if (!extracted.ok) return failedOutcome(extracted.reason, !/binary data/.test(extracted.reason));
    return {
      state: 'analyzed',
      supported: true,
      detected: {type: 'text', label: detected.label},
      content: {text: extracted.content.text, characters: extracted.content.characters, truncated: extracted.content.truncated},
      note: extracted.content.note
    };
  }

  if (detected.kind === 'pdf') return analyzePdf(asset, options);

  // Images have no streams to probe: read the header for real dimensions instead.
  if (detected.detail === 'image') {
    const size = imageSize(filePath, head(filePath, 32));
    return {
      state: 'analyzed',
      supported: true,
      detected: {type: 'image', label: detected.label},
      media: {
        hasVideo: false, hasAudio: false,
        width: size ? size.width : null,
        height: size ? size.height : null,
        imageFormat: size ? size.format : null,
        aspectRatio: size ? aspectRatioOf(size.width, size.height) : null,
        sizeBytes: fs.statSync(filePath).size
      },
      warnings: size ? [] : ['The image dimensions could not be read from this file.']
    };
  }

  // Media: metadata comes from ffprobe. Transcription is Phase 2 and is reported as missing rather
  // than silently absent.
  const probed = probeMedia(filePath, {tools: options.tools, execFileSync: options.execFileSync});
  // A missing ffprobe is retryable; an unreadable file is not.
  if (!probed.ok) return failedOutcome(probed.reason, /not available/.test(probed.reason));
  const metadata = probed.metadata;
  const warnings = [];
  if (metadata.hasVideo && !metadata.hasAudio) warnings.push('This clip has no audio track.');
  if (!metadata.hasVideo && !metadata.hasAudio) warnings.push('No audio or video streams were found.');

  let thumbnail = null;
  if (metadata.hasVideo && options.thumbnailPath) {
    const extracted = extractThumbnail(filePath, options.thumbnailPath, {tools: options.tools, execFileSync: options.execFileSync});
    thumbnail = extracted.ok ? {path: path.basename(options.thumbnailPath), bytes: extracted.bytes} : null;
    if (!extracted.ok) warnings.push('A preview frame could not be extracted.');
  }

  // Speech becomes text, which is what research and captions actually need.
  const transcription = metadata.hasAudio
    ? await transcribeMedia({asset, filePath, metadata, options})
    : {status: 'none', reason: 'This file has no audio track, so there is nothing to transcribe.'};
  if (transcription.status === 'needs_confirmation') {
    return {
      state: 'needs_confirmation',
      supported: true,
      detected: {type: metadata.hasVideo ? 'video' : 'audio', label: detected.label},
      media: metadata,
      thumbnail,
      transcription,
      warnings
    };
  }
  if (transcription.warning) warnings.push(transcription.warning);
  const record = Object.assign({
    state: 'analyzed',
    supported: true,
    detected: {type: metadata.hasVideo ? 'video' : 'audio', label: detected.label},
    media: metadata,
    thumbnail,
    warnings
  }, outcomeExtras(transcription));
  return record;
}

/* Transcription is always reported, even when it did nothing, so the card can say why. The
   transcript itself is promoted to content, which is what research and captions consume. */
function outcomeExtras(transcription) {
  if (!transcription) return {};
  return {
    transcription,
    content: transcription.status === 'done' ? transcription.content : null
  };
}

/* Prepares and runs speech-to-text. Returns a status rather than throwing, so a transcription
   problem never discards the media metadata that was already read successfully. */
async function transcribeMedia({asset, filePath, metadata, options}) {
  const tools = options.tools || detectMediaTools(options.detectOptions || {});
  const ffmpegAvailable = tools.some(tool => tool.name === 'ffmpeg' && tool.available);
  const durationSeconds = metadata.durationSeconds;

  if (!ffmpegAvailable && !options.audioPath) {
    return {status: 'failed', reason: 'ffmpeg is not available, so the audio track cannot be prepared for transcription.'};
  }
  if (!options.transcribe) {
    return {status: 'none', reason: 'No transcription provider is configured. Add an API key in Settings to transcribe speech.'};
  }

  const estimate = estimateCost(durationSeconds, options.transcribe.provider);
  // Long audio costs real money, so it asks first unless the caller already confirmed.
  if (!options.confirmLong && durationSeconds && durationSeconds > TRANSCRIBE_CONFIRM_SECONDS) {
    return {
      status: 'needs_confirmation',
      reason: 'This file is ' + Math.round(durationSeconds / 60) + ' minute(s) long. Transcription costs money per minute.',
      durationSeconds,
      estimate,
      thresholdSeconds: TRANSCRIBE_CONFIRM_SECONDS
    };
  }

  const audioPath = options.audioPath;
  if (!audioPath) return {status: 'failed', reason: 'No location was provided to store the prepared audio.'};

  const prepared = extractAudio(filePath, audioPath, {tools, execFileSync: options.execFileSync, durationSeconds});
  if (!prepared.ok) return {status: 'failed', reason: prepared.reason};

  let parts = [{index: 0, path: prepared.path, startSeconds: 0, bytes: prepared.bytes}];
  if (prepared.segments > 1) {
    const split = splitAudio(prepared.path, path.join(path.dirname(audioPath), 'parts'), prepared.segmentSeconds, {tools, execFileSync: options.execFileSync, durationSeconds: prepared.durationSeconds});
    if (!split.ok) return {status: 'failed', reason: split.reason};
    parts = split.parts;
  }

  try {
    const result = await options.transcribe.run({parts, language: options.language});
    if (!result.text) return {status: 'failed', reason: 'The transcription service returned no speech for this file.'};
    return {
      status: 'done',
      model: result.model,
      provider: options.transcribe.provider,
      language: result.language,
      parts: result.parts,
      durationSeconds: prepared.durationSeconds,
      costUsd: estimate ? estimate.usd : null,
      segments: result.segments,
      vtt: result.vtt,
      content: {text: result.text.slice(0, 20000), characters: result.text.length, truncated: result.text.length > 20000}
    };
  } catch (error) {
    // Transcription failure keeps the metadata: the file was still read successfully.
    return {status: 'failed', reason: (error && error.message) || 'Transcription failed.'};
  }
}

function analyzePdf(asset, options) {
  const extracted = extractPdfText(options.filePath, options);
  if (!extracted.ok) return failedOutcome(extracted.reason, extracted.retryable !== false);
  return {
    state: 'analyzed',
    supported: true,
    detected: {type: 'pdf', label: 'PDF'},
    content: {text: extracted.content.text, characters: extracted.content.characters, truncated: extracted.content.truncated, title: extracted.content.title},
    pages: extracted.pages || null,
    note: extracted.note
  };
}

async function analyzeUrl(asset, options) {
  const extracted = await extractUrl(asset.content, {fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs});
  if (!extracted.ok) return failedOutcome(extracted.reason);
  return {
    state: 'analyzed',
    supported: true,
    detected: {type: 'url', label: 'web page'},
    content: {text: extracted.content.text, characters: extracted.content.characters, truncated: extracted.content.truncated, title: extracted.content.title},
    url: {fetchedAt: extracted.content.fetchedAt},
    note: extracted.content.note
  };
}

function analyzeNote(asset) {
  const text = String(asset.content || '');
  if (!text.trim()) return failedOutcome('This note is empty.');
  return {
    state: 'analyzed',
    supported: true,
    detected: {type: 'note', label: 'note'},
    content: {text, characters: text.length, truncated: false}
  };
}

/* Runs the right analyzer for one asset. Never throws for an analysis problem; only for a bug. */
async function analyzeAsset(asset, options = {}) {
  const startedAt = new Date().toISOString();
  let outcome;
  try {
    if (asset.kind === 'note') outcome = analyzeNote(asset);
    else if (asset.kind === 'url') outcome = await analyzeUrl(asset, options);
    else if (asset.kind === 'file') outcome = await analyzeFile(asset, options);
    else outcome = unsupportedOutcome('This item has no analyzable content.');
  } catch (error) {
    outcome = failedOutcome('Analysis failed unexpectedly: ' + (error && error.message ? error.message : 'unknown error'));
  }
  return Object.assign({
    state: outcome.state,
    supported: outcome.supported,
    retryable: outcome.retryable !== false,
    analyzedAt: new Date().toISOString(),
    startedAt,
    reason: outcome.reason || null,
    detected: outcome.detected || null,
    content: outcome.content || null,
    media: outcome.media || null,
    thumbnail: outcome.thumbnail || null,
    transcription: outcome.transcription || null,
    pages: outcome.pages || null,
    warnings: outcome.warnings || [],
    note: outcome.note || null
  });
}

/* State a material card should show, derived from the stored analysis record. */
function analysisState(asset) {
  const record = asset && asset.analysis;
  if (!record || !record.state) return 'awaiting_analysis';
  return record.state;
}

function analysisSummary(asset) {
  const record = asset && asset.analysis;
  const state = analysisState(asset);
  const byState = {
    awaiting_analysis: {label: 'Awaiting analysis', tone: 'info', message: MESSAGES.awaiting},
    analyzing: {label: 'Analyzing', tone: 'running', message: MESSAGES.analyzing},
    analyzed: {label: 'Analyzed', tone: 'ok', message: MESSAGES.analyzed},
    failed: {label: 'Analysis failed', tone: 'failed', message: (record && record.reason) || MESSAGES.failed},
    unsupported: {label: 'Not supported', tone: 'locked', message: (record && record.reason) || MESSAGES.unsupported},
    // Long audio is read but not transcribed until the cost is confirmed. The metadata is real,
    // so this is not a failure and not a finished result either.
    needs_confirmation: {label: 'Confirm transcription', tone: 'review', message: (record && record.reason) || MESSAGES.needsConfirmation}
  };
  const chosen = byState[state] || byState.awaiting_analysis;
  // A failure that is a property of the file is not offered as retryable: the same inputs would
  // produce the same result.
  const retryable = state === 'failed' && record ? record.retryable !== false : false;
  return {
    state,
    label: chosen.label,
    tone: chosen.tone,
    message: chosen.message,
    retryable,
    needsConfirmation: state === 'needs_confirmation',
    estimate: (record && record.transcription && record.transcription.estimate) || null,
    durationSeconds: (record && record.transcription && record.transcription.durationSeconds) || null,
    canAnalyze: state === 'awaiting_analysis' || retryable,
    record: record || null
  };
}

module.exports = {analyzeAsset, analysisState, analysisSummary, detectMediaTools, MESSAGES};
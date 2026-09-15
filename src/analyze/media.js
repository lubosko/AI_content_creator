'use strict';
/* Media metadata via ffprobe. Uses the shared capability detector so a WinGet install is found
   even when the running process PATH predates it. */

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {detectMediaTools} = require('../config/capabilities');

const PROBE_TIMEOUT_MS = 30000;

function aspectRatio(width, height) {
  if (!width || !height) return null;
  const divisor = (a, b) => (b ? divisor(b, a % b) : a);
  const factor = divisor(width, height);
  return (width / factor) + ':' + (height / factor);
}

function parseRate(value) {
  const text = String(value || '');
  const parts = text.split('/');
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const rate = numerator / denominator;
  return rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/* Probes a file with ffprobe. Returns a plain result object; never throws for a bad media file. */
function probeMedia(filePath, options = {}) {
  const tools = options.tools || detectMediaTools(options.detectOptions || {});
  const ffprobe = tools.find(tool => tool.name === 'ffprobe');
  if (!ffprobe || !ffprobe.available) {
    return {ok: false, reason: 'ffprobe is not available, so media metadata cannot be read. Install FFmpeg and try again.'};
  }
  const run = options.execFileSync || execFileSync;
  let raw;
  try {
    raw = run(ffprobe.path, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], {
      encoding: 'utf8', timeout: options.timeoutMs || PROBE_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    return {ok: false, reason: 'ffprobe could not read this file. It may be corrupt, incomplete, or an unsupported codec.'};
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { return {ok: false, reason: 'ffprobe returned metadata that could not be read.'}; }
  if (!parsed || !Array.isArray(parsed.streams) || !parsed.streams.length) {
    return {ok: false, reason: 'No audio or video streams were found in this file.'};
  }

  const format = parsed.format || {};
  const streams = parsed.streams.map(stream => ({
    type: stream.codec_type || 'unknown',
    codec: stream.codec_name || null,
    width: stream.width || null,
    height: stream.height || null,
    frameRate: parseRate(stream.r_frame_rate),
    channels: stream.channels || null,
    sampleRate: toNumber(stream.sample_rate),
    durationSeconds: toNumber(stream.duration),
    bitRate: toNumber(stream.bit_rate)
  }));
  const video = streams.find(stream => stream.type === 'video') || null;
  const audio = streams.find(stream => stream.type === 'audio') || null;
  const duration = toNumber(format.duration) || (video && video.durationSeconds) || (audio && audio.durationSeconds) || null;

  return {
    ok: true,
    metadata: {
      container: format.format_name || null,
      containerLong: format.format_long_name || null,
      durationSeconds: duration,
      sizeBytes: toNumber(format.size),
      bitRate: toNumber(format.bit_rate),
      hasVideo: !!video,
      hasAudio: !!audio,
      width: video ? video.width : null,
      height: video ? video.height : null,
      aspectRatio: video ? aspectRatio(video.width, video.height) : null,
      frameRate: video ? video.frameRate : null,
      videoCodec: video ? video.codec : null,
      audioCodec: audio ? audio.codec : null,
      audioChannels: audio ? audio.channels : null,
      sampleRate: audio ? audio.sampleRate : null,
      streams
    }
  };
}

/* Extracts one representative frame so a video can be chosen by eye. Best effort: a failure here
   must not fail the analysis. */
function extractThumbnail(filePath, targetPath, options = {}) {
  const tools = options.tools || detectMediaTools(options.detectOptions || {});
  const ffmpeg = tools.find(tool => tool.name === 'ffmpeg');
  if (!ffmpeg || !ffmpeg.available) return {ok: false, reason: 'ffmpeg is not available.'};
  const run = options.execFileSync || execFileSync;
  try {
    fs.mkdirSync(path.dirname(targetPath), {recursive: true});
    run(ffmpeg.path, ['-y', '-v', 'error', '-ss', '1', '-i', filePath, '-frames:v', '1', '-vf', 'scale=640:-2', targetPath], {
      encoding: 'utf8', timeout: options.timeoutMs || PROBE_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) return {ok: false, reason: 'No frame could be extracted (the clip may be shorter than one second).'};
    return {ok: true, path: targetPath, bytes: fs.statSync(targetPath).size};
  } catch (error) {
    return {ok: false, reason: 'The preview frame could not be extracted.'};
  }
}

module.exports = {probeMedia, extractThumbnail, aspectRatio, parseRate};
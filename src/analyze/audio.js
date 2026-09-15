'use strict';
/* Extracts an audio track for speech-to-text.
   A 100 MB video is far over any transcription API's per-request limit, so the audio is
   re-encoded down to a small mono stream first. Everything here degrades honestly: when ffmpeg
   cannot produce audio, the reason says why. */

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {detectMediaTools} = require('../config/capabilities');

const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
const TARGET_BYTES = 24 * 1024 * 1024;   // stay under a 25 MB per-request limit
const DEFAULT_SEGMENT_SECONDS = 15 * 60; // conservative chunks for wide API compatibility

function tools(options) { return options.tools || detectMediaTools(options.detectOptions || {}); }

function binary(options, name) {
  const found = tools(options).find(tool => tool.name === name);
  return found && found.available ? found.path : null;
}

/* Duration in seconds, or null when it cannot be determined. */
function audioDuration(filePath, options = {}) {
  const ffprobe = binary(options, 'ffprobe');
  if (!ffprobe) return null;
  const run = options.execFileSync || execFileSync;
  try {
    const raw = run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const value = Number(String(raw).trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (error) { return null; }
}

/* Re-encodes the audio track to 16 kHz mono FLAC, which is small and widely accepted.
   Returns {ok:true, path, bytes, durationSeconds, segments} or {ok:false, reason}. */
function extractAudio(filePath, targetPath, options = {}) {
  const ffmpeg = binary(options, 'ffmpeg');
  if (!ffmpeg) return {ok: false, reason: 'ffmpeg is not available, so audio cannot be prepared for transcription. Install FFmpeg and try again.'};
  const run = options.execFileSync || execFileSync;
  fs.mkdirSync(path.dirname(targetPath), {recursive: true});

  try {
    run(ffmpeg, ['-y', '-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', '-compression_level', '8', targetPath], {
      encoding: 'utf8', timeout: options.timeoutMs || EXTRACT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    return {ok: false, reason: 'The audio track could not be extracted. The file may have no audio, or the codec is unsupported.'};
  }

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    return {ok: false, reason: 'No audio track was found in this file, so there is nothing to transcribe.'};
  }

  const bytes = fs.statSync(targetPath).size;
  const durationSeconds = options.durationSeconds || audioDuration(filePath, options);
  // Split only when one request would exceed the limit; format support for long uploads varies.
  const segmentSeconds = bytes > TARGET_BYTES
    ? Math.max(60, Math.floor((options.segmentSeconds || DEFAULT_SEGMENT_SECONDS) * (TARGET_BYTES / bytes)))
    : null;

  return {ok: true, path: targetPath, bytes, durationSeconds, segments: segmentSeconds ? Math.ceil((durationSeconds || 0) / segmentSeconds) : 1, segmentSeconds};
}

/* Splits the prepared audio into time-ranged parts. Returns a list of {index, path, startSeconds}. */
function splitAudio(preparedPath, targetDir, segmentSeconds, options = {}) {
  const ffmpeg = binary(options, 'ffmpeg');
  if (!ffmpeg) return {ok: false, reason: 'ffmpeg is not available.'};
  const run = options.execFileSync || execFileSync;
  fs.mkdirSync(targetDir, {recursive: true});

  const parts = [];
  const total = options.durationSeconds || audioDuration(preparedPath, options) || 0;
  const count = Math.max(1, Math.ceil(total / segmentSeconds));
  try {
    for (let index = 0; index < count; index++) {
      const start = index * segmentSeconds;
      const partPath = path.join(targetDir, 'part-' + String(index).padStart(3, '0') + '.flac');
      run(ffmpeg, ['-y', '-v', 'error', '-ss', String(start), '-t', String(segmentSeconds), '-i', preparedPath, '-c', 'copy', partPath], {
        encoding: 'utf8', timeout: options.timeoutMs || EXTRACT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      if (fs.existsSync(partPath) && fs.statSync(partPath).size > 0) parts.push({index, path: partPath, startSeconds: start, bytes: fs.statSync(partPath).size});
    }
  } catch (error) {
    return {ok: false, reason: 'The prepared audio could not be split for transcription.'};
  }
  return {ok: true, parts};
}

/* Formats seconds as a WebVTT timestamp. */
function vttTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  const pad = (value, size) => String(value).padStart(size, '0');
  return pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(secs, 2) + '.' + pad(millis, 3);
}

/* Builds a WebVTT file from timed segments, offsetting each by the segment's start time.
   Captions are reused by the composer later, so this is written as a real artifact. */
function toVtt(segments) {
  const lines = ['WEBVTT', ''];
  let index = 1;
  for (const segment of segments) {
    const text = String(segment.text || '').trim();
    if (!text) continue;
    const start = Number(segment.start) || 0;
    const end = Number(segment.end) > start ? Number(segment.end) : start + 2;
    lines.push(String(index++));
    lines.push(vttTimestamp(start) + ' --> ' + vttTimestamp(end));
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
}

function toPlainText(segments) {
  return segments.map(segment => String(segment.text || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  extractAudio, splitAudio, audioDuration, toVtt, toPlainText, vttTimestamp,
  TARGET_BYTES, DEFAULT_SEGMENT_SECONDS, EXTRACT_TIMEOUT_MS
};
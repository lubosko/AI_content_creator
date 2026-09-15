'use strict';
/* Captions for the composed video.

   The narration audio carries no word-level timings: it is synthesized per script section and the
   only duration known is the measured length of each file. Cue timing is therefore estimated, and
   the timeline and the QC report both say so. The alternative is paying to transcribe audio this app
   just generated, which would re-derive the timings less accurately than the text already in hand.

   A section often spans several scenes, and its audio is split across them in proportion to their
   durations. The words follow the same split, so a section is never captioned twice. */

const MAX_LINE = 42;
const MAX_LINES = 2;
const MAX_CUE = MAX_LINE * MAX_LINES;

function clean(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/* Pure sentences. No merging: merging happens per scene window, so that a sentence never has to
   cross from one scene into the next. */
function sentences(text) {
  const source = clean(text);
  if (!source) return [];
  return (source.match(/[^.!?]+[.!?]*\s*/g) || [source]).map(clean).filter(Boolean);
}

/* Merges sentences into cue-sized pieces, and breaks a sentence that is longer than a cue on word
   boundaries rather than mid-word. */
function groupIntoCues(pieces) {
  const cues = [];
  let current = '';
  for (const piece of (pieces || [])) {
    const candidate = current ? current + ' ' + piece : piece;
    if (candidate.length <= MAX_CUE) { current = candidate; continue; }
    if (current) cues.push(current);
    current = '';
    if (piece.length <= MAX_CUE) { current = piece; continue; }
    let line = '';
    for (const word of piece.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (next.length > MAX_CUE) { cues.push(line); line = word; }
      else line = next;
    }
    current = line;
  }
  if (current) cues.push(current);
  return cues;
}

/* Wraps a cue into at most two lines at a word boundary. */
function wrapCue(text) {
  const source = clean(text);
  if (source.length <= MAX_LINE) return source;
  const words = source.split(' ');
  const lines = [''];
  for (const word of words) {
    const index = lines.length - 1;
    const next = lines[index] ? lines[index] + ' ' + word : word;
    if (next.length <= MAX_LINE || !lines[index]) lines[index] = next;
    else if (lines.length < MAX_LINES) lines.push(word);
    else lines[index] = next;
  }
  return lines.join('\n');
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(value);
  const ms = Math.round((value - whole) * 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (number, size) => String(number).padStart(size, '0');
  return pad(hours, 2) + ':' + pad(minutes, 2) + ':' + pad(secs, 2) + ',' + pad(ms, 3);
}

function captionsFor({timeline, script}) {
  const sections = new Map((((script && script.sections) || [])).map(section => [String(section.id), section]));
  const track = ((timeline && timeline.tracks) || []).find(item => item.id === 'narration');
  const notes = [];
  const cues = [];

  // The ordered windows per section: the slice of the timeline each scene of that section occupies.
  const windows = new Map();
  for (const clip of (track ? track.clips : [])) {
    if (!clip.section_id) continue;
    const key = String(clip.section_id);
    const start = Number(clip.start_seconds) || 0;
    const span = Number(clip.audio_span_seconds) > 0
      ? Number(clip.audio_span_seconds)
      : Math.max(0, (Number(clip.end_seconds) || 0) - start);
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push({start, span, scene_id: clip.scene_id});
  }

  for (const [sectionId, spans] of windows) {
    const section = sections.get(sectionId);
    const pieces = sentences(section ? section.narration : '');
    if (!pieces.length) {
      notes.push('Section ' + sectionId + ' has no narration text, so it has no captions.');
      continue;
    }
    const totalSpan = spans.reduce((sum, span) => sum + span.span, 0);
    if (!totalSpan) { notes.push('Section ' + sectionId + ' has no measured duration, so its captions were skipped.'); continue; }

    // Where each window's share of the text begins, measured in characters.
    const totalText = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
    const bounds = [];
    let spanSoFar = 0;
    for (const span of spans) {
      spanSoFar += span.span;
      bounds.push(totalText * (spanSoFar / totalSpan));
    }

    // Each sentence goes to the window its text falls into, then cues are formed inside that window.
    const buckets = spans.map(() => []);
    let consumed = 0;
    for (const piece of pieces) {
      const middle = consumed + piece.length / 2;
      consumed += piece.length;
      let index = bounds.findIndex(bound => middle <= bound);
      if (index < 0) index = spans.length - 1;
      buckets[index].push(piece);
    }

    buckets.forEach((bucket, index) => {
      const target = spans[index];
      const windowCues = groupIntoCues(bucket);
      if (!windowCues.length) return;
      const cueText = windowCues.reduce((sum, cue) => sum + cue.length, 0) || 1;
      let cursor = target.start;
      windowCues.forEach((cue, position) => {
        const last = position === windowCues.length - 1;
        const share = last ? (target.start + target.span) - cursor : (cue.length / cueText) * target.span;
        const end = last ? target.start + target.span : cursor + share;
        cues.push({start: cursor, end: Math.max(cursor + 0.4, end), text: wrapCue(cue), scene_id: target.scene_id});
        cursor = end;
      });
    });
  }

  cues.sort((left, right) => left.start - right.start);
  return {
    cues,
    notes,
    timing: 'estimated',
    timing_note: 'Cue timing is estimated by splitting each section\'s measured audio duration across its scenes in proportion to scene length, and inside each scene in proportion to text length. The narration has no word-level timings.'
  };
}

function toSrt(cues) {
  const lines = [];
  (cues || []).forEach((cue, index) => {
    lines.push(String(index + 1));
    lines.push(formatTimestamp(cue.start) + ' --> ' + formatTimestamp(cue.end));
    lines.push(cue.text);
    lines.push('');
  });
  return lines.join('\n');
}

/* Overlapping or out-of-order cues are a real defect, so they are checked rather than assumed. */
function cueProblems(cues, videoSeconds) {
  const problems = [];
  let previousEnd = -1;
  (cues || []).forEach((cue, index) => {
    if (cue.end <= cue.start) problems.push('Cue ' + (index + 1) + ' ends before it starts.');
    if (cue.start < previousEnd - 0.001) problems.push('Cue ' + (index + 1) + ' overlaps the one before it.');
    previousEnd = cue.end;
  });
  const last = cues && cues.length ? cues[cues.length - 1] : null;
  if (last && Number.isFinite(videoSeconds) && last.end > videoSeconds + 1) {
    problems.push('The last cue ends at ' + last.end.toFixed(2) + 's, after the video ends at ' + Number(videoSeconds).toFixed(2) + 's.');
  }
  return problems;
}

module.exports = {captionsFor, toSrt, cueProblems, sentences, groupIntoCues, wrapCue, formatTimestamp, MAX_LINE, MAX_LINES};
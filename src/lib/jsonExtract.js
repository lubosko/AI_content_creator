'use strict';
/* Pulls a JSON value out of a model response. Models wrap JSON in prose or code fences, and a
   malformed answer must be a clear failure rather than a crash deep inside a stage. */

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return {ok: false, reason: 'The model returned an empty response.'};

  // Prefer a fenced block, then the widest brace or bracket span.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct.ok) return direct;
    const span = widestSpan(candidate);
    if (span) {
      const parsed = tryParse(span);
      if (parsed.ok) return parsed;
    }
  }
  return {ok: false, reason: 'The model did not return readable JSON.'};
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? {ok: true, value} : {ok: false};
  } catch (error) { return {ok: false}; }
}

/* The span from the first opening bracket to the last matching closing bracket. */
function widestSpan(text) {
  const starts = [text.indexOf('{'), text.indexOf('[')].filter(index => index >= 0);
  if (!starts.length) return null;
  const start = Math.min.apply(null, starts);
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : null;
}

module.exports = {extractJson};
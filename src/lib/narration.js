'use strict';
/* Narration production: script sections become real audio files with measured durations.
   The composer needs real timings and real audio, so both are produced here rather than estimated. */

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {detectMediaTools} = require('../config/capabilities');
const {estimateCost} = require('../providers/speech');

/* Real duration in seconds from ffprobe, or null when it cannot be read. */
function measuredDuration(filePath, options = {}) {
  const tools = options.tools || detectMediaTools(options.detectOptions || {});
  const ffprobe = tools.find(tool => tool.name === 'ffprobe');
  if (!ffprobe || !ffprobe.available) return null;
  const run = options.execFileSync || execFileSync;
  try {
    const raw = run(ffprobe.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const value = Number(String(raw).trim());
    return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
  } catch (error) { return null; }
}

function narrationText(section) {
  return String((section && section.narration) || '').trim();
}

/* Produces one audio file per script section. Sections with no narration are reported, not skipped
   silently. A failure on one section does not discard the audio already produced. */
async function produceNarration({sections, audioDir, projectDirectory, speak, tools, execFileSync: run}) {
  const results = [];
  let totalCharacters = 0;
  let produced = 0;
  fs.mkdirSync(audioDir, {recursive: true});
  // Stored paths are relative to the project root so the interface can serve them directly.
  const anchor = path.resolve(projectDirectory || path.dirname(audioDir));
  const asProjectPath = filePath => path.relative(anchor, filePath).split(path.sep).join('/');

  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    const text = narrationText(section);
    const id = String(section.id || ('section_' + (index + 1)));
    const fileName = String(index + 1).padStart(3, '0') + '-' + id.replace(/[^a-z0-9_-]+/gi, '_') + '.mp3';
    const targetPath = path.join(audioDir, fileName);

    if (!text) {
      results.push({section_id: id, title: section.title || null, section_index: index, status: 'empty', reason: 'This section has no narration text to speak.'});
      continue;
    }
    try {
      const spoken = await speak({text, targetPath});
      const duration = measuredDuration(targetPath, {tools, execFileSync: run});
      totalCharacters += spoken.characters;
      produced++;
      results.push({
        section_id: id,
        title: section.title || null,
        section_index: index,
        status: 'done',
        path: asProjectPath(targetPath),
        file: fileName,
        characters: spoken.characters,
        bytes: spoken.bytes,
        chunks: spoken.chunks,
        model: spoken.model,
        voice: spoken.voice,
        duration_seconds: duration,
        // An unmeasurable duration is stated rather than guessed at.
        duration_measured: duration !== null
      });
    } catch (error) {
      results.push({section_id: id, title: section.title || null, section_index: index, status: 'failed', reason: error.message});
    }
  }

  const failed = results.filter(item => item.status === 'failed').length;
  const empty = results.filter(item => item.status === 'empty').length;
  const totalSeconds = results.reduce((sum, item) => sum + (item.duration_seconds || 0), 0);
  return {
    sections: results,
    produced,
    failed,
    empty,
    totalSeconds: Math.round(totalSeconds * 1000) / 1000,
    totalCharacters,
    estimate: estimateCost(totalCharacters)
  };
}

module.exports = {produceNarration, measuredDuration, narrationText};
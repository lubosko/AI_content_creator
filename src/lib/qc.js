'use strict';
/* Quality control for a composed video.

   Every check is made against the real file, never against the plan that was supposed to produce it.
   A check that cannot be measured reports `unknown` with the reason rather than passing quietly, and
   anything in `blocking_issues` stops the master being approved. */

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const captions = require('./captions');

const BLACK_SECONDS = 1.5;
const BLACK_BLOCKING_SECONDS = 3;
/* Luma below which a pixel counts as black, and the share of the frame that must be black.
   ffmpeg's default threshold of 0.10 flags a deliberately dark picture: the scene templates use a
   near-black background at about 0.05 luma, so a dark-themed video would be reported as blank. The
   threshold here is low enough to mean "no picture at all", which is what a failed render produces,
   while a deliberate dark theme passes. */
const BLACK_PIXEL_THRESHOLD = 0.02;
const BLACK_RATIO_THRESHOLD = 0.98;
const DURATION_TOLERANCE = 1.0;
const LOUDNESS_RANGE = {min: -24, max: -8};

function check(id, label, ok, detail) {
  return {id, label, ok: ok === null ? null : !!ok, detail: detail || ''};
}

function capture(command, args, options = {}) {
  const run = options.spawnSync || spawnSync;
  const result = run(command, args, {encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: options.timeoutMs || 15 * 60 * 1000});
  return {ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || ''};
}

/* FFmpeg prints blackdetect and loudnorm results on stderr and exits zero, so they are read from
   stderr rather than from a throw. */
function longestBlackRun(file, ffmpeg, options) {
  const result = capture(ffmpeg, ['-hide_banner', '-i', file, '-vf',
    'blackdetect=d=' + BLACK_SECONDS + ':pix_th=' + BLACK_PIXEL_THRESHOLD + ':picture_black_ratio_th=' + BLACK_RATIO_THRESHOLD,
    '-an', '-f', 'null', '-'], options);
  if (!result.ok && !/black_start/.test(result.stderr)) return {measured: false, reason: 'blackdetect could not run.'};
  const durations = [...String(result.stderr).matchAll(/black_duration:([0-9.]+)/g)].map(match => Number(match[1]));
  return {measured: true, longest: durations.length ? Math.max(...durations) : 0, count: durations.length};
}

function loudness(file, ffmpeg, options) {
  const result = capture(ffmpeg, ['-hide_banner', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], options);
  const match = String(result.stderr).match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (!match) return {measured: false, reason: 'loudness could not be measured.'};
  try {
    const parsed = JSON.parse(match[0]);
    const input = Number(parsed.input_i);
    /* A silent or absent audio track makes loudnorm report "-inf", which Number() turns into NaN.
       Reporting "the audio measures NaN LUFS" would be a misleading blocking failure for a video
       that simply has nothing to measure, so that case is reported as not measured instead. The
       has_audio check is the one that decides whether silence is a problem. */
    if (!Number.isFinite(input)) {
      return {measured: false, reason: 'there is no audio level to measure, so the track is silent or has no audio stream.'};
    }
    return {measured: true, input, target: Number(parsed.target_offset), output: Number(parsed.output_i)};
  } catch (error) { return {measured: false, reason: 'loudness output could not be read.'}; }
}

/* Runs every check. `render` is what composer.compose returned. */
function inspect(input) {
  const {render, manifest, script, storyboard} = input;
  const tools = render.tools;
  const ffmpeg = (tools || []).find(tool => tool.name === 'ffmpeg');
  const options = {spawnSync: input.spawnSync};
  const checks = [];
  const blocking = [];
  const timeline = render.timeline;
  const planned = timeline.duration_seconds;
  /* The plan's clips, not the timeline's: the timeline is the written artifact and deliberately
     carries no absolute paths, so inspecting it would report every scene as having no media. */
  const videoClips = render.plan.videoClips;

  // --- the plan itself ---
  const unfilled = videoClips.filter(clip => !clip.absolute_path);
  checks.push(check('scenes_have_media', 'Every scene has media',
    unfilled.length === 0,
    unfilled.length ? unfilled.map(clip => clip.scene_id).join(', ') + ' have no media; a placeholder was drawn in their place.' : 'All ' + videoClips.length + ' scenes resolved to a file.'));
  if (unfilled.length) blocking.push(unfilled.length + ' scene(s) have no media. Fill them before approving this video.');

  for (const clip of videoClips) {
    if (clip.absolute_path && clip.path) {
      const file = path.join(input.projectDirectory, clip.path);
      if (!fs.existsSync(file)) {
        checks.push(check('media_exists_' + clip.scene_id, 'Media for ' + clip.scene_id + ' exists', false, clip.path + ' is missing.'));
        blocking.push('The media for scene ' + clip.scene_id + ' is missing.');
      }
    }
  }

  // --- the rights gate, re-checked against what was actually placed ---
  const rights = (manifest && manifest.rights) || null;
  checks.push(check('rights_cleared', 'Every clip has a cleared rights basis',
    rights ? !!rights.can_render : null,
    rights ? (rights.can_render ? 'All material is cleared.' : (rights.blocked || []).map(item => item.title).join(', ') + ' are not cleared.') : 'No rights record was found in the asset manifest.'));
  if (rights && rights.can_render === false) blocking.push('Material whose rights are not cleared is in this video.');

  // --- the master file itself ---
  const master = render.master;
  if (!fs.existsSync(master)) {
    checks.push(check('master_exists', 'The master file exists', false, master + ' was not written.'));
    blocking.push('The master video was not written.');
    return {checks, blocking_issues: blocking, can_approve_master: false, measured: {planned_seconds: planned}};
  }
  const size = fs.statSync(master).size;
  checks.push(check('master_exists', 'The master file exists', size > 0, Math.round(size / 1024) + ' KB at ' + path.relative(input.projectDirectory, master).split(path.sep).join('/')));
  if (!size) blocking.push('The master video is empty.');

  const probed = render.probe(master);
  if (!probed || !probed.ok) {
    checks.push(check('master_readable', 'The master can be read', false, probed ? probed.reason : 'ffprobe returned nothing.'));
    blocking.push('The master video could not be read back.');
    return {checks, blocking_issues: blocking, can_approve_master: false, measured: {planned_seconds: planned}};
  }
  const metadata = probed.metadata;
  checks.push(check('master_readable', 'The master can be read', true, metadata.container + ', ' + metadata.videoCodec + '/' + (metadata.hasAudio ? 'audio' : 'no audio')));

  const measured = {
    planned_seconds: planned,
    duration_seconds: metadata.durationSeconds,
    width: metadata.width,
    height: metadata.height,
    frame_rate: metadata.frameRate,
    has_audio: metadata.hasAudio,
    size_bytes: size
  };

  const deviation = Math.abs((metadata.durationSeconds || 0) - planned);
  checks.push(check('duration_matches_plan', 'The duration matches the plan', deviation <= DURATION_TOLERANCE,
    'planned ' + planned.toFixed(2) + 's, measured ' + (metadata.durationSeconds || 0).toFixed(2) + 's'));
  if (deviation > DURATION_TOLERANCE) blocking.push('The master runs ' + (metadata.durationSeconds || 0).toFixed(2) + 's against a plan of ' + planned.toFixed(2) + 's.');

  checks.push(check('resolution', 'The resolution is ' + timeline.width + 'x' + timeline.height,
    metadata.width === timeline.width && metadata.height === timeline.height,
    metadata.width + 'x' + metadata.height));
  if (metadata.width !== timeline.width || metadata.height !== timeline.height) blocking.push('The master is ' + metadata.width + 'x' + metadata.height + '.');

  const rateClose = Math.abs((metadata.frameRate || 0) - timeline.fps) < 0.5;
  checks.push(check('frame_rate', 'The frame rate is ' + timeline.fps + ' fps', rateClose, String(metadata.frameRate)));
  if (!rateClose) blocking.push('The master is ' + metadata.frameRate + ' fps rather than ' + timeline.fps + '.');

  const wantedAudio = ((manifest && manifest.narration) || {}).produced > 0;
  if (wantedAudio) {
    checks.push(check('has_audio', 'The master carries narration audio', metadata.hasAudio, metadata.hasAudio ? 'An audio stream is present.' : 'No audio stream.'));
    if (!metadata.hasAudio) blocking.push('Narration was produced but the master has no audio stream.');
  } else {
    // A silent film is a legitimate outcome when no narration was produced, so this is reported as
    // not applicable rather than as a failed check.
    checks.push(check('has_audio', 'The master carries narration audio', null, metadata.hasAudio ? 'An audio stream is present, though no narration was produced.' : 'No narration was produced, so the video is silent.'));
  }

  // --- captions ---
  const cueProblems = captions.cueProblems(render.captions.cues, metadata.durationSeconds);
  checks.push(check('caption_timing', 'Caption timing is inside the video', cueProblems.length === 0,
    cueProblems.length ? cueProblems.join(' ') : render.captions.cues.length + ' cues, the last ending at ' + (render.captions.cues.length ? render.captions.cues[render.captions.cues.length - 1].end.toFixed(2) : '0') + 's'));
  if (cueProblems.length) blocking.push('The captions do not line up with the video: ' + cueProblems[0]);
  checks.push(check('caption_source', 'Captions match the script', null, render.captions.timing_note));

  // --- script coverage ---
  const sections = ((script && script.sections) || []).map(section => String(section.id));
  const covered = new Set(timeline.tracks.find(track => track.id === 'narration').clips.map(clip => clip.section_id).filter(Boolean).map(String));
  const uncovered = sections.filter(id => !covered.has(id));
  checks.push(check('script_coverage', 'Every script section is in the video', uncovered.length === 0,
    uncovered.length ? 'Not covered: ' + uncovered.join(', ') : sections.length + ' sections are all covered.'));
  if (uncovered.length) blocking.push('Script sections ' + uncovered.join(', ') + ' are missing from the video.');

  // --- picture sanity ---
  if (ffmpeg && ffmpeg.available) {
    const black = longestBlackRun(master, ffmpeg.path, options);
    if (black.measured) {
      const ok = black.longest < BLACK_BLOCKING_SECONDS;
      checks.push(check('black_frames', 'No unexplained black stretch', ok,
        black.count ? black.count + ' black stretch(es), longest ' + black.longest.toFixed(2) + 's' : 'No black stretch longer than ' + BLACK_SECONDS + 's.'));
      if (!ok) blocking.push('The video holds black for ' + black.longest.toFixed(2) + 's, which usually means a scene failed to render.');
    } else {
      checks.push(check('black_frames', 'No unexplained black stretch', null, black.reason));
    }

    const loud = loudness(master, ffmpeg.path, options);
    if (loud.measured) {
      measured.loudness_lufs = loud.input;
      const ok = loud.input >= LOUDNESS_RANGE.min && loud.input <= LOUDNESS_RANGE.max;
      checks.push(check('loudness', 'Loudness is in range', ok, loud.input.toFixed(1) + ' LUFS (accepted ' + LOUDNESS_RANGE.min + ' to ' + LOUDNESS_RANGE.max + ')'));
      if (!ok) blocking.push('The audio measures ' + loud.input.toFixed(1) + ' LUFS, outside ' + LOUDNESS_RANGE.min + ' to ' + LOUDNESS_RANGE.max + '.');
    } else {
      checks.push(check('loudness', 'Loudness is in range', null, loud.reason));
    }
  } else {
    checks.push(check('black_frames', 'No unexplained black stretch', null, 'ffmpeg is not available, so the picture was not sampled.'));
    checks.push(check('loudness', 'Loudness is in range', null, 'ffmpeg is not available, so loudness was not measured.'));
  }

  void storyboard;
  return {
    checks,
    blocking_issues: blocking,
    can_approve_master: blocking.length === 0,
    measured
  };
}

function report(qc, render) {
  const lines = ['# QC Report', '', 'Status: ' + (qc.can_approve_master ? 'passed' : 'blocked'), ''];
  lines.push('Checks: ' + qc.checks.length + '. Blocking issues: ' + qc.blocking_issues.length + '.', '');
  lines.push('## Checks', '');
  for (const item of qc.checks) {
    const mark = item.ok === null ? 'not measured' : (item.ok ? 'pass' : 'FAIL');
    lines.push('- [' + mark + '] ' + item.label + (item.detail ? ' — ' + item.detail : ''));
  }
  if (qc.blocking_issues.length) {
    lines.push('', '## Blocking issues', '');
    for (const issue of qc.blocking_issues) lines.push('- ' + issue);
  }
  if (render && render.warnings && render.warnings.length) {
    lines.push('', '## Warnings from composition', '');
    for (const warning of render.warnings) lines.push('- ' + warning);
  }
  lines.push('', 'This report was produced by inspecting the written master with ffprobe and ffmpeg, not by trusting the plan.', '');
  return lines.join('\n');
}

module.exports = {inspect, report, longestBlackRun, loudness, BLACK_SECONDS, BLACK_BLOCKING_SECONDS, DURATION_TOLERANCE, LOUDNESS_RANGE};
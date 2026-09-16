'use strict';
/* The composer: turns a planned timeline into a playable master.

   Every scene becomes a normalised segment, the segments are concatenated, and the narration is laid
   under them scene by scene so audio and picture cannot drift apart. Segments are normalised first
   rather than assembled in one filter graph, because a single graph over a dozen mixed sources of
   unknown codec is where this kind of pipeline usually fails, and a failure there names no scene. */

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const {detectMediaTools} = require('../config/capabilities');
const {probeMedia} = require('../analyze/media');
const captions = require('./captions');

const DEFAULTS = {width: 1920, height: 1080, fps: 24, crf: 18, preset: 'medium', fallbackSeconds: 3, loudnessTarget: -16};

function fail(message, status = 500) { throw Object.assign(new Error(message), {status}); }

function findTool(tools, name) {
  const found = (tools || detectMediaTools()).find(tool => tool.name === name);
  if (!found || !found.available) fail(name + ' is not available, so the video cannot be composed. Install FFmpeg and try again.');
  return found.path;
}

function pad(index) { return String(index).padStart(3, '0'); }

function kindFromPath(file) {
  const extension = path.extname(String(file || '')).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.mkv', '.m4v'].includes(extension)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(extension)) return 'image';
  return 'video';
}

function quoteForConcat(file) {
  return String(file).split(path.sep).join('/').replace(/'/g, "'\\''");
}

/* A real command runner that keeps the last of FFmpeg's own output for the error message. Silently
   swallowing stderr here would make every render failure "exited with code 1". */
function execute({command, args, run, log, label, timeoutMs = 30 * 60 * 1000}) {
  if (log) log.push({step: label, command: [command].concat(args).join(' ')});
  try {
    (run || execFileSync)(command, args, {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024});
  } catch (error) {
    const raw = error && error.stderr ? String(error.stderr) : '';
    const detail = raw.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
    fail(label + ' failed' + (detail ? ': ' + detail : (error && error.message ? ': ' + error.message : '.')));
  }
}

/* Plans the timeline from the storyboard, the script and what asset production actually produced.
   Pure apart from checking that the files it is about to use exist: no FFmpeg runs here. */
function planTimeline(input) {
  const opts = Object.assign({}, DEFAULTS, input.options || {});
  const projectDirectory = path.resolve(input.projectDirectory);
  const scenes = (input.storyboard && input.storyboard.scenes) || [];
  const manifest = input.manifest || {};
  const filled = new Map((manifest.scenes || []).map(scene => [scene.scene_id, scene]));
  const narration = new Map((((manifest.narration || {}).sections) || []).map(section => [String(section.section_id), section]));
  const warnings = [];
  const blocking = [];
  const videoClips = [];
  const audioClips = [];
  let cursor = 0;

  /* A narration file covers a whole script section, and a section is often spread over several scenes.
     When the recorded narration is longer than the scenes it belongs to, those scenes grow to hold it.

     They used to keep their planned length while the section's audio was split across them in
     proportion to scene length - which sums to the *whole* audio, so wherever the audio did not fit
     the slices ran past their own scene and talked over the next one. The captions inherited the same
     windows and overlapped too, which is what QC caught. Narration is the story, so it is never cut:
     the video gets longer instead, and the warnings below say by how much. */
  const sectionBudget = new Map();
  {
    const planned = new Map();
    for (const scene of scenes) {
      const key = scene.narration_section_id ? String(scene.narration_section_id) : null;
      if (!key) continue;
      if (!planned.has(key)) planned.set(key, {seconds: 0, measured: 0});
      const entry = planned.get(key);
      entry.seconds += Number(scene.seconds) > 0 ? Number(scene.seconds) : 0;
      const record = narration.get(key);
      entry.measured = Math.max(entry.measured, record ? Number(record.duration_seconds) || 0 : 0);
    }
    for (const [key, entry] of planned) {
      sectionBudget.set(key, {planned: entry.seconds, measured: entry.measured, total: Math.max(entry.seconds, entry.measured)});
    }
  }

  scenes.forEach((scene, index) => {
    const record = filled.get(scene.id) || null;
    const status = record ? record.status : 'missing';
    let absolute = null;
    let libraryFile = null;
    let assetId = null;
    let source = 'missing';
    let kind = 'video';

    if (record && status === 'own_media' && record.asset_id) {
      const resolved = typeof input.resolveAsset === 'function' ? input.resolveAsset(record.asset_id) : null;
      if (resolved && resolved.path) {
        absolute = resolved.path;
        kind = resolved.kind || kindFromPath(resolved.path);
        assetId = record.asset_id;
        libraryFile = path.basename(resolved.path);
        source = record.origin === 'generated' ? 'generated' : 'own_media';
      }
    } else if (record && (status === 'rendered' || status === 'produced') && record.path) {
      absolute = path.resolve(projectDirectory, record.path);
      kind = record.media_kind || kindFromPath(absolute);
      source = status;
    }

    if (absolute && !fs.existsSync(absolute)) {
      blocking.push('Scene ' + scene.id + ' points at ' + (record && record.path ? record.path : 'a library file') + ', which is missing.');
      absolute = null;
      libraryFile = null;
      assetId = null;
      source = 'missing';
    }
    if (!absolute) blocking.push('Scene ' + scene.id + ' has no media to show.');

    const narrationRecord = scene.narration_section_id ? narration.get(String(scene.narration_section_id)) : null;
    let narrationPath = null;
    if (narrationRecord && narrationRecord.status === 'done' && narrationRecord.path) {
      narrationPath = path.resolve(projectDirectory, narrationRecord.path);
      if (!fs.existsSync(narrationPath)) {
        warnings.push('The narration audio for scene ' + scene.id + ' is missing, so that scene will be silent.');
        narrationPath = null;
      }
    }
    const measured = narrationRecord ? Number(narrationRecord.duration_seconds) || null : null;
    const planned = Number(scene.seconds) > 0 ? Number(scene.seconds) : null;
    let duration = planned || measured || opts.fallbackSeconds;
    if (!planned) warnings.push('Scene ' + scene.id + ' has no planned duration, so ' + duration.toFixed(1) + 's was used.');
    /* This scene's share of its section's budget. The budget is the section's planned time, or the
       recorded narration when that is longer, so a whole section always fits inside its scenes. */
    const sectionKey = scene.narration_section_id ? String(scene.narration_section_id) : null;
    const budget = sectionKey ? sectionBudget.get(sectionKey) : null;
    if (budget && planned && budget.planned > 0 && budget.total > budget.planned) {
      duration = Number((budget.total * (planned / budget.planned)).toFixed(3));
    }

    videoClips.push({
      scene_id: scene.id, index, title: scene.title || scene.id,
      start_seconds: Number(cursor.toFixed(3)), end_seconds: Number((cursor + duration).toFixed(3)),
      duration_seconds: Number(duration.toFixed(3)),
      source,
      asset_id: assetId,
      library_file: libraryFile,
      path: !assetId && absolute ? path.relative(projectDirectory, absolute).split(path.sep).join('/') : null,
      absolute_path: absolute,
      kind,
      motion: kind === 'image' && opts.stillMotion !== false ? 'zoom' : 'none'
    });
    audioClips.push({
      scene_id: scene.id, section_id: scene.narration_section_id || null,
      start_seconds: Number(cursor.toFixed(3)), end_seconds: Number((cursor + duration).toFixed(3)),
      duration_seconds: Number(duration.toFixed(3)),
      measured_seconds: measured,
      path: narrationPath ? path.relative(projectDirectory, narrationPath).split(path.sep).join('/') : null,
      absolute_path: narrationPath,
      silent: !narrationPath
    });
    cursor += duration;
  });

  const covered = new Set(scenes.map(scene => scene.narration_section_id).filter(Boolean).map(String));
  for (const section of ((input.script && input.script.sections) || [])) {
    if (!covered.has(String(section.id))) {
      blocking.push('Script section ' + section.id + ' is covered by no scene, so its narration would be missing from the video.');
    }
  }
  if (!scenes.length) blocking.push('The storyboard has no scenes, so there is nothing to compose.');

  /* One narration file covers one script section, and a section often spans several scenes: in a real
     project fourteen scenes shared eight sections. Each section's audio is therefore split across its
     scenes in proportion to their durations. Without this the whole section would be repeated for
     every scene that carries it. */
  const bySection = new Map();
  for (const clip of audioClips) {
    if (!clip.section_id) continue;
    const key = String(clip.section_id);
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(clip);
  }
  for (const [sectionId, clips] of bySection) {
    /* `own` is the section's re-timed budget, so it is at least the measured narration and each
       scene's slice therefore fits inside its own window. Nothing is cut and nothing overlaps. */
    const measured = clips[0].measured_seconds;
    const own = clips.reduce((sum, clip) => sum + clip.duration_seconds, 0);
    if (!measured || !clips[0].absolute_path) {
      for (const clip of clips) { clip.audio_offset_seconds = 0; clip.audio_span_seconds = null; }
      continue;
    }
    let consumed = 0;
    for (const clip of clips) {
      const share = own > 0 ? clip.duration_seconds / own : 1 / clips.length;
      clip.audio_offset_seconds = Number((measured * (consumed / (own || 1))).toFixed(3));
      clip.audio_span_seconds = Number((measured * share).toFixed(3));
      consumed += clip.duration_seconds;
    }
    if (measured > own + 0.5) {
      // Only reachable if the budget could not be applied, e.g. a scene with no planned duration.
      warnings.push('The narration for section ' + sectionId + ' runs ' + measured.toFixed(1) + 's but its scenes total ' + own.toFixed(1) + 's, so the last ' + (measured - own).toFixed(1) + 's is cut.');
    }
    const sectionPlan = sectionBudget.get(sectionId);
    if (sectionPlan && sectionPlan.total > sectionPlan.planned + 0.5) {
      warnings.push('The narration for section ' + sectionId + ' runs ' + measured.toFixed(1) + 's but its scenes planned ' + sectionPlan.planned.toFixed(1) + 's, so those scenes were lengthened to hold it. The video is ' + (sectionPlan.total - sectionPlan.planned).toFixed(1) + 's longer than the storyboard asked for.');
    }
  }

  const timeline = {
    id: 'youtube_master',
    aspect_ratio: '16:9',
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    duration_seconds: Number(cursor.toFixed(3)),
    tracks: [
      {id: 'visuals', type: 'video', clips: videoClips.map(clip => {
        const copy = Object.assign({}, clip);
        delete copy.absolute_path;
        return copy;
      })},
      {id: 'narration', type: 'audio', clips: audioClips.map(clip => {
        const copy = Object.assign({}, clip);
        delete copy.absolute_path;
        return copy;
      })},
      {id: 'captions', type: 'subtitle', path: 'compose/captions.srt', cues: 0, timing: 'estimated', timing_note: captions.captionsFor({timeline: {tracks: []}, script: null}).timing_note}
    ]
  };
  return {timeline, plan: {videoClips, audioClips, width: opts.width, height: opts.height, fps: opts.fps, crf: opts.crf, preset: opts.preset, loudnessTarget: opts.loudnessTarget}, warnings, blocking};
}

function videoFilter({width, height, fps, kind, motion, seconds}) {
  const parts = [];
  if (kind === 'image') {
    // Two frames of headroom for the zoom, then zoompan crops back to the frame size.
    parts.push('scale=' + width * 2 + ':' + height * 2 + ':force_original_aspect_ratio=increase');
    parts.push('crop=' + width * 2 + ':' + height * 2);
    if (motion === 'zoom') {
      const frames = Math.max(1, Math.round(fps * seconds));
      parts.push("zoompan=z='min(1.10,1+0.10*on/" + frames + ")':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=" + width + 'x' + height + ':fps=' + fps);
    } else {
      parts.push('scale=' + width + ':' + height);
    }
  } else {
    parts.push('scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease');
    parts.push('pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2:color=black');
  }
  parts.push('setsar=1');
  parts.push('fps=' + fps);
  parts.push('format=yuv420p');
  return parts.join(',');
}

/* Renders one scene to a normalised silent segment, then a matching audio segment. */
async function renderSegments({plan, projectDirectory, tools, run, onProgress, renderPlaceholder, log, segmentsDir}) {
  const ffmpeg = findTool(tools, 'ffmpeg');
  const {width, height, fps, crf, preset} = plan;
  const videoSegments = [];
  const audioSegments = [];
  const total = plan.videoClips.length;

  for (let index = 0; index < plan.videoClips.length; index++) {
    const clip = plan.videoClips[index];
    if (onProgress) onProgress({step: 'scene', scene_id: clip.scene_id, index: index + 1, total});
    const videoFile = path.join(segmentsDir, 'v-' + pad(index + 1) + '.mp4');
    const encode = ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-an', videoFile];

    if (!clip.absolute_path && typeof renderPlaceholder === 'function') {
      // A visible card naming the gap is more useful than a black hole, and QC blocks it either way.
      // The placeholder renderer is asynchronous, so it has to be awaited before the segment is used.
      await renderPlaceholder({outputPath: videoFile, seconds: clip.duration_seconds, template: 'text-card', scene: {
        template: 'text-card', seconds: clip.duration_seconds,
        text: 'Missing media: ' + (clip.title || clip.scene_id),
        subtext: 'This scene has no footage yet.', footnote: clip.scene_id
      }});
      if (!fs.existsSync(videoFile)) fail('The placeholder for scene ' + clip.scene_id + ' was not written.');
    } else if (!clip.absolute_path) {
      execute({command: ffmpeg, args: ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=' + width + 'x' + height + ':r=' + fps, '-t', String(clip.duration_seconds)].concat(encode), run, log, label: 'placeholder for ' + clip.scene_id});
    } else if (clip.kind === 'image') {
      execute({
        command: ffmpeg,
        args: ['-y', '-v', 'error', '-loop', '1', '-framerate', String(fps), '-t', String(clip.duration_seconds), '-i', clip.absolute_path,
          '-vf', videoFilter({width, height, fps, kind: 'image', motion: clip.motion, seconds: clip.duration_seconds})].concat(encode),
        run, log, label: 'still for ' + clip.scene_id
      });
    } else {
      execute({
        command: ffmpeg,
        args: ['-y', '-v', 'error', '-stream_loop', '-1', '-i', clip.absolute_path, '-t', String(clip.duration_seconds),
          '-vf', videoFilter({width, height, fps, kind: 'video', motion: 'none', seconds: clip.duration_seconds})].concat(encode),
        run, log, label: 'clip for ' + clip.scene_id
      });
    }
    videoSegments.push(videoFile);

    // The audio comes from the matching narration clip, not from the video: a video segment has no
    // audio of its own, and feeding its path to -af produces nothing at all.
    const audioClip = plan.audioClips[index] || {};
    const audioFile = path.join(segmentsDir, 'a-' + pad(index + 1) + '.wav');
    const audioArgs = ['-y', '-v', 'error'];
    // A section shared by several scenes contributes only its own slice to each of them.
    const offset = Number(audioClip.audio_offset_seconds) || 0;
    const span = Number(audioClip.audio_span_seconds) > 0 ? Number(audioClip.audio_span_seconds) : clip.duration_seconds;
    if (audioClip.absolute_path && offset > 0) audioArgs.push('-ss', String(offset));
    if (audioClip.absolute_path) audioArgs.push('-i', audioClip.absolute_path);
    else audioArgs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    audioArgs.push('-af', 'atrim=0:' + span + ',apad,aresample=48000', '-ac', '2', '-c:a', 'pcm_s16le', '-t', String(clip.duration_seconds), audioFile);
    execute({command: ffmpeg, args: audioArgs, run, log, label: 'narration for ' + clip.scene_id});
    audioSegments.push(audioFile);
  }
  return {videoSegments, audioSegments};
}

function writeConcatList(file, items) {
  fs.writeFileSync(file, items.map(item => "file '" + quoteForConcat(item) + "'").join('\n') + '\n', 'utf8');
}

/* Concatenates the segments and lays the narration underneath, normalising loudness on the way in. */
function assemble({plan, projectDirectory, tools, run, log, segmentsDir, videoSegments, audioSegments}) {
  const ffmpeg = findTool(tools, 'ffmpeg');
  const composeDir = path.join(projectDirectory, 'compose');
  fs.mkdirSync(composeDir, {recursive: true});
  const videoList = path.join(segmentsDir, 'video.txt');
  const audioList = path.join(segmentsDir, 'audio.txt');
  const visuals = path.join(composeDir, 'visuals.mp4');
  const narration = path.join(composeDir, 'narration.wav');
  writeConcatList(videoList, videoSegments);
  writeConcatList(audioList, audioSegments);
  execute({command: ffmpeg, args: ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', videoList, '-c', 'copy', visuals], run, log, label: 'join the visual segments'});
  execute({command: ffmpeg, args: ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', audioList, '-c', 'copy', narration], run, log, label: 'join the narration segments'});

  const master = path.join(projectDirectory, 'final/youtube_master.mp4');
  fs.mkdirSync(path.dirname(master), {recursive: true});
  execute({
    command: ffmpeg,
    args: ['-y', '-v', 'error', '-i', visuals, '-i', narration,
      '-af', 'loudnorm=I=' + plan.loudnessTarget + ':TP=-1.5:LRA=11',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-t', String(plan.durationSeconds), '-movflags', '+faststart', master],
    run, log, label: 'assemble the master'
  });
  return {master, visuals, narration};
}

/* Composes the project. Returns the timeline, the captions, the QC input and where the master is. */
async function compose(input) {
  const projectDirectory = path.resolve(input.projectDirectory);
  const tools = input.tools || detectMediaTools();
  const log = [];
  const planned = planTimeline({
    storyboard: input.storyboard, script: input.script, manifest: input.manifest,
    projectDirectory, resolveAsset: input.resolveAsset, options: input.options
  });
  const plan = Object.assign({}, planned.plan, {durationSeconds: planned.timeline.duration_seconds});
  const captionResult = captions.captionsFor({timeline: planned.timeline, script: input.script});
  planned.timeline.tracks.find(track => track.id === 'captions').cues = captionResult.cues.length;

  const segmentsDir = path.join(projectDirectory, 'compose/segments');
  fs.rmSync(segmentsDir, {recursive: true, force: true});
  fs.mkdirSync(segmentsDir, {recursive: true});
  const composeDir = path.join(projectDirectory, 'compose');
  fs.mkdirSync(composeDir, {recursive: true});
  fs.writeFileSync(path.join(composeDir, 'captions.srt'), captions.toSrt(captionResult.cues), 'utf8');

  let assembled = null;
  try {
    const segments = await renderSegments({plan, projectDirectory, tools, run: input.execFileSync, onProgress: input.onProgress, renderPlaceholder: input.renderPlaceholder, log, segmentsDir});
    assembled = assemble({plan, projectDirectory, tools, run: input.execFileSync, log, segmentsDir, videoSegments: segments.videoSegments, audioSegments: segments.audioSegments});
  } catch (error) {
    // Segments are kept on failure, because the file that broke is the only useful evidence.
    error.segmentsDir = segmentsDir;
    throw error;
  }
  const keepSegments = input.options && input.options.keepSegments;
  if (!keepSegments) fs.rmSync(segmentsDir, {recursive: true, force: true});

  const probe = typeof input.probe === 'function' ? input.probe : (file) => probeMedia(file, {tools, execFileSync: input.execFileSync});
  return {
    timeline: planned.timeline,
    plan,
    captions: captionResult,
    master: assembled.master,
    visuals: assembled.visuals,
    narration: assembled.narration,
    probe,
    tools,
    log,
    warnings: planned.warnings,
    blocking: planned.blocking
  };
}

module.exports = {compose, planTimeline, renderSegments, assemble, videoFilter, kindFromPath, DEFAULTS, execute};
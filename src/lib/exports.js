'use strict';
/* Platform exports: the master, reframed for the places it is going, with its own captions and
   metadata.

   Reframing a 16:9 master to 9:16 by cropping throws away the sides of every frame, which for a
   technical video means throwing away the words. So the full frame is scaled to fit the width and
   centred over a blurred enlargement of itself: nothing is lost, and the bars are not dead space.

   Captions are burned in for short-form because that is how those platforms are watched, with a
   sidecar file as well. Burning happens with FFmpeg running from the caption's own directory, because
   a Windows drive letter inside a filter argument is read as an option separator. */

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {detectMediaTools} = require('../config/capabilities');
const captions = require('./captions');

const PLATFORMS = [
  {id: 'youtube_shorts', label: 'YouTube Shorts', aspect: '9:16', width: 1080, height: 1920, maxSeconds: 60, titleMax: 100, captionMax: 1000, burnCaptions: true, fontSize: 13},
  {id: 'tiktok', label: 'TikTok', aspect: '9:16', width: 1080, height: 1920, maxSeconds: 180, titleMax: 100, captionMax: 2200, burnCaptions: true, fontSize: 13},
  {id: 'instagram', label: 'Instagram Reels', aspect: '9:16', width: 1080, height: 1920, maxSeconds: 90, titleMax: 100, captionMax: 2200, burnCaptions: true, fontSize: 13},
  {id: 'facebook', label: 'Facebook Reels', aspect: '9:16', width: 1080, height: 1920, maxSeconds: 90, titleMax: 100, captionMax: 2200, burnCaptions: true, fontSize: 13},
  {id: 'square_feed', label: 'Square feed post', aspect: '1:1', width: 1080, height: 1080, maxSeconds: 90, titleMax: 100, captionMax: 2200, burnCaptions: false, fontSize: 15}
];

/* The long-form master is not an export, but its metadata package is built the same way. */
const MASTER = {id: 'youtube_master', label: 'YouTube (16:9)', aspect: '16:9', width: 1920, height: 1080, maxSeconds: null, titleMax: 100, captionMax: 5000, burnCaptions: false, fontSize: 15};

function fail(message, status = 500) { throw Object.assign(new Error(message), {status}); }

function findTool(tools, name) {
  const found = (tools || detectMediaTools()).find(tool => tool.name === name);
  if (!found || !found.available) fail(name + ' is not available, so exports cannot be produced. Install FFmpeg and try again.');
  return found.path;
}

function platforms() { return PLATFORMS.map(platform => Object.assign({}, platform)); }
function platformById(id) { return PLATFORMS.find(platform => platform.id === id) || null; }

function execute({command, args, run, log, label, cwd, timeoutMs = 30 * 60 * 1000}) {
  if (log) log.push({step: label, command: [command].concat(args).join(' '), cwd: cwd || null});
  try {
    (run || execFileSync)(command, args, {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd});
  } catch (error) {
    const raw = error && error.stderr ? String(error.stderr) : '';
    const detail = raw.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
    fail(label + ' failed' + (detail ? ': ' + detail : (error && error.message ? ': ' + error.message : '.')));
  }
}

/* Which part of the master becomes a short. The script marks sections as short_form, and those
   sections' scenes give the windows; taking the first N seconds of an eight-minute video would be an
   arbitrary cut, and a fallback that says so is better than one that pretends. */
function planShort({timeline, storyboard, script, maxSeconds}) {
  const track = ((timeline && timeline.tracks) || []).find(item => item.id === 'visuals');
  const clips = track ? track.clips : [];
  const candidates = (((script && script.sections) || [])).filter(section => section && section.short_form).map(section => String(section.id));
  const scenes = new Map((((storyboard && storyboard.scenes) || [])).map(scene => [scene.id, scene]));
  const wanted = new Set(candidates);
  const chosen = [];
  for (const clip of clips) {
    const scene = scenes.get(clip.scene_id);
    if (!scene || !scene.narration_section_id) continue;
    if (wanted.has(String(scene.narration_section_id))) chosen.push(clip);
  }
  const fallback = chosen.length === 0;
  const pool = fallback ? clips.slice() : chosen;
  const windows = [];
  let total = 0;
  for (const clip of pool) {
    if (total >= maxSeconds) break;
    const start = Number(clip.start_seconds) || 0;
    const end = Number(clip.end_seconds) || start;
    const take = Math.min(end - start, maxSeconds - total);
    if (take <= 0.05) continue;
    windows.push({start, end: start + take, scene_id: clip.scene_id});
    total += take;
  }
  return {
    windows,
    seconds: Number(total.toFixed(3)),
    source: fallback ? 'first scenes' : 'sections marked short_form',
    fallback,
    note: fallback
      ? 'No script section was marked short_form, so the opening scenes were used. Mark sections as short-form in the script to choose this deliberately.'
      : 'Built from the script sections marked short_form: ' + candidates.join(', ') + '.'
  };
}

/* Cues for the trimmed timeline: a cue inside a kept window shifts by however much has been cut
   before it, and a cue that spans a cut is trimmed to the window it started in. */
function retimeCues(cues, windows) {
  const retimed = [];
  let offset = 0;
  for (const window of windows) {
    for (const cue of (cues || [])) {
      if (cue.end <= window.start + 0.001 || cue.start >= window.end - 0.001) continue;
      const start = Math.max(cue.start, window.start) - window.start + offset;
      const end = Math.min(cue.end, window.end) - window.start + offset;
      if (end - start < 0.2) continue;
      retimed.push({start, end, text: cue.text});
    }
    offset += window.end - window.start;
  }
  return retimed;
}

function cutAndJoin({master, windows, outputPath, tools, run, log, workDir}) {
  const ffmpeg = findTool(tools, 'ffmpeg');
  fs.mkdirSync(workDir, {recursive: true});
  const pieces = [];
  windows.forEach((window, index) => {
    const piece = path.join(workDir, 'part-' + String(index + 1).padStart(3, '0') + '.mp4');
    execute({
      command: ffmpeg,
      args: ['-y', '-v', 'error', '-ss', String(window.start), '-i', master, '-t', String(Number((window.end - window.start).toFixed(3))),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', piece],
      run, log, label: 'cut ' + (window.scene_id || index + 1)
    });
    pieces.push(piece);
  });
  if (!pieces.length) fail('There is nothing to export: no scenes were selected for the short.');
  if (pieces.length === 1) {
    fs.copyFileSync(pieces[0], outputPath);
    return outputPath;
  }
  const list = path.join(workDir, 'short.txt');
  fs.writeFileSync(list, pieces.map(piece => "file '" + piece.split(path.sep).join('/').replace(/'/g, "'\\''") + "'").join('\n') + '\n', 'utf8');
  execute({command: ffmpeg, args: ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outputPath], run, log, label: 'join the short'});
  return outputPath;
}

/* Scales the whole frame into the target shape over a blurred copy of itself. */
function reframe({input, outputPath, width, height, hasAudio, tools, run, log, captionsFile, fontSize, crf = 20}) {
  const ffmpeg = findTool(tools, 'ffmpeg');
  const chain = [
    '[0:v]split=2[bg][fg]',
    '[bg]scale=' + width + ':' + height + ':force_original_aspect_ratio=increase,crop=' + width + ':' + height + ',gblur=sigma=30[bgblur]',
    '[fg]scale=' + width + ':-2[fgfit]',
    '[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2[laid]'
  ];
  const style = "FontSize=" + (fontSize || 13) + ",PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=60,Alignment=2";
  const tail = captionsFile
    // The command runs from the caption's directory, so no drive colon reaches the filter parser.
    ? '[laid]subtitles=' + path.basename(captionsFile) + ":force_style='" + style + "',fps=24,format=yuv420p[v]"
    : '[laid]fps=24,format=yuv420p[v]';
  chain.push(tail);
  const args = ['-y', '-v', 'error', '-i', input, '-filter_complex', chain.join(';'), '-map', '[v]'];
  if (hasAudio) args.push('-map', '0:a', '-c:a', 'aac', '-b:a', '192k');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-movflags', '+faststart', outputPath);
  execute({command: ffmpeg, args, run, log, label: 'reframe to ' + width + 'x' + height, cwd: captionsFile ? path.dirname(captionsFile) : undefined});
  if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).size) fail('The ' + width + 'x' + height + ' export was not written.');
  return outputPath;
}

/* Trims to a limit. `keepLines` preserves paragraph breaks, which platform captions need: collapsing
   a description onto one line loses the structure the script put there. */
function clip(text, limit, keepLines) {
  const raw = String(text === undefined || text === null ? '' : text);
  const value = keepLines
    ? raw.split(/\r?\n/).map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : raw.replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 1)).replace(/\s+\S*$/, '') + '…';
}

/* Metadata assembled from the project's own artifacts. It is a starting point to edit, not something
   a model wrote, and every file says so. Credits the rights gate collected are included, because a
   licence that requires attribution requires it in the published description, not in a JSON file
   nobody reads. */
function metadataFor({brief, script, storyboard, timeline, platform, master, captionsFile, thumbnail, attributions}) {
  const topic = (brief && brief.topic) || 'Untitled video';
  const audience = (brief && brief.audience) || 'viewers';
  const sections = ((script && script.sections) || []);
  const lines = [];
  lines.push(clip(topic, 200) + ' — a short explanation for ' + clip(audience, 80) + '.');
  if (sections.length) {
    lines.push('');
    lines.push('In this video:');
    for (const section of sections.slice(0, 8)) lines.push('- ' + clip(section.title || section.id, 90));
  }
  const credits = (attributions || []).filter(Boolean);
  /* Credits are budgeted for before the body is trimmed. Truncating the tail would silently delete the
     one part of the description a licence obliges you to publish. */
  const creditBlock = credits.length ? '\n\nCredits:\n' + credits.map(credit => '- ' + clip(credit, 300, true)).join('\n') : '';
  const body = clip(lines.join('\n'), Math.max(0, platform.captionMax - creditBlock.length), true);
  let description = body + creditBlock;
  let creditsTruncated = false;
  if (description.length > platform.captionMax) {
    // Only reachable when the required credits alone exceed the platform's limit.
    description = clip(description, platform.captionMax, true);
    creditsTruncated = credits.some(credit => description.indexOf(credit) === -1);
  }
  const chapters = (((timeline && timeline.tracks) || []).find(track => track.id === 'visuals') || {clips: []}).clips.map(clipItem => {
    const scene = (((storyboard && storyboard.scenes) || [])).find(item => item.id === clipItem.scene_id);
    return {title: (scene && scene.title) || clipItem.scene_id, start_seconds: clipItem.start_seconds};
  });
  const tags = [...new Set(String(topic).toLowerCase().split(/[^a-z0-9+]+/).filter(word => word.length > 2))].slice(0, 12);
  return {
    platform: platform.id,
    label: platform.label,
    aspect_ratio: platform.aspect,
    title: clip(topic, platform.titleMax),
    description,
    tags,
    chapters,
    credits,
    credits_truncated: creditsTruncated,
    captions: captionsFile ? path.basename(captionsFile) : null,
    thumbnail: thumbnail ? path.basename(thumbnail) : null,
    master: master ? path.basename(master) : null,
    note: 'Assembled from this project\'s own brief, script and timeline. Edit before publishing; no model wrote this copy.'
  };
}

/* Produces every platform export, its captions and its metadata, then a manifest listing all of it. */
function exportAll(input) {
  const tools = input.tools || detectMediaTools();
  const projectDirectory = path.resolve(input.projectDirectory);
  const master = path.resolve(projectDirectory, input.masterRelative || 'final/youtube_master.mp4');
  if (!fs.existsSync(master)) fail('There is no master to export. Compose the video first.', 409);
  const log = input.log || [];
  const workDir = path.join(projectDirectory, 'adaptations/.work');
  fs.mkdirSync(workDir, {recursive: true});
  const masterCues = input.cues || [];
  const files = [];
  const results = [];

  for (const platform of PLATFORMS) {
    const directory = path.join(projectDirectory, 'adaptations', platform.id);
    fs.mkdirSync(directory, {recursive: true});
    const plan = planShort({timeline: input.timeline, storyboard: input.storyboard, script: input.script, maxSeconds: platform.maxSeconds});
    if (!plan.windows.length) {
      results.push({platform: platform.id, label: platform.label, status: 'skipped', reason: 'No scenes were available within the ' + platform.maxSeconds + 's limit.'});
      continue;
    }
    const retimed = retimeCues(masterCues, plan.windows);
    const captionsFile = path.join(directory, platform.id + '.srt');
    fs.writeFileSync(captionsFile, captions.toSrt(retimed), 'utf8');

    const short = path.join(workDir, platform.id + '-short.mp4');
    cutAndJoin({master, windows: plan.windows, outputPath: short, tools, run: input.execFileSync, log, workDir});

    const outputPath = path.join(directory, platform.id + '.mp4');
    reframe({
      input: short, outputPath, width: platform.width, height: platform.height,
      hasAudio: input.hasAudio !== false,
      tools, run: input.execFileSync, log,
      captionsFile: platform.burnCaptions ? captionsFile : null,
      fontSize: platform.fontSize
    });

    const metadata = metadataFor({
      brief: input.brief, script: input.script, storyboard: input.storyboard,
      timeline: input.timeline, platform, master,
      captionsFile, thumbnail: input.thumbnail,
      attributions: input.attributions
    });
    const metadataFile = path.join(directory, 'metadata.json');
    fs.writeFileSync(metadataFile, JSON.stringify(Object.assign({}, metadata, {
      duration_seconds: plan.seconds,
      video: {file: path.basename(outputPath), width: platform.width, height: platform.height, aspect_ratio: platform.aspect},
      short_plan: {source: plan.source, note: plan.note, windows: plan.windows}
    }), null, 2) + '\n', 'utf8');

    const size = fs.statSync(outputPath).size;
    results.push({
      platform: platform.id, label: platform.label, status: 'exported',
      aspect_ratio: platform.aspect, width: platform.width, height: platform.height,
      duration_seconds: plan.seconds, max_seconds: platform.maxSeconds,
      video: path.relative(projectDirectory, outputPath).split(path.sep).join('/'),
      captions: path.relative(projectDirectory, captionsFile).split(path.sep).join('/'),
      metadata: path.relative(projectDirectory, metadataFile).split(path.sep).join('/'),
      // The copy rides in the manifest too, so the interface needs one file to show it.
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      captions_burned: !!platform.burnCaptions,
      cues: retimed.length,
      bytes: size,
      credits: metadata.credits,
      short_source: plan.source,
      short_note: plan.note
    });
    files.push(outputPath, captionsFile, metadataFile);
  }

  fs.rmSync(workDir, {recursive: true, force: true});
  const credits = [...new Set((input.attributions || []).filter(Boolean))];
  const manifest = {
    generated_at: new Date().toISOString(),
    master: path.relative(projectDirectory, master).split(path.sep).join('/'),
    master_seconds: (input.timeline && input.timeline.duration_seconds) || null,
    credits,
    credit_note: credits.length
      ? 'These attributions are required by the licences of material used in this video. They are already in every platform description; keep them there.'
      : 'Every asset in this video is owned, commissioned or generated, so no attribution is required.',
    platforms: results,
    note: 'Every file here is ready to upload. Captions are burned in where the platform expects it, and a sidecar file is always written.'
  };
  const manifestPath = path.join(projectDirectory, 'adaptations/export_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return {manifest, manifestPath, results, log, files};
}

module.exports = {exportAll, planShort, retimeCues, reframe, metadataFor, platforms, platformById, PLATFORMS, MASTER, clip};
'use strict';
/* Renders one scene template to a silent MP4.

   Each template is a self-contained page whose animation is driven by a frame index, not by
   wall-clock time. Frames are stepped one at a time and screenshotted, then FFmpeg assembles them.
   That is slower than recording the page in real time, and it is the point: the output cannot
   depend on how fast this machine happens to render, so the same scene always produces the same
   video. Narration is deliberately absent here; the composer mixes audio in one place. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const browser = require('./browser');
const {detectMediaTools} = require('../config/capabilities');

const RENDER_DIR = path.join(__dirname, '..', 'render');
const TEMPLATE_DIR = path.join(RENDER_DIR, 'templates');
const TEMPLATES = ['text-card', 'bar-chart', 'terminal', 'diagram', 'split-compare', 'end-card'];

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 24;
/* 150 seconds at 24fps. A graphic scene longer than this is a mistake, not a request. */
const MAX_FRAMES = 3600;

function fail(message, status = 500) { throw Object.assign(new Error(message), {status}); }

function templates() { return TEMPLATES.slice(); }

function isTemplate(name) { return TEMPLATES.includes(String(name)); }

function templatePath(template) {
  const name = String(template || '');
  if (!isTemplate(name)) {
    fail('Unknown scene template ' + JSON.stringify(name) + '. Choose one of: ' + TEMPLATES.join(', ') + '.', 400);
  }
  return path.join(TEMPLATE_DIR, name + '.html');
}

function readAsset(file) { return fs.readFileSync(path.join(RENDER_DIR, file), 'utf8'); }

/* Builds the page the browser will load. The payload is injected as JSON with "<" escaped, so a
   scene whose text contains "</script>" cannot break out of the tag. Replacements are passed as
   functions so a "$&" in the CSS or runtime is never treated as a substitution pattern. */
function buildPage(payload) {
  const html = fs.readFileSync(templatePath(payload.template), 'utf8');
  const styles = readAsset('runtime.css');
  const runtime = readAsset('runtime.js');
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return html
    .replace('/*__STYLES__*/', () => styles)
    .replace('/*__SCENE__*/', () => 'window.__SCENE__ = ' + json + ';')
    .replace('/*__RUNTIME__*/', () => runtime);
}

function frameName(index) { return 'frame-' + String(index).padStart(5, '0') + '.jpg'; }

function ffmpegPath(explicit, tools) {
  if (explicit) return explicit;
  const found = (tools || detectMediaTools()).find(tool => tool.name === 'ffmpeg');
  if (!found || !found.available) fail('ffmpeg is not available, so a scene cannot be rendered. Install FFmpeg and try again.');
  return found.path;
}

/* Assembles the captured frames into an MP4. Frames are read from disk rather than piped so a
   failed render can be inspected instead of vanishing. */
function assemble({framesDir, outputPath, fps, ffmpeg, run, quality = 18}) {
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const args = [
    '-y', '-v', 'error',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame-%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outputPath
  ];
  (run || execFileSync)(ffmpeg, args, {stdio: 'ignore'});
  const bytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  if (!bytes) fail('The rendered scene file is empty. FFmpeg produced no output.');
  return bytes;
}

/* Renders one scene. Resolves with what was written; throws with a message that names the real
   problem, including the case where the text simply cannot fit the frame. */
async function renderScene(options) {
  const opts = options || {};
  const template = String(opts.template || 'text-card');
  templatePath(template);

  const fps = Number(opts.fps) > 0 ? Number(opts.fps) : DEFAULT_FPS;
  const seconds = Number(opts.seconds) > 0 ? Number(opts.seconds) : 4;
  const width = Number(opts.width) > 0 ? Number(opts.width) : DEFAULT_WIDTH;
  const height = Number(opts.height) > 0 ? Number(opts.height) : DEFAULT_HEIGHT;
  const scene = Object.assign({}, opts.scene || {}, {template, fps, seconds});
  const page = buildPage(scene);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-render-'));
  const pagePath = path.join(tempRoot, 'scene.html');
  const framesDir = path.join(tempRoot, 'frames');
  fs.mkdirSync(framesDir, {recursive: true});
  fs.writeFileSync(pagePath, page, 'utf8');

  const session = { current: null };
  try {
    const launcher = opts.browserModule || browser;
    const launched = await launcher.launch(Object.assign({width, height}, opts.launchOptions || {}));
    session.current = launched;
    const sessionId = launched.sessionId;
    // The window size and the captured viewport are not always the same thing, so pin the viewport.
    await launched.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false}, sessionId);
    await launched.navigate('file:///' + pagePath.split(path.sep).join('/'));
    await launched.waitFor('window.__ready === true', 'the ' + template + ' template to build', opts.buildTimeoutMs || 20000);

    const pageError = await launched.evaluate('return window.__error || null;');
    if (pageError) fail('The ' + template + ' template failed: ' + pageError);

    const fit = await launched.evaluate('return window.__fitReport || {ok: true, items: []};');
    if (fit && fit.ok === false) {
      fail('This text does not fit the frame even at the smallest size: "' + String((fit.items || [])[0] || '').slice(0, 160)
        + '". Shorten the on-screen text, or use a template that has more room than ' + template + '.', 409);
    }

    const frameCount = Number(await launched.evaluate('return window.frameCount;')) || 0;
    if (!frameCount) fail('The ' + template + ' template reported no frames to render.');
    if (frameCount > (opts.maxFrames || MAX_FRAMES)) {
      fail('This scene asks for ' + frameCount + ' frames, above the ' + (opts.maxFrames || MAX_FRAMES)
        + ' frame limit. Shorten the scene or lower the frame rate.', 409);
    }

    for (let index = 0; index < frameCount; index++) {
      await launched.evaluate('window.renderFrame(' + index + '); return true;');
      // Two animation frames guarantee the change has been painted before the screenshot is taken.
      await launched.evaluate('return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true); }); }); });');
      await launched.screenshot(path.join(framesDir, frameName(index)), {format: 'jpeg', quality: opts.jpegQuality === undefined ? 92 : opts.jpegQuality});
      if (typeof opts.onProgress === 'function' && (index % 10 === 0 || index === frameCount - 1)) {
        opts.onProgress({frame: index + 1, frames: frameCount});
      }
    }

    const outputPath = opts.outputPath;
    if (!outputPath) fail('A scene render needs an output path.');
    const bytes = assemble({
      framesDir,
      outputPath,
      fps,
      quality: opts.crf === undefined ? 18 : opts.crf,
      ffmpeg: ffmpegPath(opts.ffmpegPath, opts.tools),
      run: opts.execFileSync
    });

    return {
      path: outputPath,
      template,
      width,
      height,
      fps,
      frameCount,
      durationSeconds: Number((frameCount / fps).toFixed(3)),
      bytes,
      fit: {ok: true, fontSize: fit ? fit.fontSize : null}
    };
  } finally {
    if (session.current) { try { await session.current.close(); } catch (error) { /* already gone */ } }
    if (!opts.keepFrames) { try { fs.rmSync(tempRoot, {recursive: true, force: true}); } catch (error) { /* leave it to the OS */ } }
  }
}

module.exports = {renderScene, buildPage, templates, isTemplate, TEMPLATES, DEFAULT_FPS, DEFAULT_WIDTH, DEFAULT_HEIGHT, MAX_FRAMES};
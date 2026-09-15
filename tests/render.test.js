'use strict';
/* Scene rendering: the template page, the frame stepper, and the video it assembles.
   Every assertion is against a real file produced by a real browser and verified with ffprobe. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {renderScene, buildPage, isTemplate, templates, TEMPLATES} = require('../src/lib/frameRenderer');
const browserModule = require('../src/lib/browser');
const {detectMediaTools} = require('../src/config/capabilities');

const browser = browserModule.findBrowser();
if (!browser && process.env.ALLOW_SKIP_BROWSER_TESTS === '1') {
  console.log('All scene render tests skipped: no Chrome or Edge found, and ALLOW_SKIP_BROWSER_TESTS=1.');
  process.exit(0);
}
assert.ok(browser, 'No Chrome or Edge found, so scene rendering cannot be verified. Install one, set CHROME_PATH, or set ALLOW_SKIP_BROWSER_TESTS=1 to skip deliberately.');

const FFMPEG = detectMediaTools().find(tool => tool.name === 'ffmpeg');
const FFPROBE = detectMediaTools().find(tool => tool.name === 'ffprobe');
assert.ok(FFMPEG && FFMPEG.available, 'ffmpeg is required to render a scene');
assert.ok(FFPROBE && FFPROBE.available, 'ffprobe is required to verify a rendered scene');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'render-test-'));

function probe(file) {
  const raw = execFileSync(FFPROBE.path, [
    '-v', 'error', '-show_entries', 'format=duration,size',
    '-show_entries', 'stream=codec_name,width,height,nb_frames',
    '-of', 'json', file
  ], {encoding: 'utf8'});
  const parsed = JSON.parse(raw);
  const stream = (parsed.streams || [])[0] || {};
  const format = parsed.format || {};
  return {
    duration: Number(format.duration),
    size: Number(format.size),
    codec: stream.codec_name,
    width: Number(stream.width),
    height: Number(stream.height),
    frames: Number(stream.nb_frames)
  };
}

function sceneDirs() {
  return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('scene-render-'));
}

const SAMPLES = {
  'text-card': {text: 'Aspiration, not a shipped kernel', subtext: 'Dora-rs release candidate', options: {reveal: 'words'}},
  'bar-chart': {eyebrow: 'Benchmark', data: {bars: [{label: 'ROS2', value: 100}, {label: 'Dora-rs', value: 380, display: '380 MB/s'}], footnote: '*project benchmark'}},
  terminal: {data: {title: 'powershell', lines: [{prompt: 'PS>', text: 'pip install dora-rs'}, {text: 'Successfully installed'}]}},
  diagram: {eyebrow: 'Pipeline', data: {nodes: [{label: 'camera', x: 20, y: 50}, {label: 'process', x: 50, y: 50}, {label: 'output', x: 80, y: 50}], edges: [[0, 1], [1, 2]]}},
  'split-compare': {text: 'Marketing', data: {left: {label: 'Marketing language', text: 'next-gen robotic OS'}, right: {label: 'Current reality', text: 'experimental bridge'}, badge: 'EXPERIMENTAL'}},
  'end-card': {text: 'Dora-rs', data: {next: 'Next: Full Install Walkthrough'}}
};

async function testTemplateVocabulary() {
  assert.deepEqual(templates().sort(), TEMPLATES.slice().sort());
  for (const name of TEMPLATES) {
    assert.equal(isTemplate(name), true, name + ' must be recognised');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'render', 'templates', name + '.html')), name + ' must have a template file');
  }
  assert.equal(isTemplate('nope'), false);
  assert.equal(isTemplate(''), false);
  assert.equal(isTemplate(null), false);

  const rejected = await renderScene({template: '../runtime', outputPath: path.join(work, 'x.mp4')}).then(() => null, error => error);
  assert.ok(rejected, 'An unknown template must be refused');
  assert.equal(rejected.status, 400);
  assert.match(rejected.message, /Unknown scene template/);
  console.log('  template vocabulary: six templates present, unknown names refused with 400');
}

async function testPageEscaping() {
  const hostile = 'Break </script><b>bold</b> & "quotes" — 🚀';
  const page = buildPage({template: 'text-card', text: hostile, fps: 12, seconds: 1});
  assert.ok(page.indexOf(hostile) < 0, 'The raw text must not appear unescaped in the page');
  assert.ok(page.indexOf('\\u003c/script') >= 0, 'The closing script tag must be escaped inside the payload');
  // All three injection markers must have been substituted.
  for (const marker of ['/*__STYLES__*/', '/*__SCENE__*/', '/*__RUNTIME__*/']) {
    assert.ok(page.indexOf(marker) < 0, marker + ' must be replaced when the page is built');
  }
  assert.ok(page.indexOf('.bar-track') >= 0, 'The shared stylesheet must be inlined');
  assert.ok(page.indexOf('window.__SCENE__ =') >= 0, 'The scene payload must be inlined');
  assert.ok(page.indexOf('window.__ready') >= 0, 'The runtime must be inlined');

  /* And the text must survive as literal text, not as markup, once actually rendered. */
  const page_path = path.join(work, 'escaping.html');
  fs.writeFileSync(page_path, page, 'utf8');
  const session = await browserModule.launch({width: 640, height: 360});
  try {
    await session.navigate('file:///' + page_path.split(path.sep).join('/'));
    await session.waitFor('window.__ready === true', 'the page to build');
    const seen = await session.evaluate("return {headline: document.getElementById('headline').textContent, bold: document.querySelectorAll('#stage b').length};");
    assert.equal(seen.headline, hostile, 'The on-screen text must match the source character for character');
    assert.equal(seen.bold, 0, 'Injected markup must never become an element');
  } finally {
    await session.close();
  }
  console.log('  page escaping: hostile text renders literally and cannot become markup');
}

async function testRealRender() {
  const before = sceneDirs();
  const out = path.join(work, 'master.mp4');
  const result = await renderScene({
    template: 'text-card', outputPath: out,
    width: 640, height: 360, fps: 24, seconds: 2,
    scene: SAMPLES['text-card']
  });
  const info = probe(out);
  assert.equal(info.codec, 'h264');
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.frames, 48, 'A 2 second scene at 24fps is 48 frames');
  assert.equal(info.duration.toFixed(3), '2.000');
  assert.equal(result.frameCount, 48);
  assert.equal(result.durationSeconds, 2);
  assert.ok(result.bytes > 1000, 'The rendered file must contain real video');
  assert.ok(result.fit.fontSize > 0, 'The fit result must report the size actually used');

  // The frame directory must not outlive the render.
  const after = sceneDirs();
  assert.deepEqual(after.filter(name => before.indexOf(name) < 0), [], 'A render must clean up its frame directory');
  console.log('  real render: 48 frames assembled into a 640x360 h264 file, frames cleaned up');
}

async function testDeterminism() {
  const first = await renderScene({template: 'text-card', outputPath: path.join(work, 'd1.mp4'), width: 480, height: 270, fps: 12, seconds: 1, scene: SAMPLES['text-card']});
  const second = await renderScene({template: 'text-card', outputPath: path.join(work, 'd2.mp4'), width: 480, height: 270, fps: 12, seconds: 1, scene: SAMPLES['text-card']});
  assert.equal(first.frameCount, second.frameCount);
  assert.equal(first.durationSeconds, second.durationSeconds);
  assert.equal(first.fit.fontSize, second.fit.fontSize, 'The same input must choose the same text size');
  assert.equal(probe(first.path).duration.toFixed(3), probe(second.path).duration.toFixed(3));
  console.log('  determinism: the same scene twice gives the same duration, frame count and text size');
}

async function testEveryTemplateRenders() {
  for (const name of TEMPLATES) {
    const out = path.join(work, name + '.mp4');
    const result = await renderScene({
      template: name, outputPath: out,
      width: 480, height: 270, fps: 8, seconds: 1,
      scene: SAMPLES[name]
    });
    const info = probe(out);
    assert.equal(result.frameCount, 8, name + ' must render 8 frames for a 1 second scene at 8fps');
    assert.equal(info.frames, 8, name + ' must produce 8 frames in the file');
    assert.equal(info.width, 480, name + ' must honour the requested width');
    assert.equal(info.codec, 'h264', name + ' must encode h264');
    assert.ok(info.size > 500, name + ' must produce a real file');
  }
  console.log('  all ' + TEMPLATES.length + ' templates render a real playable file');
}

async function testRefusals() {
  // Text that cannot fit even at the smallest size must fail rather than clip the words.
  const flood = new Array(300).fill('relentless').join(' ');
  const overflow = await renderScene({
    template: 'text-card', outputPath: path.join(work, 'overflow.mp4'),
    width: 320, height: 180, fps: 8, seconds: 1, scene: {text: flood, options: {reveal: 'words'}}
  }).then(() => null, error => error);
  assert.ok(overflow, 'Text that cannot fit must not be silently clipped');
  assert.equal(overflow.status, 409);
  assert.match(overflow.message, /does not fit/);
  assert.ok(!fs.existsSync(path.join(work, 'overflow.mp4')), 'A refused render must leave no output file');

  // A scene above the frame ceiling must be refused before any frames are captured.
  const tooLong = await renderScene({
    template: 'text-card', outputPath: path.join(work, 'long.mp4'),
    width: 320, height: 180, fps: 24, seconds: 10, maxFrames: 12, scene: {text: 'Short'}
  }).then(() => null, error => error);
  assert.ok(tooLong, 'A scene above the frame ceiling must be refused');
  assert.equal(tooLong.status, 409);
  assert.match(tooLong.message, /frame limit/);
  assert.ok(!fs.existsSync(path.join(work, 'long.mp4')), 'A refused render must leave no output file');

  assert.deepEqual(sceneDirs().filter(name => name.indexOf('render-test') >= 0), [], 'Refused renders must still clean up');
  console.log('  refusals: unrenderable text and oversized scenes fail with 409 and leave nothing behind');
}

/* Regression: an id selector outranks a class, so a plain font-size on #fit silently beat every
   template's own choice and rendered the terminal and the split panel at headline size. Each
   template must decide its own text size through --fit-size. */
async function testFitSizeComesFromTemplate() {
  const expected = {'text-card': [50, 62], terminal: [12, 20], 'split-compare': [16, 24], 'end-card': [38, 46]};
  for (const name of Object.keys(expected)) {
    const result = await renderScene({
      template: name, outputPath: path.join(work, name + '-size.mp4'),
      width: 960, height: 540, fps: 8, seconds: 1, scene: SAMPLES[name]
    });
    const [low, high] = expected[name];
    assert.ok(result.fit.fontSize >= low && result.fit.fontSize <= high,
      name + ' should size its own text around ' + low + '-' + high + 'px at 960 wide, got ' + result.fit.fontSize);
  }
  console.log('  fit size: each template controls its own text size rather than inheriting the default');
}

async function run() {
  try {
    await testTemplateVocabulary();
    await testPageEscaping();
    await testRealRender();
    await testDeterminism();
    await testEveryTemplateRenders();
    await testFitSizeComesFromTemplate();
    await testRefusals();
    console.log('All scene render tests passed: real browser, real ffmpeg, real ffprobe verification, no network.');
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
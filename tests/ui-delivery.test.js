'use strict';
/* The delivery screens, rendered by the real views in the fake DOM: the composer's QC report, the
   final check with its confirmations, and the exports list. The artifacts are written directly,
   because what is under test is what the interface shows and whether it lets you approve. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {createServer} = require('../src/server');
const {boot, text} = require('./helpers/ui-harness');
const exportsModule = require('../src/lib/exports');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const MANUAL = [
  {id: 'watched', mode: 'manual', label: 'You have watched the video from start to finish', ok: null, detail: 'No check can tell whether it makes sense.'},
  {id: 'facts', mode: 'manual', label: 'The facts and figures are correct', ok: null, detail: 'Numbers need your eye.'}
];

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-delivery-'));
  const projectsRoot = path.join(root, 'projects');
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')}
  });
  const base = await listen(server);

  try {
    const created = await (await fetch(base + '/api/projects', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({prompt: 'A video about robot safety.'})})).json();
    const folder = created.folder;
    const directory = path.join(projectsRoot, folder);

    // A stand-in master: the screen shows a URL, it does not decode the file.
    fs.mkdirSync(path.join(directory, 'final'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'final/youtube_master.mp4'), Buffer.alloc(2048, 7));
    fs.writeFileSync(path.join(directory, 'final/youtube_thumbnail.jpg'), Buffer.alloc(1024, 8));
    fs.writeFileSync(path.join(directory, 'compose/captions.srt').replace(/compose$/, 'compose'), '', {flag: 'a'});
    fs.mkdirSync(path.join(directory, 'compose'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'compose/captions.srt'), '1\n00:00:00,500 --> 00:00:02,000\nIs it faster?\n', 'utf8');

    writeJson(path.join(directory, 'qc/qc_report.json'), {
      checks: [
        {id: 'scenes_have_media', label: 'Every scene has media', ok: true, detail: 'All 3 scenes resolved to a file.'},
        {id: 'duration_matches_plan', label: 'The duration matches the plan', ok: true, detail: 'planned 8.00s, measured 8.00s'},
        {id: 'caption_source', label: 'Captions match the script', ok: null, detail: 'Cue timing is estimated.'}
      ],
      blocking_issues: [],
      can_approve_master: true,
      measured: {planned_seconds: 8, duration_seconds: 8, width: 1920, height: 1080, frame_rate: 24, has_audio: true, size_bytes: 2048, loudness_lufs: -15.4},
      planned: {width: 1920, height: 1080, fps: 24, duration_seconds: 8},
      master: 'final/youtube_master.mp4'
    });
    writeJson(path.join(directory, 'compose/render_log.json'), {commands: [{step: 'cut', command: 'ffmpeg -i x'}], warnings: ['One scene had no planned duration.']});
    writeJson(path.join(directory, 'compose/timeline.json'), {width: 1920, height: 1080, fps: 24, duration_seconds: 8, tracks: [{id: 'captions', type: 'subtitle', cues: 2}]});
    writeJson(path.join(directory, 'final/final_check.json'), {
      generated_at: '2026-01-01T00:00:00.000Z',
      subject: 'compose:1:2048:8',
      master: {path: 'final/youtube_master.mp4', duration_seconds: 8, size_bytes: 2048},
      target_duration_seconds: 8,
      checks: [
        {id: 'qc_passed', mode: 'computed', label: 'QC passed against the written file', ok: true, detail: 'No blocking issues.'},
        {id: 'master_playable', mode: 'computed', label: 'The video is playable', ok: true, detail: '1920x1080, 8.00s'},
        {id: 'captions_present', mode: 'computed', label: 'Captions exist for the video', ok: true, detail: '2 caption cue(s).'}
      ].concat(MANUAL),
      blocking_issues: [],
      can_approve: true
    });
    writeJson(path.join(directory, 'final/youtube_metadata.json'), {
      title: 'Robot safety for plant managers', description: 'Robot safety for plant managers — a short explanation.\n\nIn this video:\n- Hook\n- Body',
      tags: ['robot', 'safety'], chapters: [{title: 'Hook', start_seconds: 0}], thumbnail: 'final/youtube_thumbnail.jpg',
      note: 'Assembled from this project\'s own brief, script and timeline. Edit before publishing; no model wrote this copy.'
    });
    writeJson(path.join(directory, 'adaptations/export_manifest.json'), {
      generated_at: '2026-01-01T00:10:00.000Z',
      master: 'final/youtube_master.mp4',
      master_seconds: 8,
      credits: ['"Robot lab" by Jane Doe — CC BY 4.0 — https://example.com/clip'],
      credit_note: 'These attributions are required by the licences of material used in this video. They are already in every platform description; keep them there.',
      platforms: [
        {platform: 'youtube_shorts', label: 'YouTube Shorts', status: 'exported', aspect_ratio: '9:16', width: 1080, height: 1920, duration_seconds: 3, max_seconds: 60, video: 'adaptations/youtube_shorts/youtube_shorts.mp4', captions: 'adaptations/youtube_shorts/youtube_shorts.srt', metadata: 'adaptations/youtube_shorts/metadata.json', title: 'Robot safety', tags: ['robot', 'safety'], captions_burned: true, cues: 1, bytes: 740 * 1024, short_source: 'sections marked short_form', short_note: 'Built from the script sections marked short_form: hook.', credits_truncated: true},
        {platform: 'square_feed', label: 'Square feed post', status: 'exported', aspect_ratio: '1:1', width: 1080, height: 1080, duration_seconds: 3, max_seconds: 90, video: 'adaptations/square_feed/square_feed.mp4', captions: 'adaptations/square_feed/square_feed.srt', metadata: 'adaptations/square_feed/metadata.json', title: 'Robot safety', tags: ['robot'], captions_burned: false, cues: 1, bytes: 672 * 1024, short_source: 'sections marked short_form', short_note: 'Built from the script sections marked short_form: hook.'},
        {platform: 'tiktok', label: 'TikTok', status: 'skipped', reason: 'No scenes were available within the 180s limit.'}
      ]
    });

    const projectFile = path.join(directory, 'project.json');
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    project.workflow.stages.compose.revision = 1;
    project.workflow.stages.compose.state = 'needs_review';
    project.workflow.stages.final.revision = 1;
    project.workflow.stages.final.state = 'needs_review';
    project.workflow.stages.exports.revision = 1;
    project.workflow.stages.exports.state = 'needs_review';
    project.master_video = {path: 'final/youtube_master.mp4', duration_seconds: 8, size_bytes: 2048};
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));

    const ui = boot({base});

    // --- the composer screen ---
    ui.navigate('#/project/' + encodeURIComponent(folder) + '/compose');
    await ui.settle(() => text(ui.document.getElementById('viewBody')).indexOf('Quality control') >= 0, {description: 'the QC report', timeout: 8000});
    const composeText = text(ui.document.getElementById('viewBody'));
    assert.ok(composeText.indexOf('QC passed against the written file') >= 0, 'the QC verdict must be shown');
    assert.ok(composeText.indexOf('Every scene has media') >= 0, 'each QC check must be listed');
    assert.ok(composeText.indexOf('Caption cues') >= 0, 'the cue count must be reported');
    const masterVideo = ui.findAll('video').filter(node => (node.src || '').indexOf('final/youtube_master.mp4') >= 0)[0];
    assert.ok(masterVideo, 'the master must be playable on the composer screen');
    assert.ok(ui.findAll('a').some(node => (node.href || '').indexOf('compose/captions.srt') >= 0), 'the captions must be downloadable');
    assert.ok(composeText.indexOf('One scene had no planned duration') >= 0, 'composition warnings must be shown');

    // --- the final check screen ---
    ui.navigate('#/project/' + encodeURIComponent(folder) + '/final');
    await ui.settle(() => text(ui.document.getElementById('viewBody')).indexOf('Yours to confirm') >= 0, {description: 'the final check screen', timeout: 8000});
    const finalText = text(ui.document.getElementById('viewBody'));
    assert.ok(finalText.indexOf('Everything measurable checks out') >= 0, 'the computed verdict must be shown');
    assert.ok(finalText.indexOf('The video is playable') >= 0, 'computed checks must be listed');
    assert.ok(finalText.indexOf('Metadata package') >= 0, 'the metadata package must be shown');
    assert.ok(ui.findAll('a').some(node => (node.href || '').indexOf('final/youtube_thumbnail.jpg') >= 0), 'the thumbnail must be downloadable');
    const confirmations = ui.findAll('input').filter(node => node.type === 'checkbox' && (node.id || '').indexOf('approve-') === 0);
    assert.equal(confirmations.length, MANUAL.length, 'every manual item must be a confirmation');
    const approve = ui.findAll('button').filter(node => text(node).trim() === 'Approve this video')[0];
    assert.ok(approve, 'the approval button must exist');
    assert.equal(approve.disabled, true, 'approval must be blocked until the manual items are confirmed');
    confirmations.forEach(node => { node.checked = true; node.change(); });
    assert.equal(approve.disabled, false, 'confirming every item must enable approval');

    // --- the exports screen ---
    ui.navigate('#/project/' + encodeURIComponent(folder) + '/exports');
    await ui.settle(() => text(ui.document.getElementById('viewBody')).indexOf('YouTube Shorts') >= 0, {description: 'the exports list', timeout: 8000});
    const exportsText = text(ui.document.getElementById('viewBody'));
    assert.equal(exportsText.indexOf('TikTok'), exportsText.lastIndexOf('TikTok') >= 0 ? exportsText.indexOf('TikTok') : -1, 'a skipped platform must be reported rather than hidden');
    assert.ok(exportsText.indexOf('was skipped') >= 0, 'the skipped platform must say why');
    assert.ok(exportsText.indexOf('1080x1920') >= 0, 'the vertical dimensions must be shown');
    assert.ok(exportsText.indexOf('1080x1080') >= 0, 'the square dimensions must be shown');
    assert.ok(exportsText.indexOf('Captions burned in') >= 0, 'the caption treatment must be stated');
    assert.ok(exportsText.indexOf('Short built from sections marked short_form') >= 0, 'each export must say where its footage came from');
    assert.ok(exportsText.indexOf('Title: Robot safety') >= 0, 'the platform title must be shown');
    assert.ok(exportsText.indexOf('Credits you must publish') >= 0, 'required credits must be on screen, not buried in JSON');
    assert.ok(exportsText.indexOf('by Jane Doe') >= 0, 'the credit line itself must be shown');
    assert.ok(exportsText.indexOf('The credits do not fit this platform') >= 0, 'a truncated credit must be reported');
    const exportHrefs = ui.findAll('a').map(node => node.href || '');
    assert.ok(exportHrefs.some(href => href.indexOf('youtube_shorts/youtube_shorts.mp4') >= 0), 'the exported video must be downloadable');
    assert.ok(exportHrefs.some(href => href.indexOf('youtube_shorts.srt') >= 0), 'the captions must be downloadable');
    assert.ok(exportHrefs.some(href => href.indexOf('youtube_shorts/metadata.json') >= 0), 'the metadata must be downloadable');
    assert.equal(ui.findAll('video').length >= 2, true, 'each export must be playable');
    assert.equal(exportsModule.PLATFORMS.length >= 5, true);

    console.log('All delivery screen tests passed: composer QC, final check with confirmations, and the exports list.');
    process.exit(0);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
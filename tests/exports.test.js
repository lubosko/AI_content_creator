'use strict';
/* Phase 7: the final check, the approval gates around the master, and the platform exports.
   The project is assembled from real artifacts written directly, so no language model is involved:
   this is about the gates and the files that come out. FFmpeg really renders, ffprobe really checks. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const {createServer} = require('../src/server');
const {detectMediaTools} = require('../src/config/capabilities');
const exportsModule = require('../src/lib/exports');

const FFMPEG = detectMediaTools().find(tool => tool.name === 'ffmpeg');
const FFPROBE = detectMediaTools().find(tool => tool.name === 'ffprobe');
assert.ok(FFMPEG && FFMPEG.available, 'ffmpeg is required for exports');
assert.ok(FFPROBE && FFPROBE.available, 'ffprobe is required to verify exports');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

async function api(baseUrl, route, body) {
  const options = body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)};
  const response = await fetch(baseUrl + route, options);
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (error) { payload = {raw: text}; }
  return {status: response.status, payload, headers: response.headers};
}

function probe(file) {
  const raw = execFileSync(FFPROBE.path, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {encoding: 'utf8'});
  const parsed = JSON.parse(raw);
  const video = (parsed.streams || []).find(stream => stream.codec_type === 'video') || {};
  return {duration: Number(parsed.format && parsed.format.duration), width: video.width, height: video.height, hasAudio: (parsed.streams || []).some(stream => stream.codec_type === 'audio')};
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exports-test-'));
  const projectsRoot = path.join(root, 'projects');
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')}
  });
  const baseUrl = await listen(server);

  try {
    const created = await api(baseUrl, '/api/projects', {prompt: 'A video about Dora-rs benchmarks for robotics developers.'});
    const folder = created.payload.folder;
    const directory = path.join(projectsRoot, folder);

    /* A project only reaches the composer's later stages through intake, so the brief and the material
       decision are confirmed first; the artifacts below are written afterwards so nothing clobbers them. */
    let intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
    await api(baseUrl, '/api/projects/' + folder + '/brief', Object.assign({}, intake.payload.brief, {angle: 'Practical', purpose: 'Understand the numbers', revision: intake.payload.project.workflow.revision}));
    intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
    await api(baseUrl, '/api/projects/' + folder + '/materials-confirm', {revision: intake.payload.project.workflow.revision, without_material: true});

    /* A real 16:9 master, eight seconds long, with audio and visible content. */
    const masterRelative = 'final/youtube_master.mp4';
    const masterPath = path.join(directory, masterRelative);
    fs.mkdirSync(path.dirname(masterPath), {recursive: true});
    execFileSync(FFMPEG.path, ['-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', masterPath], {stdio: 'ignore'});

    const timeline = {duration_seconds: 8, tracks: [
      {id: 'visuals', type: 'video', clips: [
        {scene_id: 's1', start_seconds: 0, end_seconds: 3, source: 'rendered'},
        {scene_id: 's2', start_seconds: 3, end_seconds: 6, source: 'rendered'},
        {scene_id: 's3', start_seconds: 6, end_seconds: 8, source: 'rendered'}
      ]},
      {id: 'narration', type: 'audio', clips: []},
      {id: 'captions', type: 'subtitle', path: 'compose/captions.srt'}
    ]};
    const storyboard = {scenes: [
      {id: 's1', title: 'The question', narration_section_id: 'hook', seconds: 3},
      {id: 's2', title: 'The evidence', narration_section_id: 'body', seconds: 3},
      {id: 's3', title: 'What to do', narration_section_id: 'body', seconds: 2}
    ]};
    const script = {sections: [
      {id: 'hook', title: 'Hook', narration: 'Is it actually faster?', seconds: 3, short_form: true},
      {id: 'body', title: 'Body', narration: 'The benchmark says yes. Check it yourself.', seconds: 5, short_form: false}
    ]};
    const brief = {topic: 'Dora-rs benchmarks for robotics developers', audience: 'robotics developers', target_duration_seconds: 8, language: 'en'};
    const captionsText = '1\n00:00:00,200 --> 00:00:02,500\nIs it actually faster?\n\n2\n00:00:03,200 --> 00:00:07,500\nThe benchmark says yes.\n';

    writeJson(path.join(directory, 'storyboard/storyboard.json'), storyboard);
    writeJson(path.join(directory, 'script/script.json'), script);
    writeJson(path.join(directory, 'prompt/refined_brief.json'), brief);
    writeJson(path.join(directory, 'compose/timeline.json'), timeline);
    fs.writeFileSync(path.join(directory, 'compose/captions.srt'), captionsText, 'utf8');
    /* One asset in this fixture comes from somewhere else and its licence demands a credit, so the
       credits path is exercised. A project built entirely from owned material has an empty list. */
    const attribution = '"Robotics lab" by Jane Doe — CC BY 4.0 — https://example.com/clip';
    writeJson(path.join(directory, 'generated/asset_manifest.json'), {
      status: 'complete',
      narration: {produced: 2, failed: 0, sections: []},
      scenes: [],
      rights: {can_render: true, blocked: [], attributions: [attribution]},
      counts: {own_media: 0, produced: 0, rendered: 3, still_missing: 0, rights_blocked: 0, total_scenes: 3},
      warnings: []
    });
    writeJson(path.join(directory, 'qc/qc_report.json'), {
      checks: [{id: 'master_readable', label: 'The master can be read', ok: true, detail: 'ok'}],
      blocking_issues: [],
      can_approve_master: true,
      measured: {planned_seconds: 8, duration_seconds: 8, width: 1920, height: 1080, frame_rate: 24, has_audio: true, size_bytes: fs.statSync(masterPath).size},
      master: masterRelative
    });
    fs.writeFileSync(path.join(directory, 'qc/qc_report.md'), '# QC Report\n\nStatus: passed\n', 'utf8');

    // The composed video is recorded on the project, along with the stage revision it came from.
    const projectFile = path.join(directory, 'project.json');
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    project.workflow.stages.compose.revision = 1;
    project.workflow.stages.compose.state = 'needs_review';
    project.master_video = {path: masterRelative, duration_seconds: 8, size_bytes: fs.statSync(masterPath).size, can_approve: true, blocking_issues: 0};
    project.status = 'qc_passed';
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));

    // --- exports before approval must be refused ---
    const early = await api(baseUrl, '/api/projects/' + folder + '/exports', {});
    assert.equal(early.status, 409, 'exports must not be built from an unapproved cut');
    assert.match(early.payload.error, /Approve the video before generating platform exports/);

    // --- the final check ---
    const final = await api(baseUrl, '/api/projects/' + folder + '/final', {});
    assert.equal(final.status, 200, 'final check: ' + JSON.stringify(final.payload).slice(0, 400));
    assert.equal(final.payload.artifact.can_approve, true, 'blocking: ' + JSON.stringify(final.payload.artifact.blocking_issues));
    assert.deepEqual(final.payload.artifact.blocking_issues, []);
    const check = JSON.parse(fs.readFileSync(path.join(directory, 'final/final_check.json'), 'utf8'));
    const computed = check.checks.filter(item => item.mode === 'computed');
    const manual = check.checks.filter(item => item.mode === 'manual');
    assert.ok(computed.length >= 6, 'there must be real computed checks, got ' + computed.length);
    assert.ok(manual.length >= 4, 'there must be manual items to confirm, got ' + manual.length);
    assert.ok(computed.every(item => item.ok === true), 'every computed check must pass on a good video');
    assert.ok(manual.every(item => item.ok === null), 'manual items must not claim to be verified');
    for (const id of ['qc_passed', 'master_playable', 'captions_present', 'rights_cleared', 'duration_on_target', 'thumbnail']) {
      assert.ok(computed.some(item => item.id === id), 'the final check must include ' + id);
    }
    assert.ok(fs.existsSync(path.join(directory, 'final/youtube_thumbnail.jpg')), 'a thumbnail must be extracted');
    assert.ok(probe(path.join(directory, 'final/youtube_thumbnail.jpg')).width === 1280, 'the thumbnail must be 1280 wide');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'final/youtube_metadata.json'), 'utf8'));
    assert.equal(metadata.title, brief.topic);
    assert.ok(metadata.description.includes('In this video:'), 'the description must list the sections');
    assert.ok(metadata.chapters.length === 3, 'chapters must come from the timeline');
    assert.equal(metadata.thumbnail, 'final/youtube_thumbnail.jpg');
    assert.match(metadata.note, /no model wrote this copy/);
    assert.deepEqual(metadata.credits, [attribution], 'the credits the rights gate collected must ride in the metadata');
    assert.ok(metadata.description.includes('Credits:'), 'the description must carry a credits section');
    assert.ok(metadata.description.includes(attribution), 'the attribution itself must be in the text that gets pasted');

    // --- approving the master: the gates ---
    const approve = (body) => api(baseUrl, '/api/projects/' + folder + '/approvals/master_video', body);
    let state = await api(baseUrl, '/api/projects/' + folder + '/intake');
    const revision = state.payload.project.workflow.revision;
    const composeRevision = state.payload.project.workflow.stages.compose.revision;

    const unconfirmed = await approve({decision: 'approved', revision, stage_revision: composeRevision});
    assert.equal(unconfirmed.status, 409, 'approving without confirming the manual items must be refused');
    assert.match(unconfirmed.payload.error, /Confirm the \d+ item\(s\) you are asserting/);

    const partial = await approve({decision: 'approved', revision, stage_revision: composeRevision, confirmed: ['watched']});
    assert.equal(partial.status, 409, 'confirming only some items must still be refused');

    const wrongSubject = await approve({decision: 'approved', revision, stage_revision: composeRevision, confirmed: manual.map(item => item.id), subject: 'compose:99:1:1'});
    assert.equal(wrongSubject.status, 409, 'an approval for a different video must be refused');
    assert.match(wrongSubject.payload.error, /changed since you reviewed it/);

    const changedState = await api(baseUrl, '/api/projects/' + folder + '/intake');
    const approved = await approve({decision: 'approved', revision: changedState.payload.project.workflow.revision, stage_revision: composeRevision, confirmed: manual.map(item => item.id), subject: check.subject});
    assert.equal(approved.status, 200, 'a fully confirmed approval must succeed: ' + JSON.stringify(approved.payload).slice(0, 300));
    const records = approved.payload.project.workflow.approvals;
    const record = records[records.length - 1];
    assert.equal(record.stage, 'master_video');
    assert.equal(record.subject, check.subject, 'the approval must record which video it was for');
    assert.equal(record.confirmed.length, manual.length, 'the confirmed items must be recorded');
    assert.equal(approved.payload.project.workflow.stages.compose.state, 'approved');

    // --- the exports ---
    const exported = await api(baseUrl, '/api/projects/' + folder + '/exports', {});
    assert.equal(exported.status, 200, 'exports: ' + JSON.stringify(exported.payload).slice(0, 500));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'adaptations/export_manifest.json'), 'utf8'));
    const live = manifest.platforms.filter(item => item.status === 'exported');
    assert.equal(live.length, exportsModule.PLATFORMS.length, 'every platform must get an export');
    assert.ok(manifest.platforms.every(item => item.short_note && item.short_source), 'each export must say where its footage came from');

    for (const item of live) {
      const file = path.join(directory, item.video);
      assert.ok(fs.existsSync(file), item.platform + ' video must exist');
      const info = probe(file);
      assert.equal(info.width, item.width, item.platform + ' width');
      assert.equal(info.height, item.height, item.platform + ' height');
      assert.equal(info.hasAudio, true, item.platform + ' must keep the audio');
      assert.ok(info.duration <= item.max_seconds + 0.5, item.platform + ' must respect its duration cap');
      assert.ok(info.duration > 0.5, item.platform + ' must not be empty');
      assert.ok(fs.existsSync(path.join(directory, item.captions)), item.platform + ' captions must exist');
      assert.ok(fs.existsSync(path.join(directory, item.metadata)), item.platform + ' metadata must exist');
      const own = JSON.parse(fs.readFileSync(path.join(directory, item.metadata), 'utf8'));
      assert.equal(own.platform, item.platform);
      assert.equal(own.aspect_ratio, item.aspect_ratio);
      assert.ok(own.title.length <= 100, 'the title must fit the platform');
      assert.match(own.note, /Edit before publishing/);
      assert.deepEqual(own.credits, [attribution], item.platform + ' metadata must carry the credits');
      assert.ok(own.description.includes(attribution), item.platform + ' description must carry the attribution');
    }

    assert.deepEqual(manifest.credits, [attribution], 'the export manifest must list the credits');
    assert.match(manifest.credit_note, /keep them there/);

    // The short comes from the section the script marked short_form, and its captions are retimed.
    const shorts = live.find(item => item.platform === 'youtube_shorts');
    assert.equal(shorts.duration_seconds, 3, 'the hook scene is three seconds long');
    assert.match(shorts.short_source, /short_form/);
    const shortsSrt = fs.readFileSync(path.join(directory, shorts.captions), 'utf8');
    assert.ok(!shortsSrt.includes('The benchmark says yes'), 'the second cue belongs after the short and must be dropped');
    assert.ok(shortsSrt.includes('Is it actually faster?'));

    // --- approval of the exports, and downloads ---
    const approveExports = async (body) => {
      const current = await api(baseUrl, '/api/projects/' + folder + '/intake');
      return api(baseUrl, '/api/projects/' + folder + '/approvals/platform_adaptations', Object.assign({revision: current.payload.project.workflow.revision, stage_revision: current.payload.project.workflow.stages.exports.revision}, body));
    };
    const staleExports = await approveExports({decision: 'approved', subject: 'not-the-current-run'});
    assert.equal(staleExports.status, 409, 'approving a different export run must be refused');
    const exportsApproved = await approveExports({decision: 'approved', subject: manifest.generated_at});
    assert.equal(exportsApproved.status, 200, 'approving the exports must succeed: ' + JSON.stringify(exportsApproved.payload).slice(0, 200));

    const download = await fetch(baseUrl + '/api/projects/' + folder + '/files/' + shorts.video);
    assert.equal(download.status, 200, 'the export must be downloadable');
    assert.equal(download.headers.get('content-type'), 'video/mp4');
    assert.ok(Number(download.headers.get('content-length')) > 1000, 'the download must carry the file');
    const ranged = await fetch(baseUrl + '/api/projects/' + folder + '/files/' + shorts.video, {headers: {range: 'bytes=0-99'}});
    assert.equal(ranged.status, 206, 'a ranged download must be supported for players');
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    const captionDownload = await fetch(baseUrl + '/api/projects/' + folder + '/files/' + shorts.captions);
    assert.equal(captionDownload.status, 200);
    assert.ok((captionDownload.headers.get('content-type') || '').startsWith('text/plain'));

    // The results API serves the final and exports artifacts.
    for (const step of ['final', 'exports']) {
      const results = await api(baseUrl, '/api/projects/' + folder + '/results/' + step);
      assert.equal(results.status, 200, step + ' results must be served');
      assert.ok(results.payload.files.every(file => typeof file.content === 'string' && file.content.length));
    }

    // --- a re-compose invalidates the approval, so exports stop being allowed ---
    const again = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    again.workflow.stages.compose.revision = 2;
    again.master_video = Object.assign({}, again.master_video, {size_bytes: (again.master_video.size_bytes || 0) + 1});
    fs.writeFileSync(projectFile, JSON.stringify(again, null, 2));
    const afterRerender = await api(baseUrl, '/api/projects/' + folder + '/exports', {});
    assert.equal(afterRerender.status, 409, 'a re-rendered video must not inherit the old approval');
    assert.match(afterRerender.payload.error, /Approve the video before generating platform exports/);

    console.log('All exports tests passed: final check, the approval gates, five platform exports, retimed captions and downloads.');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
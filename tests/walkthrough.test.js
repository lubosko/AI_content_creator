'use strict';
/* The whole pipeline in one run: a prompt becomes a playable master and five platform exports.

   The language model and the speech service are mocked; everything downstream of them is real.
   Graphics are drawn by the real template renderer in headless Chrome, the narration is real audio
   bytes measured with ffprobe, the master is really encoded by FFmpeg, QC really inspects the file,
   and the exports are really reframed. This is the walkthrough the documentation points at, kept as a
   test so it cannot rot. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const {createServer} = require('../src/server');
const {detectMediaTools} = require('../src/config/capabilities');
const {placeholderRenderer} = require('../src/lib/providerStages');
const exportsModule = require('../src/lib/exports');

const FFMPEG = detectMediaTools().find(tool => tool.name === 'ffmpeg');
const FFPROBE = detectMediaTools().find(tool => tool.name === 'ffprobe');
assert.ok(FFMPEG && FFMPEG.available, 'ffmpeg is required for the walkthrough');
assert.ok(FFPROBE && FFPROBE.available, 'ffprobe is required for the walkthrough');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

function probe(file) {
  const raw = execFileSync(FFPROBE.path, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {encoding: 'utf8'});
  const parsed = JSON.parse(raw);
  const video = (parsed.streams || []).find(stream => stream.codec_type === 'video') || {};
  return {
    duration: Number(parsed.format && parsed.format.duration),
    width: video.width, height: video.height, rate: video.r_frame_rate, codec: video.codec_name,
    hasAudio: (parsed.streams || []).some(stream => stream.codec_type === 'audio')
  };
}

const RESEARCH = '# Research\n\n## Summary\n\nDora-rs is a Rust dataflow framework for robots.\n\n## Key findings\n\n- The project publishes benchmark figures for bulk CPU data.\n- It is compatible with the LeRobot dataset format.\n\n## Claims to verify\n\n- Whether the benchmark applies to GPU-to-GPU transfer.';
const HOOK = 'Dora-rs promises a faster way to move robot data.';
const BODY = 'The published benchmark covers bulk CPU data over four megabytes. It does not settle GPU-to-GPU transfer, so treat the claim as promising rather than proven.';

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-'));
  const projectsRoot = path.join(root, 'projects');
  const state = { assetId: null };

  const speechPath = path.join(root, 'speech.mp3');
  execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=320:duration=1.6', speechPath], {stdio: 'ignore'});
  const speechBytes = fs.readFileSync(speechPath);

  const providerFetch = async (url, options) => {
    const target = String(url);
    if (target.includes('/audio/speech')) return new Response(speechBytes, {status: 200, headers: {'content-type': 'audio/mpeg'}});
    if (!target.startsWith('https://api.anthropic.com')) {
      if (target.includes('advancedsearch')) return Response.json({response: {docs: []}});
      return Response.json({results: []});
    }
    const prompt = JSON.stringify(JSON.parse(options.body).messages || '');
    let text;
    if (prompt.includes('Create the content strategy')) {
      text = JSON.stringify({story_promise: 'Understand what the Dora-rs benchmark does and does not show', target_audience: 'robotics developers', angle: 'Evidence over marketing', structure: [{section: 'Hook', purpose: 'Open with the claim', seconds: 4}, {section: 'Body', purpose: 'Qualify it', seconds: 8}], hooks: ['Faster than what, exactly?'], retention_moments: ['the GPU caveat'], material_usage: [], short_form_opportunities: ['the benchmark caveat'], risks: ['Benchmark figures may not generalise']});
    } else if (prompt.includes('Write the full narration script')) {
      text = JSON.stringify({sections: [
        {id: 'hook', title: 'Hook', narration: HOOK, visual_notes: ['title card'], seconds: 4, source_refs: ['research'], short_form: true},
        {id: 'body', title: 'Body', narration: BODY, visual_notes: ['benchmark chart'], seconds: 8, source_refs: ['research'], short_form: false}
      ], estimated_duration_seconds: 12});
    } else if (prompt.includes('Plan the storyboard')) {
      text = JSON.stringify({scenes: [
        {id: 'claim', title: 'The claim', narration_section_id: 'hook', seconds: 4, visual_intent: 'Large bold text', asset_id: null, shot_type: 'graphic', on_screen_text: 'Faster? Or just marketing?', graphic_template: 'text-card', graphic_data: {options: {reveal: 'words'}}, generation_prompt: 'title card', transition: ''},
        {id: 'benchmark', title: 'The benchmark', narration_section_id: 'body', seconds: 5, visual_intent: 'Two bars race upward', asset_id: null, shot_type: 'graphic', on_screen_text: 'ROS2=100 | Dora-rs=380', graphic_template: 'bar-chart', graphic_data: {bars: [{label: 'ROS2', value: 100}, {label: 'Dora-rs', value: 380, display: '380 MB/s'}], footnote: '*published project benchmark'}, generation_prompt: 'bar chart', transition: ''},
        {id: 'caveat', title: 'The caveat', narration_section_id: 'body', seconds: 5, visual_intent: 'Terminal showing the install', asset_id: null, shot_type: 'graphic', on_screen_text: 'PS> pip install dora-rs', graphic_template: 'terminal', graphic_data: {title: 'powershell', lines: [{prompt: 'PS>', text: 'pip install dora-rs'}, {text: 'GPU transfer: not measured here'}]}, generation_prompt: 'terminal', transition: ''}
      ], total_duration_seconds: 14});
    } else {
      text = RESEARCH;
    }
    return Response.json({id: 'msg', model: 'test-model', stop_reason: 'end_turn', content: [{type: 'text', text}], usage: {input_tokens: 5, output_tokens: 5}});
  };

  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model', OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'whisper-1'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    providerFetch,
    // The real template renderer, at the size the composer will place.
    renderGraphic: placeholderRenderer({width: 1920, height: 1080, fps: 24}),
    graphicFps: 24
  });
  const baseUrl = await listen(server);

  const api = async (route, body) => {
    const options = body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)};
    const response = await fetch(baseUrl + route, options);
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (error) { payload = {raw: text}; }
    return {status: response.status, payload};
  };

  try {
    // 1. A prompt becomes a project.
    const created = await api('/api/projects', {prompt: 'A three minute video about the Dora-rs benchmark for robotics developers.'});
    assert.equal(created.status, 201, 'a project must be created from the prompt');
    const folder = created.payload.folder;
    const directory = path.join(projectsRoot, folder);

    // 2. The brief is confirmed, and one real file is offered as own material.
    let intake = await api('/api/projects/' + folder + '/intake');
    await api('/api/projects/' + folder + '/brief', Object.assign({}, intake.payload.brief, {angle: 'Evidence over marketing', purpose: 'Understand the claim', target_duration_seconds: 14, revision: intake.payload.project.workflow.revision}));
    const mediaPath = path.join(root, 'own-clip.mp4');
    execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x224466:s=1920x1080:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mediaPath], {stdio: 'ignore'});
    const upload = await fetch(baseUrl + '/api/library/upload?name=own-clip.mp4&category=media', {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: fs.readFileSync(mediaPath)});
    state.assetId = (await upload.json()).asset.id;
    await api('/api/library/rights', {asset_ids: [state.assetId], basis: 'own'});
    intake = await api('/api/projects/' + folder + '/intake');
    await api('/api/projects/' + folder + '/materials', {revision: intake.payload.project.workflow.revision, asset_id: state.assetId, decision: 'use'});
    intake = await api('/api/projects/' + folder + '/intake');
    const confirmed = await api('/api/projects/' + folder + '/materials-confirm', {revision: intake.payload.project.workflow.revision});
    assert.equal(confirmed.status, 200, 'the material decision must be confirmable once rights are recorded');

    const approve = async (stage) => {
      const current = await api('/api/projects/' + folder + '/intake');
      const result = await api('/api/projects/' + folder + '/approvals/' + stage, {decision: 'approved', revision: current.payload.project.workflow.revision, stage_revision: current.payload.project.workflow.stages[stage].revision});
      assert.equal(result.status, 200, 'approving ' + stage + ' must succeed');
      return result;
    };

    // 3. Research, strategy, script and storyboard, each approved.
    const research = await api('/api/projects/' + folder + '/research', {provider: 'anthropic', web_search: false, include_materials: true});
    assert.equal(research.status, 200);
    await approve('research');
    assert.equal((await api('/api/projects/' + folder + '/strategy', {provider: 'anthropic'})).status, 200);
    await approve('strategy');
    assert.equal((await api('/api/projects/' + folder + '/script', {provider: 'anthropic'})).status, 200);
    await approve('script');
    const storyboard = await api('/api/projects/' + folder + '/storyboard', {provider: 'anthropic'});
    assert.equal(storyboard.status, 200, 'storyboard: ' + JSON.stringify(storyboard.payload).slice(0, 300));
    await approve('storyboard');

    // 4. Assets: real narration bytes and real template graphics.
    const assets = await api('/api/projects/' + folder + '/assets', {});
    assert.equal(assets.status, 200, 'assets: ' + JSON.stringify(assets.payload).slice(0, 400));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'generated/asset_manifest.json'), 'utf8'));
    assert.equal(manifest.counts.rendered, 3, 'all three scenes are drawn by real templates');
    assert.equal(manifest.counts.still_missing, 0);
    assert.equal(manifest.narration.failed, 0);
    for (const section of manifest.narration.sections) assert.ok(section.duration_seconds > 0.5, 'narration durations must be measured');

    // 5. The composer writes a real master and QC inspects it.
    const render = await api('/api/projects/' + folder + '/render', {});
    assert.equal(render.status, 200, 'render: ' + JSON.stringify(render.payload).slice(0, 400));
    assert.equal(render.payload.artifact.can_approve_master, true, 'a fully produced project must pass QC: ' + JSON.stringify(render.payload.artifact.blocking_issues));
    const master = path.join(directory, 'final/youtube_master.mp4');
    const masterInfo = probe(master);
    assert.equal(masterInfo.codec, 'h264');
    assert.equal(masterInfo.width, 1920);
    assert.equal(masterInfo.height, 1080);
    assert.equal(masterInfo.rate, '24/1');
    assert.equal(masterInfo.hasAudio, true);
    assert.ok(Math.abs(masterInfo.duration - 14) < 1, 'the master must be about fourteen seconds, got ' + masterInfo.duration);

    // 6. The final check, then the approval gate.
    const finalCheck = await api('/api/projects/' + folder + '/final', {});
    assert.equal(finalCheck.status, 200, 'final check: ' + JSON.stringify(finalCheck.payload).slice(0, 300));
    assert.equal(finalCheck.payload.artifact.can_approve, true);
    const check = JSON.parse(fs.readFileSync(path.join(directory, 'final/final_check.json'), 'utf8'));
    const manual = check.checks.filter(item => item.mode === 'manual').map(item => item.id);

    const refused = await api('/api/projects/' + folder + '/approvals/master_video', {decision: 'approved', revision: render.payload.project.workflow.revision, confirmed: []});
    assert.equal(refused.status, 409, 'the video must not be approvable without confirming the manual checks');

    let current = await api('/api/projects/' + folder + '/intake');
    const approvedMaster = await api('/api/projects/' + folder + '/approvals/master_video', {decision: 'approved', revision: current.payload.project.workflow.revision, confirmed: manual, subject: check.subject});
    assert.equal(approvedMaster.status, 200, 'the video must be approvable once the checks are confirmed: ' + JSON.stringify(approvedMaster.payload).slice(0, 200));

    // 7. The platform exports, then a download.
    const exportsRun = await api('/api/projects/' + folder + '/exports', {});
    assert.equal(exportsRun.status, 200, 'exports: ' + JSON.stringify(exportsRun.payload).slice(0, 400));
    const exportsManifest = JSON.parse(fs.readFileSync(path.join(directory, 'adaptations/export_manifest.json'), 'utf8'));
    const live = exportsManifest.platforms.filter(item => item.status === 'exported');
    assert.equal(live.length, exportsModule.PLATFORMS.length, 'every platform must be exported');
    for (const item of live) {
      const info = probe(path.join(directory, item.video));
      assert.equal(info.width, item.width, item.platform + ' width');
      assert.equal(info.height, item.height, item.platform + ' height');
      assert.ok(info.duration <= item.max_seconds + 0.5, item.platform + ' duration');
      assert.equal(info.hasAudio, true, item.platform + ' audio');
    }
    const vertical = live.find(item => item.aspect_ratio === '9:16');
    /* This project draws its own graphics and narrates its own script, so nothing needs a credit and
       the manifest must say exactly that rather than staying silent about it. */
    assert.deepEqual(exportsManifest.credits, [], 'nothing in the walkthrough requires an attribution');
    assert.match(exportsManifest.credit_note, /no attribution is required/);
    assert.ok(vertical.description.indexOf('Credits:') === -1, 'no credits section when nothing needs crediting');
    const download = await fetch(baseUrl + '/api/projects/' + folder + '/files/' + vertical.video);
    assert.equal(download.status, 200, 'the export must be downloadable');
    assert.equal(download.headers.get('content-type'), 'video/mp4');
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.ok(bytes.length > 10000, 'the download must carry the whole file, got ' + bytes.length + ' bytes');
    assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp', 'the download must be a real MP4');

    // 8. The whole journey is recorded on the project, and every stage is approved.
    const finished = await api('/api/projects/' + folder + '/intake');
    const stages = finished.payload.project.workflow.stages;
    for (const stage of ['research', 'strategy', 'script', 'storyboard', 'compose', 'final', 'exports']) {
      assert.ok(stages[stage].revision > 0, stage + ' must have produced a revision');
    }
    assert.equal(stages.research.state, 'approved');
    assert.equal(stages.strategy.state, 'approved');
    assert.equal(stages.script.state, 'approved');
    assert.equal(stages.storyboard.state, 'approved');
    const gateRecords = finished.payload.project.workflow.approvals.filter(item => item.stage === 'master_video');
    assert.equal(gateRecords[gateRecords.length - 1].decision, 'approved');

    console.log('Walkthrough passed: prompt -> brief -> material -> research -> strategy -> script -> storyboard -> assets -> master -> QC -> approval -> five exports -> download.');
    console.log('Master: ' + masterInfo.width + 'x' + masterInfo.height + ' ' + masterInfo.duration.toFixed(2) + 's, ' + Math.round(fs.statSync(master).size / 1024) + ' KB. Exports: ' + live.map(item => item.platform + ' ' + item.width + 'x' + item.height).join(', ') + '.');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
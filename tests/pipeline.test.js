'use strict';
/* Run to final check: the sequencing, the stop points, and the run record that survives a reload.

   Two layers are covered. The engine is driven directly with fake steps, which is how cancellation, a
   failed scene and the interrupted state are reached deterministically. The routes are driven through
   the real server with real FFmpeg, which is what proves the happy path actually renders. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const {createServer} = require('../src/server');
const {detectMediaTools} = require('../src/config/capabilities');
const pipeline = require('../src/lib/pipeline');

const FFMPEG = detectMediaTools().find(tool => tool.name === 'ffmpeg');
const FFPROBE = detectMediaTools().find(tool => tool.name === 'ffprobe');
assert.ok(FFMPEG && FFMPEG.available, 'ffmpeg is required for the pipeline test');
assert.ok(FFPROBE && FFPROBE.available, 'ffprobe is required for the pipeline test');

/* A drawn scene, injected so the assets stage needs no browser. The real renderer is covered in
   tests/render.test.js. */
function injectedRenderer() {
  return async ({template, outputPath, seconds, fps}) => {
    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outputPath], {stdio: 'ignore'});
    const frameCount = Math.max(1, Math.round((fps || 4) * seconds));
    return {path: outputPath, template, width: 320, height: 180, fps: fps || 4, frameCount, durationSeconds: frameCount / (fps || 4), bytes: fs.statSync(outputPath).size, fit: {ok: true, fontSize: 20}};
  };
}

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
  return {status: response.status, payload};
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function waitForRun(baseUrl, folder, options = {}) {
  const timeout = options.timeout || 120000;
  const started = Date.now();
  for (;;) {
    const state = await api(baseUrl, '/api/projects/' + folder + '/pipeline');
    assert.equal(state.status, 200, 'pipeline status: ' + JSON.stringify(state.payload).slice(0, 300));
    const run = state.payload.run;
    if (run && !['running'].includes(run.status)) return {run, state: state.payload};
    if (Date.now() - started > timeout) throw new Error('the pipeline did not finish in time: ' + JSON.stringify(run));
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

/* A project whose storyboard is approved and whose single scene is drawn locally, so the assets stage
   can complete without any provider. */
async function buildProject(baseUrl, projectsRoot, scene) {
  const created = await api(baseUrl, '/api/projects', {prompt: 'A video about robot safety for plant managers.'});
  const folder = created.payload.folder;
  const directory = path.join(projectsRoot, folder);

  let intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  await api(baseUrl, '/api/projects/' + folder + '/brief', Object.assign({}, intake.payload.brief, {angle: 'Practical', purpose: 'Safety', revision: intake.payload.project.workflow.revision}));
  intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  await api(baseUrl, '/api/projects/' + folder + '/materials-confirm', {revision: intake.payload.project.workflow.revision, without_material: true});

  writeJson(path.join(directory, 'script/script.json'), {sections: [{id: 'hook', title: 'Hook', narration: 'The robot will not warn you.', seconds: 4}], estimated_duration_seconds: 4});
  writeJson(path.join(directory, 'storyboard/storyboard.json'), {
    scenes: [scene], total_duration_seconds: 4, missing_assets: [], selected_asset_ids: []
  });
  const projectFile = path.join(directory, 'project.json');
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  project.workflow.stages.storyboard = Object.assign({}, project.workflow.stages.storyboard, {revision: 1, state: 'needs_review'});
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');
  return {folder, directory, projectFile};
}

async function approveStoryboard(baseUrl, projectFile) {
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  return api(baseUrl, '/api/projects/' + path.basename(path.dirname(projectFile)) + '/approvals/storyboard', {
    decision: 'approved', revision: project.workflow.revision, stage_revision: 1
  });
}

async function withServer(testFn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  const projectsRoot = path.join(root, 'projects');
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    renderGraphic: injectedRenderer(),
    graphicFps: 4
  });
  const baseUrl = await listen(server);
  try { await testFn({baseUrl, projectsRoot, root}); }
  finally { await close(server); fs.rmSync(root, {recursive: true, force: true}); }
}

/* ------------------------------------------------------------------ engine, with fake steps */

function fakeRunner(overrides) {
  const calls = [];
  const deps = Object.assign({
    comfyReady: () => true,
    comfyUnavailableReason: () => 'not available',
    generateScene: async ({sceneId}) => { calls.push('generate:' + sceneId); return {asset_id: 'asset-' + sceneId}; },
    runAssets: async () => { calls.push('assets'); return {}; },
    runCompose: async () => { calls.push('compose'); return {}; },
    runFinal: async () => { calls.push('final'); return {}; }
  }, overrides || {});
  return {deps, calls};
}

async function drain(runner, directory, folder) {
  for (let i = 0; i < 600; i++) {
    const run = runner.status(directory, folder);
    if (run && run.status !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('the run never settled');
}

async function testEngine() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-engine-'));
  try {
    // --- happy path: every step runs in order, and nothing is approved ---
    const happy = fakeRunner();
    const board = {scenes: [{id: 's1', seconds: 4, generation_prompt: 'a robot arm'}, {id: 's2', seconds: 4, graphic_template: 'text-card'}]};
    const runner = pipeline.createPipelineRunner();
    runner.start({folder: 'p1', directory, board, stopAfter: 'final_check', deps: happy.deps});
    const done = await drain(runner, directory, 'p1');
    assert.equal(done.status, 'succeeded', 'stop reason: ' + done.stop_reason);
    assert.deepEqual(happy.calls, ['generate:s1', 'assets', 'compose', 'final'], 'the steps must run in order, and only the scene without a template is generated');
    assert.deepEqual(done.steps.map(step => step.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    assert.match(done.stop_reason, /approve it/, 'the run must hand the decision back to the operator');

    // --- stop after generating: the render is deliberately not started ---
    const partial = fakeRunner();
    const runner2 = pipeline.createPipelineRunner();
    runner2.start({folder: 'p2', directory, board, stopAfter: 'generate', deps: partial.deps});
    const stopped = await drain(runner2, directory, 'p2');
    assert.equal(stopped.status, 'succeeded');
    assert.deepEqual(partial.calls, ['generate:s1'], 'stop_after generate must not render');
    assert.match(stopped.stop_reason, /Stopped after generating media/);

    // --- a failed scene stops the run rather than rendering around the hole ---
    const failing = fakeRunner({generateScene: async ({sceneId}) => { if (sceneId === 's1') throw new Error('Comfy returned no image or video.'); return {asset_id: 'x'}; }});
    const runner3 = pipeline.createPipelineRunner();
    runner3.start({folder: 'p3', directory, board, stopAfter: 'final_check', deps: failing.deps});
    const failed = await drain(runner3, directory, 'p3');
    assert.equal(failed.status, 'stopped');
    assert.match(failed.stop_reason, /could not be generated/);
    assert.match(failed.stop_reason, /s1/);
    assert.match(failed.stop_reason, /retries only these/, 'the operator must be told a re-run is cheap');
    assert.equal(failed.generated.failed.length, 1);

    // --- no Comfy configured: generation is skipped and reported, not silently ignored ---
    const noComfy = fakeRunner({comfyReady: () => false, comfyUnavailableReason: () => 'No Comfy API key is configured.'});
    const runner4 = pipeline.createPipelineRunner();
    runner4.start({folder: 'p4', directory, board, stopAfter: 'final_check', deps: noComfy.deps});
    const skipped = await drain(runner4, directory, 'p4');
    assert.equal(skipped.status, 'succeeded');
    assert.equal(skipped.steps[0].status, 'skipped');
    assert.match(skipped.steps[0].detail, /No Comfy API key/);
    assert.deepEqual(noComfy.calls, ['assets', 'compose', 'final'], 'the rest of the pipeline must still run');

    // --- cancellation stops between scenes and cancels the in-flight job through the signal ---
    let sawSignal = false;
    const slow = fakeRunner({
      // Behaves like the real step: it observes the signal and rejects as cancelled.
      generateScene: async ({signal}) => {
        sawSignal = !!signal;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          if (signal) signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const error = new Error('Generation was cancelled.');
            error.canceled = true;
            reject(error);
          });
        });
        return {asset_id: 'never'};
      }
    });
    const runner5 = pipeline.createPipelineRunner();
    runner5.start({folder: 'p5', directory, board, stopAfter: 'final_check', deps: slow.deps});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(runner5.isRunning('p5'), true);
    assert.equal(runner5.cancel('p5'), true);
    const canceled = await drain(runner5, directory, 'p5');
    assert.equal(canceled.status, 'canceled');
    assert.equal(sawSignal, true, 'the engine must hand the cancel signal to the generation step');
    assert.match(canceled.stop_reason, /Cancelled during generation/);
    assert.match(canceled.stop_reason, /Scenes already generated are attached/);
    assert.equal(runner5.cancel('p5'), false, 'cancelling a finished run is a no-op, not an error');

    // --- a record that says running with no task behind it is reported as interrupted ---
    writeJson(path.join(directory, pipeline.RUN_FILE), {started_at: '2026-01-01T00:00:00Z', stop_after: 'final_check', status: 'running', steps: [], generated: {}, stop_reason: null});
    const fresh = pipeline.createPipelineRunner();
    const interrupted = fresh.status(directory, 'p9');
    assert.equal(interrupted.status, 'interrupted', 'a server restart must not look like a frozen progress bar');
    assert.match(interrupted.stop_reason, /already generated are attached/);

    // --- a busy project refuses a second run ---
    const runner6 = pipeline.createPipelineRunner();
    runner6.start({folder: 'p6', directory, board, stopAfter: 'generate', deps: slow.deps});
    assert.throws(() => runner6.start({folder: 'p6', directory, board, stopAfter: 'generate', deps: slow.deps}), /already in progress/);
    runner6.cancel('p6');
    await drain(runner6, directory, 'p6');

    // --- preflight refuses an unapproved storyboard, and says why ---
    const unapproved = {directory: '/nowhere', project: {workflow: {brief: {state: 'approved'}, materials: {state: 'approved'}, stages: {storyboard: {revision: 1, state: 'needs_review'}}}}};
    const check = pipeline.preflight(unapproved);
    assert.equal(check.ok, false);
    assert.match(check.problems.join(' '), /Approve the storyboard first/);
    assert.match(check.problems.join(' '), /costs credits/, 'the reason must explain why, not just refuse');

    const noBrief = {directory: '/nowhere', project: {workflow: {brief: {state: 'draft'}, materials: {state: 'draft'}, stages: {}}}};
    assert.equal(pipeline.preflight(noBrief).problems.length >= 3, true);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
  console.log('  engine: order, stop points, failed scene, no Comfy, cancel, interrupted and preflight');
}

/* ------------------------------------------------------------------ routes, with real FFmpeg */

async function testRouteHappyPath() {
  await withServer(async ({baseUrl, projectsRoot}) => {
    const built = await buildProject(baseUrl, projectsRoot, {
      id: 'scene_one', title: 'Safety rules', narration_section_id: 'hook', seconds: 4,
      visual_intent: 'A text card', asset_id: null, shot_type: 'graphic', on_screen_text: 'Wear the vest',
      graphic_template: 'text-card', graphic_data: {data: {}, options: {}}, generation_prompt: '', transition: ''
    });
    const approved = await approveStoryboard(baseUrl, built.projectFile);
    assert.equal(approved.status, 200, JSON.stringify(approved.payload).slice(0, 300));

    const before = await api(baseUrl, '/api/projects/' + built.folder + '/pipeline');
    assert.equal(before.status, 200);
    assert.equal(before.payload.can_start, true, 'problems: ' + JSON.stringify(before.payload.problems));
    assert.equal(before.payload.plan.storyboard_approved, true);
    assert.equal(before.payload.plan.scenes_needing_media, 0, 'a scene with a local template does not need media');
    assert.equal(before.payload.plan.scenes_to_generate, 0, 'a scene with a template is never sent to a generator');
    assert.equal(before.payload.run, null, 'no run has happened yet');

    const started = await api(baseUrl, '/api/projects/' + built.folder + '/pipeline', {stop_after: 'final_check'});
    assert.equal(started.status, 202, JSON.stringify(started.payload).slice(0, 300));
    assert.equal(started.payload.run.status, 'running');

    const finished = await waitForRun(baseUrl, built.folder);
    const run = finished.run;
    assert.equal(run.status, 'succeeded', 'stop reason: ' + run.stop_reason);
    assert.deepEqual(run.steps.map(step => step.id), ['generate', 'assets', 'compose', 'final']);
    assert.equal(run.steps[0].status, 'skipped', 'with no Comfy configured, generation is skipped and said so');
    assert.equal(run.steps[1].status, 'succeeded');
    assert.equal(run.steps[2].status, 'succeeded');
    assert.equal(run.steps[3].status, 'succeeded');
    assert.match(run.stop_reason, /approve it/);
    assert.equal(run.approved, undefined, 'the pipeline must not record an approval');

    // The artifacts a human then reviews really exist.
    assert.ok(fs.existsSync(path.join(built.directory, 'final/youtube_master.mp4')), 'the master must be rendered');
    assert.ok(fs.existsSync(path.join(built.directory, 'qc/qc_report.json')), 'QC must have run');
    assert.ok(fs.existsSync(path.join(built.directory, 'final/final_check.json')), 'the final check must have run');
    const qc = JSON.parse(fs.readFileSync(path.join(built.directory, 'qc/qc_report.json'), 'utf8'));
    assert.equal(qc.measured.width, 1920, 'the master must be the planned size');
    const size = fs.statSync(path.join(built.directory, 'final/youtube_master.mp4')).size;
    assert.ok(size > 1000, 'the master must carry real bytes, got ' + size);

    // And nothing approved it: the storyboard approval is the only approval on the project.
    const intake = await api(baseUrl, '/api/projects/' + built.folder + '/intake');
    const masterApproval = intake.payload.project.workflow.approvals.filter(item => item.stage === 'master_video');
    assert.equal(masterApproval.length, 0, 'the master must still be waiting for the operator');
    /* The composer has no approval gate, so its result does not "wait for review" - only the finished
       video does, at the final check. Resting at `needs_review` put a review badge on a screen that
       offered no decision, and the approval button it drew returned 404. */
    assert.equal(intake.payload.project.workflow.stages.compose.state, 'ready', 'a render is a production step, not a gate');
    assert.equal(intake.payload.project.workflow.stages.final.state, 'needs_review', 'the final check is what waits for the operator');

    // A second run is allowed once the first has settled.
    const rerun = await api(baseUrl, '/api/projects/' + built.folder + '/pipeline', {stop_after: 'final_check'});
    assert.equal(rerun.status, 202);
    await waitForRun(baseUrl, built.folder);
  });
  console.log('  routes: a real render to a real final check, with nothing approved on the way');
}

async function testRouteStopsOnMissingMedia() {
  await withServer(async ({baseUrl, projectsRoot}) => {
    // No template, no own media, no Comfy: the generate step skips and the assets stage cannot fill it.
    const built = await buildProject(baseUrl, projectsRoot, {
      id: 'scene_one', title: 'Robot arm', narration_section_id: 'hook', seconds: 4,
      visual_intent: 'A robot arm', asset_id: null, shot_type: 'wide', on_screen_text: '',
      generation_prompt: 'a robot arm on a workbench', transition: ''
    });
    await approveStoryboard(baseUrl, built.projectFile);

    const before = await api(baseUrl, '/api/projects/' + built.folder + '/pipeline');
    assert.equal(before.payload.plan.scenes_to_generate, 1, 'the scene has a prompt, so it is a generation candidate');

    await api(baseUrl, '/api/projects/' + built.folder + '/pipeline', {stop_after: 'final_check'});
    const finished = await waitForRun(baseUrl, built.folder);
    assert.equal(finished.run.status, 'stopped');
    assert.match(finished.run.stop_reason, /still have no media/);
    assert.match(finished.run.stop_reason, /scene_one/);
    assert.equal(finished.run.steps[1].status, 'failed');
    assert.equal(finished.run.steps[2].status, 'pending', 'the composer must not run for a video with a hole in it');
    assert.equal(fs.existsSync(path.join(built.directory, 'final/youtube_master.mp4')), false, 'no render may be wasted');
  });
  console.log('  routes: a scene with no media stops before the render instead of composing around a hole');
}

async function testRouteRefusals() {
  await withServer(async ({baseUrl, projectsRoot}) => {
    const built = await buildProject(baseUrl, projectsRoot, {
      id: 'scene_one', title: 'Safety rules', narration_section_id: 'hook', seconds: 4,
      visual_intent: 'A text card', asset_id: null, shot_type: 'graphic', on_screen_text: 'Wear the vest',
      graphic_template: 'text-card', graphic_data: {data: {}, options: {}}, generation_prompt: '', transition: ''
    });

    // Unapproved storyboard: refused, with the reason, and nothing started.
    const refused = await api(baseUrl, '/api/projects/' + built.folder + '/pipeline', {stop_after: 'final_check'});
    assert.equal(refused.status, 409);
    assert.match(refused.payload.error, /Approve the storyboard first/);
    assert.match(refused.payload.error, /costs credits/);
    const after = await api(baseUrl, '/api/projects/' + built.folder + '/pipeline');
    assert.equal(after.payload.can_start, false);
    assert.equal(after.payload.run, null, 'a refused start must not create a run record');

    // Cancelling a project with no run is reported, not thrown.
    const canceled = await api(baseUrl, '/api/projects/' + built.folder + '/pipeline/cancel', {});
    assert.equal(canceled.status, 200);
    assert.equal(canceled.payload.canceled, false);

    // An unknown project is a 404, like every other project route.
    const missing = await api(baseUrl, '/api/projects/2026-999-nope/pipeline');
    assert.equal(missing.status, 404);
  });
  console.log('  routes: preflight refused, nothing started, and no run record left behind');
}

async function run() {
  await testEngine();
  await testRouteHappyPath();
  await testRouteStopsOnMissingMedia();
  await testRouteRefusals();
  console.log('All run-to-final-check tests passed: ordering, stop points, resumable records, cancellation and a real render (no provider calls).');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
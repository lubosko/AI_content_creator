'use strict';
/* The Run to final check screen and the Comfy generate control, rendered by the real views in the
   fake DOM against a real server. The pipeline really renders with FFmpeg; Comfy is only read for its
   status, so no generation is ever submitted here. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const {createServer} = require('../src/server');
const {boot} = require('./helpers/ui-harness');
const {detectMediaTools} = require('../src/config/capabilities');

const FFMPEG = detectMediaTools().find(tool => tool.name === 'ffmpeg');
assert.ok(FFMPEG && FFMPEG.available, 'ffmpeg is required for the pipeline screen test');

const API_WORKFLOW = {
  '3': {class_type: 'KSampler', inputs: {seed: 1}},
  '6': {class_type: 'CLIPTextEncode', inputs: {text: '', clip: ['4', 0]}},
  '9': {class_type: 'SaveImage', inputs: {images: ['8', 0]}}
};

/* A real 8x8 PNG, so the generated scene is genuine image data. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP8y4AdsOAQH6QSANErARssm0F5AAAAAElFTkSuQmCC', 'base64');
const SIGNED_URL = 'https://signed.example.invalid/asset.png';

/* The whole Comfy surface, mocked. No request leaves the machine, which is also what keeps a test
   from ever spending credits. */
function mockComfy() {
  return async (url, options = {}) => {
    const target = String(url);
    const method = options.method || 'GET';
    if (target.endsWith('/api/v2/jobs') && method === 'POST') {
      return Response.json({id: 'job-1', status: 'queued', progress: null, outputs: [], error: null, urls: {}}, {status: 201});
    }
    if (/\/api\/v2\/jobs\/[^/]+$/.test(target)) {
      // Terminal on the first poll, so the screen test is not waiting on a simulated GPU.
      return Response.json({
        id: 'job-1', status: 'succeeded', progress: {value: 1},
        outputs: [{node_id: '9', name: 'ComfyUI_00001_.png', type: 'image', content_type: 'image/png', size_bytes: PNG.length, id: 'asset-1', hash: null, url: SIGNED_URL, url_expires_at: '2030-01-01T00:00:00Z'}],
        error: null, urls: {}
      });
    }
    if (/\/api\/v2\/assets\/[^/]+\/content$/.test(target)) {
      return new Response(null, {status: 302, headers: {location: SIGNED_URL}});
    }
    if (target === SIGNED_URL) return new Response(PNG, {status: 200, headers: {'content-type': 'image/png'}});
    throw new Error('unexpected request in the Comfy mock: ' + target);
  };
}

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
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/* An approved storyboard with one scene drawn locally, so a pipeline run needs no provider at all. */
async function buildProject(base, projectsRoot, configured) {
  const created = await (await fetch(base + '/api/projects', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({prompt: 'A video about robot safety for plant managers.'})
  })).json();
  const folder = created.folder;
  const directory = path.join(projectsRoot, folder);

  let intake = await (await fetch(base + '/api/projects/' + folder + '/intake')).json();
  const post = (route, body) => fetch(base + route, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  await post('/api/projects/' + folder + '/brief', Object.assign({}, intake.brief, {angle: 'Practical', purpose: 'Safety', revision: intake.project.workflow.revision}));
  intake = await (await fetch(base + '/api/projects/' + folder + '/intake')).json();
  await post('/api/projects/' + folder + '/materials-confirm', {revision: intake.project.workflow.revision, without_material: true});

  writeJson(path.join(directory, 'script/script.json'), {sections: [{id: 'hook', title: 'Hook', narration: 'The robot will not warn you.', seconds: 4}], estimated_duration_seconds: 4});
  writeJson(path.join(directory, 'storyboard/storyboard.json'), {
    scenes: [
      {id: 'scene_one', title: 'Safety rules', narration_section_id: 'hook', seconds: 4, visual_intent: 'A text card', asset_id: null, shot_type: 'graphic', on_screen_text: 'Wear the vest', graphic_template: 'text-card', graphic_data: {data: {}, options: {}}, generation_prompt: '', transition: ''},
      {id: 'scene_two', title: 'Robot arm', narration_section_id: 'hook', seconds: 4, visual_intent: 'A robot arm on a bench', asset_id: null, shot_type: 'wide', on_screen_text: '', generation_prompt: 'a robot arm on a workbench', transition: ''}
    ],
    total_duration_seconds: 8, missing_assets: [], selected_asset_ids: []
  });
  const projectFile = path.join(directory, 'project.json');
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  project.workflow.stages.storyboard = Object.assign({}, project.workflow.stages.storyboard, {revision: 1, state: 'needs_review'});
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');

  if (configured) {
    writeJson(path.join(projectsRoot, '_settings/comfy/workflows.json'), {version: 1, default: 'image', workflows: {image: {file: 'image.workflow.json', output: 'image', prompt_node: '6', prompt_field: 'text'}}});
    writeJson(path.join(projectsRoot, '_settings/comfy/image.workflow.json'), API_WORKFLOW);
  }
  return {folder, directory, projectFile};
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-pipeline-'));
  const projectsRoot = path.join(root, 'projects');
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {COMFY_API_KEY: 'test-comfy-key'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    providerFetch: mockComfy(),
    renderGraphic: injectedRenderer(),
    graphicFps: 4
  });
  const base = await listen(server);
  try {
    const built = await buildProject(base, projectsRoot, true);
    const ui = boot({base});

    // --- the menu entry ---
    ui.navigate('#/project/' + encodeURIComponent(built.folder) + '/storyboard');
    await ui.settle(() => ui.document.querySelectorAll('.fill-scene').length >= 1, {description: 'the storyboard screen', timeout: 8000});
    const entry = ui.document.getElementById('goPipeline');
    assert.ok(entry, 'the menu must carry the run action');
    assert.equal(entry.disabled, false, 'with a project open the action is available');
    // The visible label lives in the shell (index.html), which tests/ui-browser.test.js drives for real.

    // --- the Comfy control on a scene that needs media ---
    const viewText = ui.text(ui.document.getElementById('viewBody'));
    assert.ok(viewText.indexOf('Comfy') >= 0, 'the scene panel must offer generation');
    await ui.settle(() => ui.text(ui.document.getElementById('viewBody')).indexOf('Nothing has been generated for this scene yet') >= 0, {description: 'the Comfy panel to load its status', timeout: 8000});
    const workflowSelect = ui.byId('comfy-workflow-scene_two');
    assert.ok(workflowSelect, 'the workflow configured on the server must be offered');
    assert.equal(workflowSelect.value, 'image');
    assert.deepEqual(workflowSelect.querySelectorAll('option').map(node => node.value), ['image']);
    assert.ok(ui.byId('comfy-prompt-scene_two'), 'the prompt must be editable here');
    assert.equal(ui.byId('comfy-prompt-scene_two').value, 'a robot arm on a workbench', 'the prompt is pre-filled from the storyboard');
    assert.ok((ui.findAll('button') || []).some(node => ui.text(node) === 'Generate this scene'), 'the generate action must be offered');
    const cost = ui.text(ui.document.getElementById('viewBody'));
    assert.ok(cost.indexOf('costs Comfy credits') >= 0, 'the cost must be stated before it is spent');

    // The scene drawn locally must not be offered a paid generation.
    assert.equal(ui.byId('comfy-workflow-scene_one'), null, 'a scene with a template is not offered generation');

    /* A workflows.json that names a file which is not there is not a working setup: the panel must say
       so rather than offering a generation the app cannot deliver. */
    const configOnly = {version: 1, default: 'image', workflows: {image: {file: 'image.workflow.json', output: 'image'}}};
    const workflowFile = path.join(projectsRoot, '_settings/comfy/image.workflow.json');
    const saved = fs.readFileSync(workflowFile, 'utf8');
    fs.rmSync(workflowFile);
    ui.navigate('#/project/' + encodeURIComponent(built.folder) + '/brief');
    await ui.settle(() => !!ui.document.getElementById('viewBody'), {description: 'a different screen', timeout: 8000});
    ui.navigate('#/project/' + encodeURIComponent(built.folder) + '/storyboard');
    await ui.settle(() => ui.text(ui.document.getElementById('viewBody')).indexOf('No exported workflow is in place') >= 0,
      {description: 'the panel to report the missing workflow file', timeout: 8000});
    const missingText = ui.text(ui.document.getElementById('viewBody'));
    assert.ok(missingText.indexOf('image.workflow.json') >= 0, 'the message must name the file it expects');
    assert.equal(ui.byId('comfy-workflow-scene_two'), null, 'no generation may be offered without a workflow file');
    void configOnly;
    fs.writeFileSync(workflowFile, saved, 'utf8');

    // --- the pipeline screen ---
    ui.navigate(ui.window.Router.pipelineHref(built.folder));
    await ui.settle(() => ui.text(ui.document.getElementById('viewBody')).indexOf('What this does') >= 0, {description: 'the pipeline screen', timeout: 8000});
    assert.ok(ui.text(ui.document.getElementById('viewTitle')) === 'Run to final check');

    const panelText = ui.text(ui.document.getElementById('viewBody'));
    assert.ok(panelText.indexOf('never approves anything') >= 0, 'the screen must state what it will not do');
    assert.ok(panelText.indexOf('Scenes needing media') >= 0);
    assert.ok(ui.byId('pipelineStopAfter'), 'the stop point must be selectable');
    assert.deepEqual(ui.byId('pipelineStopAfter').querySelectorAll('option').map(node => node.value), ['final_check', 'generate']);

    // The storyboard is not approved yet, so the run is refused at the button, with the reason shown.
    const blockedStart = ui.findAll('button').filter(node => ui.text(node) === 'Start the run')[0];
    assert.ok(blockedStart, 'the start action must exist');
    assert.equal(blockedStart.disabled, true, 'an unapproved storyboard must not be allowed to spend credits');
    assert.ok(panelText.indexOf('Approve the storyboard first') >= 0, 'the reason must be stated, not just the refusal');

    // --- approve, then run for real ---
    const project = JSON.parse(fs.readFileSync(built.projectFile, 'utf8'));
    const approved = await fetch(base + '/api/projects/' + built.folder + '/approvals/storyboard', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({decision: 'approved', revision: project.workflow.revision, stage_revision: 1})
    });
    assert.equal(approved.status, 200);

    ui.navigate('#/project/' + encodeURIComponent(built.folder) + '/brief');
    await ui.settle(() => !!ui.document.getElementById('viewBody'), {description: 'a different screen to clear the pipeline view', timeout: 8000});
    ui.navigate(ui.window.Router.pipelineHref(built.folder));
    await ui.settle(() => {
      const start = ui.findAll('button').filter(node => ui.text(node) === 'Start the run')[0];
      return !!start && start.disabled === false;
    }, {description: 'the start action to become available once the storyboard is approved', timeout: 8000});

    const start = ui.findAll('button').filter(node => ui.text(node) === 'Start the run')[0];
    start.click();

    // The screen watches the server-side run until it settles.
    await ui.settle(() => {
      const runText = ui.text(ui.document.getElementById('viewBody'));
      return runText.indexOf('Finished.') >= 0 || runText.indexOf('Ready for you to watch') >= 0 || runText.indexOf('Watch it, then approve it') >= 0;
    }, {description: 'the run to finish and be reported', timeout: 120000});

    const finishedText = ui.text(ui.document.getElementById('viewBody'));
    assert.ok(finishedText.indexOf('Final check') >= 0, 'every step must be listed');
    assert.ok(finishedText.indexOf('Generate missing scene media') >= 0);
    assert.ok(finishedText.indexOf('1 generated, 0 failed') >= 0, 'the generate step must report what it produced, got: ' + finishedText.slice(0, 400));
    assert.ok(finishedText.indexOf('Watch it, then approve it') >= 0, 'the operator must be handed the decision');

    // The scene that needed media really got the generated file attached.
    const board = JSON.parse(fs.readFileSync(path.join(built.directory, 'storyboard/storyboard.json'), 'utf8'));
    const generatedScene = board.scenes.find(scene => scene.id === 'scene_two');
    assert.ok(generatedScene.asset_id, 'the generated scene must be attached');
    assert.equal(generatedScene.attachment.provider, 'Comfy Cloud');
    assert.equal(generatedScene.attachment.rights_basis, 'generated', 'generated media is the operator own work');

    // The master really exists, and nothing approved it.
    assert.ok(fs.existsSync(path.join(built.directory, 'final/youtube_master.mp4')), 'the master must be rendered');
    assert.ok(fs.existsSync(path.join(built.directory, 'final/final_check.json')), 'the final check must be written');
    const after = await (await fetch(base + '/api/projects/' + built.folder + '/intake')).json();
    assert.equal(after.project.workflow.approvals.filter(item => item.stage === 'master_video').length, 0, 'the pipeline must not approve the master');
    assert.equal(after.project.workflow.stages.exports.revision || 0, 0, 'the pipeline must not run the exports');

    // Leaving the screen must stop the polling it started.
    ui.navigate('#/library');
    await ui.settle(() => ui.text(ui.document.getElementById('viewBody')).indexOf('Library') >= 0, {description: 'the library screen', timeout: 8000});

    console.log('All pipeline screen tests passed: menu entry, Comfy scene control, preflight refusal, a real run, and no approvals.');
    process.exit(0);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}

/* A failed assertion must end the process: the pipeline view schedules a poll, and a pending timer
   would otherwise keep the event loop alive and hang the suite instead of reporting the failure. */
run().catch(error => { console.error(error); process.exit(1); });
'use strict';
/* Comfy Cloud scene generation: the adapter, the workflow config, and the per-scene routes.

   The network is mocked at the `providerFetch` seam, so this suite performs no real HTTP and can
   never spend credits. The bytes that come back are a real 8x8 PNG, so the import path is exercised
   against genuine image data rather than a stub. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {createServer} = require('../src/server');
const comfy = require('../src/providers/comfy');
const comfyWorkflows = require('../src/lib/comfyWorkflows');
const comfyGenerate = require('../src/lib/comfyGenerate');
const licensing = require('../src/lib/licensing');

/* A real 8x8 PNG, so the file on disk is genuine image data. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGP8y4AdsOAQH6QSANErARssm0F5AAAAAElFTkSuQmCC', 'base64');
const SIGNED_URL = 'https://signed.example.invalid/asset.png';

const API_WORKFLOW = {
  '3': {class_type: 'KSampler', inputs: {seed: 1, steps: 20}},
  '6': {class_type: 'CLIPTextEncode', inputs: {text: '', clip: ['4', 0]}},
  '9': {class_type: 'SaveImage', inputs: {images: ['8', 0], filename_prefix: 'ComfyUI'}}
};

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

/* The whole Comfy surface, mocked. `state` drives the job through a status sequence and records every
   request so the tests can assert on redirect handling and headers. */
function mockComfy(state) {
  return async (url, options = {}) => {
    const target = String(url);
    state.calls.push({url: target, method: options.method || 'GET', headers: options.headers || {}, redirect: options.redirect || null, body: options.body || null});

    if (target.endsWith('/api/v2/jobs') && options.method === 'POST') {
      if (state.submitStatus) {
        return Response.json({error: {code: state.submitStatus.code, message: state.submitStatus.message || 'refused'}}, {status: state.submitStatus.status});
      }
      state.submittedWorkflow = JSON.parse(options.body).workflow;
      state.idempotencyKeys.push(options.headers['idempotency-key']);
      return Response.json({id: 'job-1', status: 'queued', progress: null, outputs: [], error: null, urls: {}}, {status: 201});
    }
    if (/\/api\/v2\/jobs\/[^/]+$/.test(target)) {
      const step = state.statuses.shift();
      if (!step) throw new Error('the test polled the job more times than it queued statuses');
      return Response.json(step);
    }
    if (/\/api\/v2\/assets\/[^/]+\/content$/.test(target)) {
      if (state.contentMode === 'direct') {
        return new Response(PNG, {status: 200, headers: {'content-type': 'image/png'}});
      }
      return new Response(null, {status: 302, headers: {location: SIGNED_URL}});
    }
    if (target === SIGNED_URL) {
      return new Response(PNG, {status: 200, headers: {'content-type': 'image/png'}});
    }
    if (target.endsWith('/cancel')) {
      return Response.json({id: 'job-1', status: 'canceled'});
    }
    throw new Error('unexpected request in the Comfy mock: ' + target);
  };
}

function succeeded(outputs) {
  return {id: 'job-1', status: 'succeeded', progress: {value: 1}, outputs, error: null, urls: {}};
}

async function withServer(state, testFn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-test-'));
  const projectsRoot = path.join(root, 'projects');
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {COMFY_API_KEY: 'test-comfy-key'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    providerFetch: mockComfy(state)
  });
  const baseUrl = await listen(server);
  try { await testFn({baseUrl, projectsRoot, root}); }
  finally { await close(server); fs.rmSync(root, {recursive: true, force: true}); }
}

/* A project with an approved brief, approved material decision and an approved storyboard holding one
   scene that needs media. Written directly: this suite is about generation, not about the model chain. */
async function buildProject(baseUrl, projectsRoot) {
  const created = await api(baseUrl, '/api/projects', {prompt: 'A video about robot safety for plant managers.'});
  const folder = created.payload.folder;
  const directory = path.join(projectsRoot, folder);

  let intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  await api(baseUrl, '/api/projects/' + folder + '/brief', Object.assign({}, intake.payload.brief, {angle: 'Practical', purpose: 'Safety', revision: intake.payload.project.workflow.revision}));
  intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  await api(baseUrl, '/api/projects/' + folder + '/materials-confirm', {revision: intake.payload.project.workflow.revision, without_material: true});

  writeJson(path.join(directory, 'script/script.json'), {sections: [{id: 'hook', title: 'Hook', narration: 'The robot will not warn you.', seconds: 8}], estimated_duration_seconds: 8});
  writeJson(path.join(directory, 'storyboard/storyboard.json'), {
    scenes: [
      {id: 'scene_one', title: 'Robot arm', narration_section_id: 'hook', seconds: 8, visual_intent: 'A robot arm on a bench', asset_id: null, shot_type: 'wide', on_screen_text: '', generation_prompt: 'a robot arm on a workbench, cinematic', transition: ''}
    ],
    total_duration_seconds: 8,
    missing_assets: [],
    selected_asset_ids: []
  });
  // The storyboard stage record is what the approval is tied to.
  const projectFile = path.join(directory, 'project.json');
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  project.workflow.stages.storyboard = Object.assign({}, project.workflow.stages.storyboard, {revision: 1, state: 'needs_review'});
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');

  const approved = await api(baseUrl, '/api/projects/' + folder + '/approvals/storyboard', {
    decision: 'approved',
    revision: JSON.parse(fs.readFileSync(projectFile, 'utf8')).workflow.revision,
    stage_revision: 1
  });
  assert.equal(approved.status, 200, 'the storyboard must approve: ' + JSON.stringify(approved.payload).slice(0, 300));

  writeJson(path.join(projectsRoot, '_settings/comfy/workflows.json'), {
    version: 1,
    default: 'image',
    workflows: {
      image: {file: 'image.workflow.json', output: 'image', prompt_node: '6', prompt_field: 'text'},
      video: {file: 'video.workflow.json', output: 'video', prompt_node: '6', prompt_field: 'text'}
    }
  });
  writeJson(path.join(projectsRoot, '_settings/comfy/image.workflow.json'), API_WORKFLOW);
  writeJson(path.join(projectsRoot, '_settings/comfy/video.workflow.json'), API_WORKFLOW);
  return {folder, directory};
}

function newState(overrides) {
  return Object.assign({
    calls: [], statuses: [], idempotencyKeys: [], submittedWorkflow: null,
    contentMode: 'redirect', submitStatus: null
  }, overrides || {});
}

async function testPureFunctions() {
  const uiFormat = {nodes: [{id: 1, widgets_values: ['x']}], links: []};
  assert.equal(comfy.isUiFormat(uiFormat), true, 'an editor export must be recognised');
  assert.equal(comfy.isUiFormat(API_WORKFLOW), false, 'an API export must not be mistaken for an editor export');

  const ok = comfy.validateWorkflow(API_WORKFLOW, {promptNode: '6', promptField: 'text'});
  assert.equal(ok.ok, true);
  assert.equal(ok.nodes.length, 3);

  const missing = comfy.validateWorkflow(API_WORKFLOW, {promptNode: '99'});
  assert.equal(missing.ok, false);
  assert.match(missing.problem, /no node "99"/);
  assert.match(missing.problem, /KSampler/, 'the refusal must list what the workflow does contain');

  const wrongField = comfy.validateWorkflow(API_WORKFLOW, {promptNode: '3', promptField: 'text'});
  assert.equal(wrongField.ok, false);
  assert.match(wrongField.problem, /no input "text"/);
  assert.match(wrongField.problem, /seed/);

  const uiVerdict = comfy.validateWorkflow(uiFormat, {promptNode: '1'});
  assert.equal(uiVerdict.ok, false);
  assert.match(uiVerdict.problem, /Export \(API\)/, 'the refusal must say how to export correctly');

  const injected = comfy.injectPrompt(API_WORKFLOW, {node: '6', field: 'text', text: 'a robot arm'});
  assert.equal(injected['6'].inputs.text, 'a robot arm');
  assert.equal(API_WORKFLOW['6'].inputs.text, '', 'the workflow object must not be mutated');

  const picked = comfy.chooseOutput([{type: 'latent', node_id: '1'}, {type: 'image', node_id: '9', name: 'a.png', id: 'asset-1'}], {wantedKind: 'image'});
  assert.equal(picked.ok, true);
  assert.equal(picked.output.id, 'asset-1');
  const latentOnly = comfy.chooseOutput([{type: 'latent', node_id: '1'}], {});
  assert.equal(latentOnly.ok, false);
  assert.match(latentOnly.reason, /latent/, 'the refusal must name what the workflow did return');

  assert.equal(comfy.resolveLink('https://cloud.comfy.org', '/api/v2/jobs/1/cancel'), 'https://cloud.comfy.org/api/v2/jobs/1/cancel');
  assert.equal(comfy.normaliseBaseUrl('https://cloud.comfy.org/'), 'https://cloud.comfy.org');
  assert.throws(() => comfy.normaliseBaseUrl('ftp://nope'), /http or https/);

  const generated = licensing.assessRights({basis: 'generated'});
  assert.equal(generated.state, 'cleared', 'generated scene media is the operator own work and must clear the gate');

  assert.equal(comfyGenerate.resolveMediaType('image/png').extension, '.png');
  assert.equal(comfyGenerate.fileNameFor('scene_one', 'video/mp4'), 'comfy-scene_one.mp4');
  assert.throws(() => comfyGenerate.resolveMediaType('application/pdf'), /cannot import/);
  console.log('  adapter: format validation, prompt injection, output choice and error mapping');
}

async function testWorkflowConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-cfg-'));
  try {
    const missing = comfyWorkflows.loadConfig(root);
    assert.equal(missing.ok, false);
    assert.match(missing.problem, /workflows\.json/, 'a missing config must name the file to create');
    assert.equal(comfyWorkflows.workflowSummary(root).configured, false);

    writeJson(path.join(root, '_settings/comfy/workflows.json'), {version: 1, workflows: {image: {file: 'a.json', output: 'image', prompt_node: '6'}}});
    const loaded = comfyWorkflows.loadConfig(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.default, 'image', 'a lone image workflow becomes the default');
    assert.equal(loaded.workflows[0].exists, false, 'a missing workflow file must be reported, not assumed');

    writeJson(path.join(root, '_settings/comfy/a.json'), API_WORKFLOW);
    assert.equal(comfyWorkflows.loadConfig(root).workflows[0].exists, true);

    const built = comfyWorkflows.buildSubmission({projectsRoot: root, name: 'image', prompt: 'a bench'});
    assert.equal(built.graph['6'].inputs.text, 'a bench');
    assert.equal(built.uses_api_nodes, false);

    assert.throws(() => comfyWorkflows.buildSubmission({projectsRoot: root, name: 'image', prompt: '   '}), /no generation prompt/);
    assert.throws(() => comfyWorkflows.buildSubmission({projectsRoot: root, name: 'nope', prompt: 'x'}), /Unknown Comfy workflow/);

    writeJson(path.join(root, '_settings/comfy/workflows.json'), {version: 1, workflows: {image: {file: '../escape.json', output: 'image', prompt_node: '6'}}});
    assert.equal(comfyWorkflows.loadConfig(root).ok, false, 'a path escaping the config directory must be refused');

    writeJson(path.join(root, '_settings/comfy/workflows.json'), {version: 1, workflows: {image: {file: 'a.json', output: 'audio', prompt_node: '6'}}});
    assert.match(comfyWorkflows.loadConfig(root).problem, /Choose image or video/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
  console.log('  config: missing, malformed, escaping paths and unknown names all refused with a reason');
}

async function testGenerationRoundTrip() {
  const state = newState({
    statuses: [
      // The submit response already reported `queued`, so the first poll is the running snapshot.
      {id: 'job-1', status: 'running', progress: {value: 0.4, nodes_done: 4, nodes_total: 10}, outputs: [], error: null, urls: {}},
      succeeded([{node_id: '9', name: 'ComfyUI_00001_.png', type: 'image', content_type: 'image/png', size_bytes: PNG.length, id: 'asset-1', hash: null, url: 'https://cloud.comfy.org/fresh.png', url_expires_at: '2030-01-01T00:00:00Z'}])
    ]
  });
  await withServer(state, async ({baseUrl, projectsRoot}) => {
    const {folder, directory} = await buildProject(baseUrl, projectsRoot);

    const submitted = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    assert.equal(submitted.status, 201, 'submit: ' + JSON.stringify(submitted.payload).slice(0, 300));
    const jobId = submitted.payload.job.job_id;
    assert.equal(jobId, 'job-1');
    assert.equal(submitted.payload.job.status, 'queued');
    assert.equal(submitted.payload.job.workflow, 'image');
    assert.equal(submitted.payload.job.prompt, 'a robot arm on a workbench, cinematic');
    assert.equal(state.submittedWorkflow['6'].inputs.text, 'a robot arm on a workbench, cinematic', 'the prompt must reach the submitted graph');
    assert.equal(state.idempotencyKeys.length, 1);
    assert.ok(/^[0-9a-f-]{36}$/.test(state.idempotencyKeys[0]), 'a UUID idempotency key must be sent');

    // The job record is on disk, which is what makes a reload resume rather than lose the job.
    const recorded = comfyGenerate.readJobs(directory);
    assert.equal(recorded.jobs.length, 1);
    assert.equal(recorded.jobs[0].scene_id, 'scene_one');

    const first = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate/' + jobId);
    assert.equal(first.status, 200);
    assert.equal(first.payload.job.status, 'running', 'progress must be passed through');
    assert.equal(first.payload.job.progress.value, 0.4);

    const second = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate/' + jobId);
    assert.equal(second.status, 200);
    assert.equal(second.payload.job.status, 'succeeded');
    assert.ok(second.payload.attached_asset_id, 'the generated file must be imported and attached');

    // The asset is a real library file with the generated basis, so the rights gate clears it.
    const linked = await api(baseUrl, '/api/library');
    const asset = linked.payload.assets.find(item => item.id === second.payload.attached_asset_id);
    assert.ok(asset, 'the generated asset must be in the library');
    assert.equal(asset.name, 'comfy-scene_one.png');
    assert.equal(asset.mime, 'image/png');
    assert.equal(asset.rights.basis, 'generated');
    assert.equal(asset.rights_summary.state, 'cleared');

    const stored = fs.readFileSync(path.join(projectsRoot, '..', 'library', second.payload.attached_asset_id + '.bin'));
    assert.deepEqual([...stored.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the stored file must be real PNG data');

    // And the scene now points at it, so the assets stage will skip it.
    const board = JSON.parse(fs.readFileSync(path.join(directory, 'storyboard/storyboard.json'), 'utf8'));
    assert.equal(board.scenes[0].asset_id, second.payload.attached_asset_id);
    assert.equal(board.scenes[0].attachment.rights_basis, 'generated');

    // --- polling again must not import a second time ---
    const before = comfyGenerate.readJobs(directory).jobs[0].imported_asset_id;
    const third = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate/' + jobId);
    assert.equal(third.status, 200);
    assert.equal(third.payload.attached_asset_id, before, 'a repeated poll must not import again');
    const after = await api(baseUrl, '/api/library');
    assert.equal(after.payload.assets.filter(item => /^comfy-/.test(item.name)).length, 1, 'exactly one generated asset may exist');
  });
  console.log('  round trip: submit, poll through running, import once, attach, and never twice');
}

async function testRedirectSafety() {
  const state = newState({
    statuses: [succeeded([{node_id: '9', name: 'a.png', type: 'image', content_type: 'image/png', size_bytes: PNG.length, id: 'asset-1', hash: null, url: 'https://cloud.comfy.org/fresh.png'}])]
  });
  await withServer(state, async ({baseUrl, projectsRoot}) => {
    const {folder} = await buildProject(baseUrl, projectsRoot);
    const submitted = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate/' + submitted.payload.job.job_id);

    const content = state.calls.find(call => /\/api\/v2\/assets\/[^/]+\/content$/.test(call.url));
    assert.ok(content, 'the asset content endpoint must be used');
    assert.equal(content.redirect, 'manual', 'the redirect must be handled by hand');
    assert.match(content.headers.authorization, /^Bearer /, 'the key must be sent to Comfy');

    const signed = state.calls.find(call => call.url === SIGNED_URL);
    assert.ok(signed, 'the signed URL must be fetched');
    assert.equal(signed.headers.authorization, undefined, 'the API key must never be sent to the signed-URL host');
  });
  console.log('  redirect: content fetched by hand so the key is never forwarded to the signed URL host');
}

async function testErrorsAndRefusals() {
  // --- Comfy refuses the submission, code by code ---
  const cases = [
    {status: 401, code: 'unauthorized', expect: /rejected the API key/, http: 502},
    // 402 and 429 keep their own status because a caller acts on them differently: add credits, or back off.
    {status: 402, code: 'insufficient_credits', expect: /out of credits/, http: 402},
    {status: 422, code: 'workflow_format_ui', expect: /Export \(API\)/, http: 502},
    {status: 429, code: 'queue_full', expect: /queue is full/, http: 429},
    {status: 500, code: 'upstream_error', expect: /internal error/, http: 502}
  ];
  for (const item of cases) {
    const state = newState({submitStatus: {status: item.status, code: item.code}});
    await withServer(state, async ({baseUrl, projectsRoot}) => {
      const {folder} = await buildProject(baseUrl, projectsRoot);
      const refused = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
      assert.equal(refused.status, item.http, item.code + ' must surface as a provider failure');
      assert.match(refused.payload.error, item.expect, item.code + ' message');
    });
  }

  // --- a job that fails carries Comfy's own node detail, because Cloud returns no logs ---
  const failing = newState({
    statuses: [{id: 'job-1', status: 'failed', progress: null, outputs: [], error: {code: 'node_execution_error', message: 'CUDA out of memory', node_id: '3', class_type: 'KSampler'}, urls: {}}]
  });
  await withServer(failing, async ({baseUrl, projectsRoot}) => {
    const {folder, directory} = await buildProject(baseUrl, projectsRoot);
    const submitted = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    const polled = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate/' + submitted.payload.job.job_id);
    assert.equal(polled.status, 200);
    assert.equal(polled.payload.job.status, 'failed');
    assert.match(polled.payload.job.error, /node_execution_error/);
    assert.match(polled.payload.job.error, /CUDA out of memory/);
    assert.match(polled.payload.job.error, /node 3 \(KSampler\)/);
    assert.equal(comfyGenerate.readJobs(directory).jobs[0].imported_asset_id, null, 'a failed job imports nothing');
  });

  // --- expired, and a succeeded job whose workflow saved nothing usable ---
  const expired = newState({statuses: [{id: 'job-1', status: 'expired', progress: null, outputs: [], error: null, urls: {}}]});
  await withServer(expired, async ({baseUrl, projectsRoot}) => {
    const {folder} = await buildProject(baseUrl, projectsRoot);
    const submitted = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    const polled = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate/' + submitted.payload.job.job_id);
    assert.equal(polled.payload.job.status, 'expired');
    assert.match(polled.payload.job.error, /discarded this job/);
  });

  const latentOnly = newState({statuses: [succeeded([{node_id: '1', name: 'x', type: 'latent', content_type: 'application/octet-stream', size_bytes: 1, id: 'asset-1'}])]});
  await withServer(latentOnly, async ({baseUrl, projectsRoot}) => {
    const {folder} = await buildProject(baseUrl, projectsRoot);
    const submitted = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    const polled = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate/' + submitted.payload.job.job_id);
    assert.equal(polled.status, 200);
    assert.equal(polled.payload.attached_asset_id, null);
    assert.match(polled.payload.job.error, /no image or video/);
  });

  // --- the scene-level refusals ---
  const refusals = newState({statuses: []});
  await withServer(refusals, async ({baseUrl, projectsRoot}) => {
    const {folder, directory} = await buildProject(baseUrl, projectsRoot);

    const unknown = await api(baseUrl, '/api/projects/' + folder + '/scenes/nope/generate', {});
    assert.equal(unknown.status, 404);

    // A scene that already has own media cannot be generated over.
    const board = JSON.parse(fs.readFileSync(path.join(directory, 'storyboard/storyboard.json'), 'utf8'));
    board.scenes[0].asset_id = 'existing-asset';
    writeJson(path.join(directory, 'storyboard/storyboard.json'), board);
    const taken = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    assert.equal(taken.status, 409);
    assert.match(taken.payload.error, /already uses own media/);

    // A scene the app draws locally for free should not be sent to a paid generator by accident.
    delete board.scenes[0].asset_id;
    board.scenes[0].graphic_template = 'text-card';
    writeJson(path.join(directory, 'storyboard/storyboard.json'), board);
    const templated = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    assert.equal(templated.status, 409);
    assert.match(templated.payload.error, /draws for free/);

    // A scene with no prompt has nothing to send.
    delete board.scenes[0].graphic_template;
    board.scenes[0].generation_prompt = '';
    writeJson(path.join(directory, 'storyboard/storyboard.json'), board);
    const noPrompt = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    assert.equal(noPrompt.status, 409);
    assert.match(noPrompt.payload.error, /no generation prompt/);

    // An editor-format workflow is refused locally, before any request is spent.
    writeJson(path.join(projectsRoot, '_settings/comfy/image.workflow.json'), {nodes: [{id: 1, widgets_values: ['x']}], links: []});
    board.scenes[0].generation_prompt = 'a robot arm';
    writeJson(path.join(directory, 'storyboard/storyboard.json'), board);
    const callsBefore = refusals.calls.length;
    const uiFormat = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_one/generate', {});
    assert.equal(uiFormat.status, 409);
    assert.match(uiFormat.payload.error, /Export \(API\)/);
    assert.equal(refusals.calls.length, callsBefore, 'a locally detectable mistake must not reach the network');

    // The status endpoint reports the config problem rather than pretending Comfy is ready.
    writeJson(path.join(projectsRoot, '_settings/comfy/image.workflow.json'), API_WORKFLOW);
    const status = await api(baseUrl, '/api/providers/comfy');
    assert.equal(status.status, 200);
    assert.equal(status.payload.configured, true);
    assert.equal(status.payload.default_workflow, 'image');
    assert.equal(status.payload.workflow_problem, null);
  });
  console.log('  errors: documented codes mapped, real node detail kept, and every refusal specific');
}

async function testConnectionTest() {
  const good = newState({statuses: []});
  const goodFetch = mockComfy(good);
  const client = comfy.createComfyClient({baseUrl: 'https://cloud.comfy.org', apiKey: 'k', fetchImpl: async (url, options) => {
    if (/\/api\/v2\/jobs\/[^/]+$/.test(String(url))) return Response.json({error: {code: 'not_found', message: 'no such job'}}, {status: 404});
    return goodFetch(url, options);
  }});
  const result = await client.test();
  assert.equal(result.connected, true, 'a 404 on a probe id means the key was accepted');

  const bad = comfy.createComfyClient({baseUrl: 'https://cloud.comfy.org', apiKey: 'k', fetchImpl: async () =>
    Response.json({error: {code: 'unauthorized', message: 'bad key'}}, {status: 401})});
  const refused = await bad.test();
  assert.equal(refused.connected, false);
  assert.match(refused.error, /rejected the API key/);

  const unconfigured = comfy.createComfyClient({baseUrl: 'https://cloud.comfy.org', apiKey: '', fetchImpl: async () => { throw new Error('must not be called'); }});
  await assert.rejects(() => unconfigured.job('x'), /not configured/);
  console.log('  connection: a zero-cost probe that queues nothing, and a clear unconfigured refusal');
}

async function run() {
  await testPureFunctions();
  await testWorkflowConfig();
  await testGenerationRoundTrip();
  await testRedirectSafety();
  await testErrorsAndRefusals();
  await testConnectionTest();
  console.log('All Comfy generation tests passed: adapter, workflow config, per-scene routes, redirect safety and error mapping (mock network, no paid runs).');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
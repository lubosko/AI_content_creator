'use strict';
/* Per-scene Comfy generation, and the job records that make it resumable.

   A GPU job takes minutes, so nothing here blocks a request: submitting records a job and returns,
   and the interface polls. The record lives at generated/comfy_jobs.json, which is why reloading the
   page - or reopening the project tomorrow - still finds the job instead of losing it. */

const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const comfy = require('../providers/comfy');
const comfyWorkflows = require('./comfyWorkflows');
const sceneAssets = require('./sceneAssets');

const JOBS_FILE = 'generated/comfy_jobs.json';
const TERMINAL = comfy.TERMINAL;

/* Comfy states the output kind; the app needs a file extension it recognises. Anything not listed
   here is refused rather than guessed, so an unusual type cannot be filed as something it is not. */
const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov'
};

function fail(message, status = 409) { throw Object.assign(new Error(message), {status}); }

function jobsPath(directory) { return path.join(directory, JOBS_FILE); }

function readJobs(directory) {
  const file = jobsPath(directory);
  if (!fs.existsSync(file)) return {jobs: []};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {jobs: Array.isArray(parsed && parsed.jobs) ? parsed.jobs : []};
  } catch (error) {
    // A corrupted record must not make the project unopenable; it is reported and replaced.
    return {jobs: [], problem: 'The Comfy job record could not be read and was ignored: ' + error.message};
  }
}

function writeJobs(directory, data) {
  const file = jobsPath(directory);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({jobs: data.jobs}, null, 2) + '\n');
  fs.renameSync(temp, file);
}

function updateJob(directory, jobId, changes) {
  const data = readJobs(directory);
  const index = data.jobs.findIndex(item => item.job_id === jobId);
  if (index < 0) fail('That generation job is not recorded on this project. Submit it again.', 404);
  data.jobs[index] = Object.assign({}, data.jobs[index], changes);
  writeJobs(directory, data);
  return data.jobs[index];
}

function findJob(directory, jobId) {
  return readJobs(directory).jobs.find(item => item.job_id === jobId) || null;
}

function jobsForScene(directory, sceneId) {
  return readJobs(directory).jobs.filter(item => item.scene_id === sceneId);
}

/* The most recent still-open job for a scene, so a reload can offer to keep watching it. */
function activeJobForScene(directory, sceneId) {
  const open = jobsForScene(directory, sceneId).filter(item => !TERMINAL.includes(item.status));
  return open.length ? open[open.length - 1] : null;
}

function promptFingerprint(prompt) {
  return createHash('sha256').update(String(prompt || '')).digest('hex').slice(0, 12);
}

/* Resolves the media type once, so the extension and the MIME type the library is told can never
   disagree. Anything unrecognised is refused rather than guessed. */
function resolveMediaType(contentType) {
  const key = String(contentType || '').toLowerCase().split(';')[0].trim();
  const extension = EXTENSIONS[key];
  if (!extension) {
    fail('Comfy returned "' + (contentType || 'no content type') + '", which this app cannot import as video or image.', 415);
  }
  // The library's own table is the authority on the accepted MIME string for that extension.
  const canonical = {'.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'}[extension];
  return {extension, mime: canonical};
}

function fileNameFor(sceneId, contentType) {
  const resolved = resolveMediaType(contentType);
  const safe = String(sceneId).replace(/[^a-z0-9_-]+/gi, '_');
  return 'comfy-' + safe + resolved.extension;
}

/* Submits one scene. `idempotencyKey` is minted here and only ever used for this submission. */
async function submitGeneration({ctx, client, projectsRoot, sceneId, workflowName, prompt}) {
  const board = readBoard(ctx.directory);
  const scene = board.scenes.find(item => item.id === sceneId);
  if (!scene) fail('Unknown scene "' + sceneId + '". Reload the storyboard and try again.', 404);
  if (scene.asset_id) {
    fail('This scene already uses own media. Detach it first if you want to generate a replacement.', 409);
  }
  if (scene.graphic_template) {
    fail('This scene is assigned the ' + scene.graphic_template + ' template, which the app draws for free. Clear that first if you want to generate instead.', 409);
  }
  /* A scene whose picture is mostly on-screen words goes to the workflow the operator marked for
     text, when one is configured. Spelling is the one thing a prompt cannot fix after the fact, and
     the model that draws a chart beautifully is usually not the one that spells a product name
     correctly. */
  const routedForText = !workflowName && sceneAssets.isTypographic(scene)
    ? comfyWorkflows.textWorkflowName(projectsRoot)
    : null;
  const built = comfyWorkflows.buildSubmission({
    projectsRoot,
    name: workflowName || routedForText || undefined,
    prompt: prompt === undefined || prompt === null || String(prompt).trim() === '' ? scene.generation_prompt : prompt
  });
  const record = await submit({ctx, client, built, scene, purpose: 'scene', routedForText: !!routedForText});
  return record;
}

/* Shared tail of every submission: forward the key if the workflow declares API nodes, submit once
   with a single-use idempotency key, and record the job so a reload still finds it. */
async function submit({ctx, client, built, scene, purpose, routedForText}) {
  // Partner/API nodes are a declared property of the workflow, not something guessed from node class
  // names: the app cannot reliably tell an API node from a custom one, and guessing would either
  // withhold a key the workflow needs or send one it does not.
  const extraData = built.uses_api_nodes ? {api_key_comfy_org: client.apiKeyValue ? client.apiKeyValue() : undefined} : undefined;
  if (built.uses_api_nodes && (!extraData || !extraData.api_key_comfy_org)) {
    fail('Workflow "' + built.name + '" declares uses_api_nodes, but no Comfy API key is available to forward for those nodes.', 409);
  }

  const submitted = await client.submit({
    workflow: built.graph,
    extraData,
    idempotencyKey: randomUUID()
  });

  const record = {
    job_id: String(submitted.id),
    scene_id: scene.id,
    scene_title: scene.title || null,
    workflow: built.name,
    purpose: purpose || 'scene',
    routed_for_text: !!routedForText,
    output_kind: built.entry.output,
    prompt: built.prompt,
    prompt_fingerprint: promptFingerprint(built.prompt),
    submitted_at: new Date().toISOString(),
    status: submitted.status || 'queued',
    progress: submitted.progress || null,
    imported_asset_id: null,
    error: null
  };
  const data = readJobs(ctx.directory);
  data.jobs.push(record);
  writeJobs(ctx.directory, data);
  return record;
}

/* ---------- the text probe ---------- */

/* Whether a workflow can spell is not something anyone can read off a specification, and this app
   cannot look at a picture and check. So the operator is given one cheap way to find out with the
   workflow they actually configured: generate a single image whose subject is the scene's own
   on-screen words, then say whether the words came out right. The answer is remembered. */
const PROBES_FILE = 'generated/text_probes.json';

/* The words a probe tests. Only text the scene actually puts on screen: a scene title is not drawn
   into the picture, so testing it would answer a question about words that never appear. */
function probeWords(scene) {
  return String((scene && scene.on_screen_text) || '').trim();
}

function probePrompt(scene) {
  const words = probeWords(scene);
  return 'A clean, evenly lit studio photograph of a large white card held flat and square to the '
    + 'camera. The card carries crisp black sans-serif lettering that reads exactly: "' + words + '". '
    + 'Every word is complete, correctly spelled, and entirely inside the frame. No other text anywhere '
    + 'in the image.';
}

function readProbes(directory) {
  const file = path.join(directory, PROBES_FILE);
  if (!fs.existsSync(file)) return {probes: []};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && Array.isArray(data.probes) ? data : {probes: []};
  } catch (error) { return {probes: []}; }
}

function writeProbes(directory, data) {
  const file = path.join(directory, PROBES_FILE);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* Submits a probe. It deliberately ignores what the scene is assigned: the subject is the workflow,
   and a probe changes nothing about the plan. */
async function submitTextProbe({ctx, client, projectsRoot, sceneId, workflowName}) {
  const board = readBoard(ctx.directory);
  const scene = board.scenes.find(item => item.id === sceneId);
  if (!scene) fail('Unknown scene "' + sceneId + '". Reload the storyboard and try again.', 404);
  const words = probeWords(scene);
  if (!words) fail('This scene has no on-screen text, so there are no words to test the workflow with.', 409);
  /* Tested against the workflow this scene would actually be drawn by, or the answer would be about
     a model the words would never reach. */
  const routedForText = !workflowName && sceneAssets.isTypographic(scene)
    ? comfyWorkflows.textWorkflowName(projectsRoot)
    : null;
  const built = comfyWorkflows.buildSubmission({
    projectsRoot,
    name: workflowName || routedForText || undefined,
    prompt: probePrompt(scene)
  });
  const record = await submit({ctx, client, built, scene, purpose: 'probe', routedForText: !!routedForText});
  const data = readProbes(ctx.directory);
  data.probes.push({
    probe_id: record.job_id,
    scene_id: scene.id,
    workflow: built.name,
    words,
    job_id: record.job_id,
    asset_id: null,
    verdict: null,
    judged_at: null,
    tested_at: record.submitted_at
  });
  writeProbes(ctx.directory, data);
  return record;
}

/* The operator's answer about one probe. Recorded against the workflow, because that is what the
   answer is about: the next scene on this workflow inherits the finding, not just this one. */
function recordProbeVerdict(directory, probeId, correct, note) {
  const data = readProbes(directory);
  const probe = data.probes.find(item => item.probe_id === probeId);
  if (!probe) fail('That text probe is not recorded on this project.', 404);
  probe.verdict = correct ? 'correct' : 'incorrect';
  probe.note = note ? String(note).slice(0, 500) : null;
  probe.judged_at = new Date().toISOString();
  writeProbes(directory, data);
  return probe;
}

/* What is known about a workflow's spelling, from the probes run on this project. Null when nobody
   has ever tested it, which is different from a test that failed. */
function textProbeVerdict(directory, workflowName) {
  const judged = readProbes(directory).probes
    .filter(item => item.verdict && (!workflowName || item.workflow === workflowName))
    .sort((left, right) => String(right.judged_at).localeCompare(String(left.judged_at)));
  return judged.length ? judged[0] : null;
}

/* The most recent probe for a scene, whatever its verdict, so the screen can show the picture that
   was produced rather than only the conclusion drawn from it. */
function probeForScene(directory, sceneId) {
  const probes = readProbes(directory).probes.filter(item => item.scene_id === sceneId);
  return probes.length ? probes[probes.length - 1] : null;
}

function readBoard(directory) {
  const file = path.join(directory, 'storyboard/storyboard.json');
  if (!fs.existsSync(file)) fail('Generate the storyboard first, then fill its scenes.', 409);
  let board;
  try { board = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail('The storyboard file could not be read: ' + error.message, 409); }
  if (!board || !Array.isArray(board.scenes) || !board.scenes.length) fail('The storyboard has no scenes to fill.', 409);
  // The same rule every other reader applies, so generation sees the plan the drawing stage will use.
  return sceneAssets.normaliseBoard(board).board;
}

/* The same read for callers that report state rather than act on it: a missing storyboard is a fact
   to display, not an error to throw at someone who only asked what the pipeline would do. */
function readBoardOrNull(directory) {
  const file = path.join(directory, 'storyboard/storyboard.json');
  if (!fs.existsSync(file)) return null;
  try {
    const board = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!board || !Array.isArray(board.scenes)) return null;
    return sceneAssets.normaliseBoard(board).board;
  } catch (error) { return null; }
}

/* Polls once. On the first success it downloads, imports and attaches, and records the asset id so a
   repeated poll can never import twice. `attach` is injected so this module does not have to depend
   on the provider stages module. */
async function pollGeneration({directory, client, jobId, library, attach}) {
  const record = findJob(directory, jobId);
  if (!record) fail('That generation job is not recorded on this project. Submit it again.', 404);
  /* A probe is never attached to a scene, so `attached_asset_id` stays null for one. Reporting the
     probe's own asset id as an attachment would make the screen offer to detach media the scene
     never had. */
  const isProbe = record.purpose === 'probe';
  if (record.imported_asset_id) return {record, imported_asset_id: record.imported_asset_id, attached_asset_id: isProbe ? null : record.imported_asset_id, done: true};

  const snapshot = await client.job(jobId);
  const status = String((snapshot && snapshot.status) || 'unknown');
  const progress = (snapshot && snapshot.progress) || null;

  if (status === 'failed') {
    return {record: updateJob(directory, jobId, {status, progress, error: comfy.failedJobReason(snapshot)}), done: true};
  }
  if (status === 'expired') {
    return {record: updateJob(directory, jobId, {status, progress, error: 'Comfy discarded this job before it finished. Run it again.'}), done: true};
  }
  if (status !== 'succeeded') {
    return {record: updateJob(directory, jobId, {status, progress}), done: false};
  }

  const picked = comfy.chooseOutput(snapshot.outputs, {
    preferredNode: null,
    wantedKind: record.output_kind
  });
  if (!picked.ok) {
    return {record: updateJob(directory, jobId, {status, progress, error: picked.reason}), done: true};
  }
  const bytes = await client.outputBytes(picked.output);
  const resolved = resolveMediaType(picked.output.content_type);
  const safeScene = String(record.scene_id).replace(/[^a-z0-9_-]+/gi, '_');
  const safeWorkflow = String(record.workflow).replace(/[^a-z0-9_-]+/gi, '_');
  const asset = library.importBytes({
    name: (isProbe ? 'text-probe-' + safeWorkflow + '-' : 'comfy-') + safeScene + resolved.extension,
    category: 'media',
    mime: resolved.mime,
    bytes
  });
  library.setRights(asset.id, {
    basis: 'generated',
    holder: 'Comfy Cloud',
    note: (isProbe ? 'Text probe of workflow "' : 'Workflow "') + record.workflow + '", prompt ' + record.prompt_fingerprint + '.'
  });
  /* A probe is evidence about the workflow, not content for the plan. It is kept where it can be
     looked at, but it is never attached to the scene whose words it borrowed: testing a workflow must
     not quietly change what a scene is made of. */
  if (isProbe) {
    const probes = readProbes(directory);
    const entry = probes.probes.find(item => item.probe_id === record.job_id);
    if (entry) { entry.asset_id = asset.id; writeProbes(directory, probes); }
  } else {
    await attach(asset.id, 'Comfy Cloud workflow "' + record.workflow + '" (prompt ' + record.prompt_fingerprint + ')');
  }
  return {
    record: updateJob(directory, jobId, {
      status, progress, imported_asset_id: asset.id,
      output: {name: picked.output.name || null, content_type: picked.output.content_type || null, bytes: asset.size || bytes.length, node_id: picked.output.node_id || null},
      skipped_outputs: (picked.skipped || []).map(item => ({name: item.name || null, type: item.type || null})),
      error: null
    }),
    attached_asset_id: isProbe ? null : asset.id,
    imported_asset_id: asset.id,
    done: true
  };
}

async function cancelGeneration({directory, client, jobId}) {
  const record = findJob(directory, jobId);
  if (!record) fail('That generation job is not recorded on this project. Submit it again.', 404);
  if (TERMINAL.includes(record.status)) return record;
  const snapshot = await client.cancel(jobId);
  return updateJob(directory, jobId, {
    status: (snapshot && snapshot.status) || 'canceling',
    canceled_at: new Date().toISOString()
  });
}

/* A compact view for the scene row: what has been generated for this scene and what is still running. */
function sceneGenerationState(directory, sceneId) {
  const jobs = jobsForScene(directory, sceneId);
  const active = activeJobForScene(directory, sceneId);
  const succeeded = jobs.filter(item => item.status === 'succeeded' && item.imported_asset_id);
  const last = jobs.length ? jobs[jobs.length - 1] : null;
  return {
    attempts: jobs.length,
    active: active ? {job_id: active.job_id, status: active.status, progress: active.progress, workflow: active.workflow} : null,
    imported_asset_id: succeeded.length ? succeeded[succeeded.length - 1].imported_asset_id : null,
    last_error: last && last.error ? last.error : null
  };
}

module.exports = {
  JOBS_FILE, EXTENSIONS, jobsPath, readJobs, writeJobs, findJob, jobsForScene, activeJobForScene,
  promptFingerprint, resolveMediaType, fileNameFor, submitGeneration, pollGeneration, cancelGeneration,
  sceneGenerationState, readBoard, readBoardOrNull,
  submitTextProbe, probePrompt, probeWords, readProbes, recordProbeVerdict, textProbeVerdict, probeForScene,
  PROBES_FILE
};
'use strict';
/* Filling a scene: choosing a local template, drawing a preview, and attaching an externally
   generated file. The network is mocked; the renderer is injected, because the real one is covered
   against Chrome and FFmpeg in tests/render.test.js. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const {createServer} = require('../src/server');
const {detectMediaTools} = require('../src/config/capabilities');
const sceneAssets = require('../src/lib/sceneAssets');
const licensing = require('../src/lib/licensing');
const frameRenderer = require('../src/lib/frameRenderer');

const FFMPEG = detectMediaTools().find(tool => tool.name === 'ffmpeg');
assert.ok(FFMPEG && FFMPEG.available, 'ffmpeg is required to build the media fixture');

const renders = [];
function injectedRenderer() {
  return async ({template, outputPath, seconds, fps, scene}) => {
    renders.push({template, seconds, text: scene.text, data: scene.data});
    fs.mkdirSync(path.dirname(outputPath), {recursive: true});
    execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outputPath], {stdio: 'ignore'});
    const frameCount = Math.max(1, Math.round((fps || 24) * seconds));
    return {path: outputPath, template, width: 320, height: 180, fps: fps || 24, frameCount, durationSeconds: frameCount / (fps || 24), bytes: fs.statSync(outputPath).size, fit: {ok: true, fontSize: 20}};
  };
}

/* One mock for both the language model and the media sources: anything that is not the Anthropic API
   gets an empty but well-formed media answer, so the sourcing chain reports an honest miss. */
function mockFetch(state) {
  return async (url, options) => {
    if (!String(url).startsWith('https://api.anthropic.com')) {
      if (String(url).includes('advancedsearch')) return Response.json({response: {docs: []}});
      return Response.json({results: []});
    }
    const body = JSON.parse(options.body);
    const prompt = JSON.stringify(body.messages || '');
    let text;
    if (prompt.includes('Create the content strategy')) {
      text = JSON.stringify({story_promise: 'Understand robot safety', target_audience: 'Plant managers', angle: 'Safety first', structure: [{section: 'Hook', purpose: 'Open with the risk', seconds: 20}, {section: 'Body', purpose: 'Explain the rules', seconds: 160}], hooks: ['The robot will not warn you.'], retention_moments: ['the light curtain'], material_usage: [], short_form_opportunities: ['the light curtain'], risks: []});
    } else if (prompt.includes('Write the full narration script')) {
      text = JSON.stringify({sections: [
        {id: 'hook', title: 'Hook', narration: 'The robot will not warn you.', visual_notes: ['factory floor'], seconds: 20, source_refs: ['research'], short_form: true},
        {id: 'body', title: 'Body', narration: 'Check the light curtain before entry.', visual_notes: ['light curtain'], seconds: 30, source_refs: ['research'], short_form: false}
      ], estimated_duration_seconds: 50});
    } else if (prompt.includes('Plan the storyboard')) {
      text = JSON.stringify({scenes: [
        {id: 'scene_one', title: 'Own media', narration_section_id: 'hook', seconds: 10, visual_intent: 'Factory floor at dawn', asset_id: state.assetId, shot_type: 'wide', on_screen_text: '', generation_prompt: '', transition: ''},
        {id: 'scene_two', title: 'Benchmark', narration_section_id: 'body', seconds: 10, visual_intent: 'Two bars race upward', asset_id: null, shot_type: 'graphic', on_screen_text: 'ROS2=100 / Dora-rs=380', graphic_template: 'bar-chart', graphic_data: {bars: [{label: 'ROS2', value: 100}, {label: 'Dora-rs', value: 380}]}, generation_prompt: 'bar chart of the benchmark', transition: ''},
        {id: 'scene_three', title: 'Robot arm', narration_section_id: 'body', seconds: 10, visual_intent: 'A robot arm on a workbench', asset_id: null, shot_type: 'wide', on_screen_text: '', generation_prompt: 'robot arm in a factory', transition: ''}
      ], total_duration_seconds: 30});
    } else {
      text = '# Research\n\n## Summary\n\nRobot safety depends on procedures.\n\n## Key findings\n\n- The emergency stop is on the left post.\n\n## Claims to verify\n\n- Nothing unverified.';
    }
    return Response.json({id: 'msg_1', model: 'test-model', stop_reason: 'end_turn', content: [{type: 'text', text}], usage: {input_tokens: 5, output_tokens: 5}});
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

async function withServer(testFn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-assets-'));
  const projectsRoot = path.join(root, 'projects');
  const state = {assetId: null};
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    providerFetch: mockFetch(state),
    renderGraphic: injectedRenderer(),
    graphicFps: 4
  });
  const baseUrl = await listen(server);
  try { await testFn({baseUrl, projectsRoot, root, state}); }
  finally { await close(server); fs.rmSync(root, {recursive: true, force: true}); }
}

async function approve(baseUrl, folder, stage) {
  const intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  return api(baseUrl, '/api/projects/' + folder + '/approvals/' + stage, {
    decision: 'approved',
    revision: intake.payload.project.workflow.revision,
    stage_revision: intake.payload.project.workflow.stages[stage].revision
  });
}

/* Drives a project all the way to an approved storyboard, which is the state every test here needs. */
async function buildApprovedStoryboard(baseUrl, root, state) {
  const created = await api(baseUrl, '/api/projects', {prompt: 'A video about robot safety for plant managers.'});
  const folder = created.payload.folder;
  let intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  await api(baseUrl, '/api/projects/' + folder + '/brief', Object.assign({}, intake.payload.brief, {angle: 'Practical guidance', purpose: 'Reduce risk', revision: intake.payload.project.workflow.revision}));

  const mediaPath = path.join(root, 'clip.mp4');
  execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', mediaPath], {stdio: 'ignore'});
  const upload = await fetch(baseUrl + '/api/library/upload?name=clip.mp4&category=media', {
    method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: fs.readFileSync(mediaPath)
  });
  state.assetId = (await upload.json()).asset.id;
  await api(baseUrl, '/api/library/rights', {asset_ids: [state.assetId], basis: 'own'});

  intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  await api(baseUrl, '/api/projects/' + folder + '/materials', {revision: intake.payload.project.workflow.revision, asset_id: state.assetId, decision: 'use'});
  intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
  await api(baseUrl, '/api/projects/' + folder + '/materials-confirm', {revision: intake.payload.project.workflow.revision});

  await api(baseUrl, '/api/projects/' + folder + '/research', {provider: 'anthropic', web_search: false, include_materials: false});
  await approve(baseUrl, folder, 'research');
  await api(baseUrl, '/api/projects/' + folder + '/strategy', {provider: 'anthropic'});
  await approve(baseUrl, folder, 'strategy');
  await api(baseUrl, '/api/projects/' + folder + '/script', {provider: 'anthropic'});
  await approve(baseUrl, folder, 'script');
  const storyboard = await api(baseUrl, '/api/projects/' + folder + '/storyboard', {provider: 'anthropic'});
  assert.equal(storyboard.status, 200, 'the storyboard fixture must generate: ' + JSON.stringify(storyboard.payload).slice(0, 300));
  await approve(baseUrl, folder, 'storyboard');
  return folder;
}

async function testHeuristics() {
  assert.equal(sceneAssets.suggestTemplate({visual_intent: 'Two bars race upward'}), 'bar-chart');
  assert.equal(sceneAssets.suggestTemplate({generation_prompt: 'A terminal window showing pip install'}), 'terminal');
  assert.equal(sceneAssets.suggestTemplate({generation_prompt: 'Whiteboard diagram of nodes and arrows'}), 'diagram');
  assert.equal(sceneAssets.suggestTemplate({generation_prompt: 'Split-screen comparison of two robots'}), 'split-compare');
  assert.equal(sceneAssets.suggestTemplate({generation_prompt: 'Clean end-card animation with the logo'}), 'end-card');
  assert.equal(sceneAssets.suggestTemplate({generation_prompt: 'Large bold text fading in'}), 'text-card');
  // Regression: a scene whose on-screen text merely said "100%" was suggested as a chart, because the
  // rule treated any number followed by a percent sign as a benchmark.
  assert.equal(sceneAssets.suggestTemplate({on_screen_text: 'Dora is 100% compatible with LeRobot'}), 'text-card');
  assert.equal(sceneAssets.suggestTemplate({generation_prompt: 'sleek logo reveal with particle effects'}), 'text-card');

  assert.equal(sceneAssets.isTypographic({on_screen_text: 'Check weekly'}), true);
  assert.equal(sceneAssets.isTypographic({generation_prompt: 'word by word text animation'}), true);
  assert.equal(sceneAssets.isTypographic({generation_prompt: 'wide shot of an empty factory floor'}), false);
  assert.deepEqual(frameRenderer.TEMPLATES, sceneAssets.GRAPHIC_TEMPLATES, 'The renderer and the plan vocabulary must not drift apart');
  console.log('  heuristics: template choice, typographic flag, and the 100% regression');
}

async function testGraphicData() {
  assert.match(sceneAssets.validateGraphicData('bar-chart', {bars: [{label: 'A', value: 1}]}), /at least two/);
  assert.match(sceneAssets.validateGraphicData('bar-chart', {bars: [{label: 'A', value: 1}, {label: 'B', value: 'x'}]}), /numeric value/);
  assert.equal(sceneAssets.validateGraphicData('bar-chart', {bars: [{label: 'A', value: 1}, {label: 'B', value: 2}]}), null);
  assert.match(sceneAssets.validateGraphicData('diagram', {nodes: [{label: 'a', x: 1, y: 1}]}), /at least two/);
  assert.match(sceneAssets.validateGraphicData('split-compare', {left: {text: 'a'}, right: {text: ''}}), /data\.left\.text and data\.right\.text/);
  assert.match(sceneAssets.validateGraphicData('terminal', {lines: []}), /at least one line/);
  assert.equal(sceneAssets.validateGraphicData('text-card', {}), null, 'A text card needs nothing beyond its text');
  assert.equal(sceneAssets.validateGraphicData('end-card', {}), null);

  // Derivation must produce something usable, or nothing at all. It must never invent numbers.
  const bars = sceneAssets.defaultGraphicData('bar-chart', {on_screen_text: 'ROS2=100 | Dora-rs=380'}).data;
  assert.equal(bars.bars.length, 2);
  assert.equal(bars.bars[1].label, 'Dora-rs');
  assert.equal(bars.bars[1].value, 380);
  assert.deepEqual(sceneAssets.defaultGraphicData('bar-chart', {on_screen_text: 'no numbers here'}).data.bars, [], 'Unparseable data must stay empty rather than be invented');
  assert.equal(sceneAssets.defaultGraphicData('text-card', {generation_prompt: 'animating in word by word'}).options.reveal, 'words');
  assert.equal(sceneAssets.defaultGraphicData('text-card', {}).options.reveal, 'fade');

  const nodes = sceneAssets.defaultGraphicData('diagram', {on_screen_text: 'camera -> process -> output'}).data;
  assert.deepEqual(nodes.nodes.map(node => node.label), ['camera', 'process', 'output']);
  assert.deepEqual(nodes.edges, [[0, 1], [1, 2]]);
  assert.deepEqual(sceneAssets.defaultGraphicData('diagram', {on_screen_text: 'one thing'}).data.nodes, []);
  console.log('  graphic data: validation rules, derivation, and no invented numbers');
}

async function testPromptPack() {
  const scenes = [
    {id: 'a', title: 'Chart', seconds: 12, visual_intent: 'bars', on_screen_text: 'ROS2=100', generation_prompt: 'A bar chart exactly as written', shot_type: 'graphic', asset_id: null},
    {id: 'b', title: 'Has media', seconds: 5, visual_intent: 'own', asset_id: 'asset-1', generation_prompt: 'ignored'},
    {id: 'c', title: 'No prompt', seconds: 3, visual_intent: 'something', asset_id: null, generation_prompt: ''}
  ];
  const pack = sceneAssets.buildPromptPack({scenes, provider: 'leonardo'});
  assert.equal(pack.provider, 'leonardo');
  assert.equal(pack.scenes.length, 2, 'Only scenes without own media need a prompt');
  assert.equal(pack.summary.total, 2);
  assert.equal(pack.summary.without_prompt, 1);
  assert.equal(pack.summary.total_seconds, 15);
  assert.equal(pack.scenes[0].prompt, 'A bar chart exactly as written', 'The model prompt must be carried verbatim');
  assert.equal(pack.scenes[0].aspect_ratio, '16:9');
  assert.equal(pack.scenes[0].typographic, true);
  assert.equal(pack.scenes[0].suggested_template, 'bar-chart');
  assert.deepEqual(Object.keys(pack.profiles).sort(), ['comfy', 'leonardo', 'manual', 'mootion']);

  // The Comfy profile is the one the app can run itself, so it must be labelled as unverified guidance
  // and must say the workflow comes from the operator.
  const comfyPack = sceneAssets.buildPromptPack({scenes, provider: 'comfy'});
  assert.equal(comfyPack.provider, 'comfy');
  const comfyMarkdown = sceneAssets.promptPackMarkdown(comfyPack);
  assert.ok(comfyMarkdown.includes('Comfy Cloud'), 'The pack must name the tool');
  assert.ok(comfyMarkdown.includes('guidance, not vendor documentation'), 'Its notes must not claim to be vendor documentation');
  assert.ok(comfyMarkdown.includes('loop'), 'It must warn that a short clip is looped to fill the scene');

  const markdown = sceneAssets.promptPackMarkdown(pack);
  assert.ok(markdown.includes('A bar chart exactly as written'), 'The pack must contain the prompt');
  assert.ok(markdown.includes('```text'), 'The prompt must be in its own block so advice is never mistaken for it');
  assert.ok(markdown.includes('c: No prompt'), 'A scene without a prompt must still appear');
  assert.ok(markdown.includes('_The storyboard wrote no prompt for this scene._'));
  assert.ok(markdown.includes('guidance, not vendor documentation'), 'Unverified tool notes must say so');
  assert.equal(sceneAssets.profileFor('nonsense'), 'manual', 'An unknown provider falls back rather than inventing notes');
  console.log('  prompt pack: verbatim prompts, honest gaps, labelled unverified guidance');
}

async function testAssignGraphic() {
  await withServer(async ({baseUrl, projectsRoot, state}) => {
    const folder = await buildApprovedStoryboard(baseUrl, projectsRoot, state);
    const file = path.join(projectsRoot, folder, 'storyboard/storyboard.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const providerResult = path.join(projectsRoot, folder, 'storyboard/provider_result.json');
    const providerResultBefore = fs.readFileSync(providerResult, 'utf8');
    const revisionsBefore = before.scenes.length;

    // The storyboard model already assigned a bar chart to one scene.
    assert.equal(before.scenes.find(scene => scene.id === 'scene_two').graphic_template, 'bar-chart');
    assert.equal(before.scenes.filter(scene => scene.graphic_template).length, 1);

    // Assign a template the model did not choose.
    const assigned = await api(baseUrl, '/api/projects/' + folder + '/scene-graphic', {scene_id: 'scene_three', template: 'terminal'});
    assert.equal(assigned.status, 200, JSON.stringify(assigned.payload).slice(0, 300));
    assert.equal(assigned.payload.artifact.graphic_template, 'terminal');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.scenes.length, revisionsBefore, 'Assigning must not change the number of scenes');
    assert.equal(after.scenes.find(scene => scene.id === 'scene_three').graphic_template, 'terminal');
    assert.equal(after.scenes.find(scene => scene.id === 'scene_three').graphic_data.options.reveal, undefined, 'A terminal has no reveal option');
    // A scene with a template still has no media until production draws it, so it is still listed as
    // needing one. The prompt pack says which scenes are already planned locally.
    assert.ok(after.missing_assets.some(item => item.scene_id === 'scene_three'), 'A planned drawing is not media yet');
    const pack = JSON.parse(fs.readFileSync(path.join(projectsRoot, folder, 'storyboard/scene_prompts.json'), 'utf8'));
    assert.equal(pack.prompts.find(item => item.scene_id === 'scene_three').assigned_template, 'terminal', 'The pack must say which scenes are already planned');
    assert.equal(fs.readFileSync(providerResult, 'utf8'), providerResultBefore, 'provider_result.json must never be rewritten by an edit');

    // The markdown and the prompt pack must have been rewritten in step.
    const markdown = fs.readFileSync(path.join(projectsRoot, folder, 'storyboard/storyboard.md'), 'utf8');
    assert.ok(markdown.includes('Drawn locally: terminal'), 'The storyboard markdown must show the assignment');
    assert.ok(fs.existsSync(path.join(projectsRoot, folder, 'storyboard/scene_prompts.md')), 'The prompt pack markdown must exist');

    // Refusals.
    const unknownScene = await api(baseUrl, '/api/projects/' + folder + '/scene-graphic', {scene_id: 'nope', template: 'terminal'});
    assert.equal(unknownScene.status, 404);
    assert.match(unknownScene.payload.error, /Unknown scene/);
    const unknownTemplate = await api(baseUrl, '/api/projects/' + folder + '/scene-graphic', {scene_id: 'scene_three', template: 'hologram'});
    assert.equal(unknownTemplate.status, 400);
    assert.match(unknownTemplate.payload.error, /Unknown scene template/);
    const overMedia = await api(baseUrl, '/api/projects/' + folder + '/scene-graphic', {scene_id: 'scene_one', template: 'text-card'});
    assert.equal(overMedia.status, 409, 'A scene with own media must not silently gain a template');
    assert.match(overMedia.payload.error, /already uses own media/);

    // Clearing restores the stock path.
    const cleared = await api(baseUrl, '/api/projects/' + folder + '/scene-graphic', {scene_id: 'scene_three', template: null});
    assert.equal(cleared.status, 200);
    assert.equal(cleared.payload.artifact.graphic_cleared, 'terminal');
    const clearedBoard = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(clearedBoard.scenes.find(scene => scene.id === 'scene_three').graphic_template, undefined);
    assert.ok(clearedBoard.missing_assets.some(item => item.scene_id === 'scene_three'), 'The scene needs media again');
    assert.ok(clearedBoard.missing_assets.some(item => item.scene_id === 'scene_two'), 'The other unassigned scene is still listed too');
    const nothing = await api(baseUrl, '/api/projects/' + folder + '/scene-graphic', {scene_id: 'scene_three', template: null});
    assert.equal(nothing.status, 409, 'Clearing twice must say so rather than pretending');

    // Every edit is archived and invalidates what depended on it.
    const history = fs.readdirSync(path.join(projectsRoot, folder, 'storyboard/history'));
    assert.ok(history.length >= 2, 'Each edit must be archived');
    const project = JSON.parse(fs.readFileSync(path.join(projectsRoot, folder, 'project.json'), 'utf8'));
    assert.equal(project.workflow.stages.storyboard.state, 'needs_review', 'An edited storyboard needs review again');
    assert.equal(project.approvals.master_video, 'not_ready');
    console.log('  assign and clear: plan rewritten, provider result preserved, refusals specific');
  });
}

async function testAttachAndDetach() {
  await withServer(async ({baseUrl, projectsRoot, root, state}) => {
    const folder = await buildApprovedStoryboard(baseUrl, projectsRoot, state);
    const board = () => JSON.parse(fs.readFileSync(path.join(projectsRoot, folder, 'storyboard/storyboard.json'), 'utf8'));

    // A second real media asset, not yet selected for the project.
    const mediaPath = path.join(root, 'generated.mp4');
    execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', mediaPath], {stdio: 'ignore'});
    const upload = await fetch(baseUrl + '/api/library/upload?name=generated-by-leonardo.mp4&category=media', {
      method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: fs.readFileSync(mediaPath)
    });
    const generated = (await upload.json()).asset.id;
    // And a knowledge note, which must never be allowed to fill a scene.
    const note = await api(baseUrl, '/api/library', {kind: 'note', name: 'Reference note', content: 'Light curtains save hands.', category: 'knowledge'});

    // Rights are not recorded yet, so attaching must be refused for that reason.
    const noRights = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/asset', {asset_id: generated});
    assert.equal(noRights.status, 409, 'An asset with unrecorded rights must not be attached');
    assert.match(noRights.payload.error, /cannot be used yet/);

    /* A bare AI-generated record — no tool, no terms — must be accepted, because the output of a tool
       you ran on your own account is your own work. This is the regression that matters: the route
       used to refuse it with "Record which tool produced this". */
    const bareGenerated = await api(baseUrl, '/api/library/rights', {asset_ids: [generated], basis: 'generated'});
    assert.equal(bareGenerated.status, 200, 'Recording AI output as your own work must not demand a tool or terms: ' + JSON.stringify(bareGenerated.payload).slice(0, 200));
    assert.equal(bareGenerated.payload.assets[0].rights_summary.state, 'cleared', 'A bare AI-generated record must clear the gate');
    assert.deepEqual(bareGenerated.payload.assets[0].rights_summary.warnings, [], 'no warning may be raised for your own material');

    // The provenance fields are still accepted when you do want to record them.
    const notSelected = await api(baseUrl, '/api/library/rights', {asset_ids: [generated], basis: 'generated', holder: 'Leonardo AI', note: 'paid plan, commercial use permitted'});
    assert.equal(notSelected.status, 200);
    assert.equal(notSelected.payload.assets[0].rights_summary.state, 'cleared', 'AI output you made on your own account is your own work, so it is cleared');
    assert.equal(notSelected.payload.assets[0].rights_summary.self_owned, true);
    // The tool and terms are kept as provenance even though they are no longer a condition of use.
    assert.equal(notSelected.payload.assets[0].rights.holder, 'Leonardo AI');

    const notMedia = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/asset', {asset_id: note.payload.asset.id});
    assert.equal(notMedia.status, 409, 'A knowledge note must not be allowed to fill a scene');
    assert.match(notMedia.payload.error, /knowledge reference, not media/);

    const unknownAsset = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/asset', {asset_id: 'not-an-asset'});
    assert.equal(unknownAsset.status, 404);
    const unknownScene = await api(baseUrl, '/api/projects/' + folder + '/scenes/nope/asset', {asset_id: generated});
    assert.equal(unknownScene.status, 404);

    // The happy path. The asset is not in the project's selection yet, so the attach adopts it.
    const attached = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/asset', {asset_id: generated, tool: 'Leonardo AI', note: 'made from the scene prompt'});
    assert.equal(attached.status, 200, JSON.stringify(attached.payload).slice(0, 300));
    assert.equal(attached.payload.artifact.attached, generated);
    assert.equal(attached.payload.artifact.adopted_into_project, true, 'Attaching is itself the decision to use this file');
    assert.equal(attached.payload.artifact.rights_basis, 'generated');
    const adoptedProject = JSON.parse(fs.readFileSync(path.join(projectsRoot, folder, 'project.json'), 'utf8'));
    assert.ok(adoptedProject.workflow.materials.selections.some(item => item.asset_id === generated && item.decision === 'use'), 'The asset must be selected for the project');
    assert.equal(adoptedProject.workflow.materials.state, 'approved', 'The material decision must be settled, not left needing review');
    const scene = board().scenes.find(item => item.id === 'scene_three');
    assert.equal(scene.asset_id, generated);
    assert.equal(scene.attachment.provider, 'Leonardo AI');
    assert.equal(scene.attachment.previous_asset_id, null);
    assert.equal(scene.attachment.rights_basis, 'generated');
    assert.equal(board().missing_assets.length, 1, 'Only the drawn scene is still missing media');
    assert.ok(!board().missing_assets.some(item => item.scene_id === 'scene_three'), 'An attached scene is no longer missing');

    // A scene with a template refuses an attachment, so two sources never compete.
    const bothSources = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_two/asset', {asset_id: generated});
    assert.equal(bothSources.status, 409);
    assert.match(bothSources.payload.error, /assigned the bar-chart template/);

    // Detach returns the scene to missing and records what it displaced.
    const detached = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/asset', {asset_id: null});
    assert.equal(detached.status, 200);
    assert.equal(detached.payload.artifact.previous_asset_id, generated);
    assert.equal(board().scenes.find(item => item.id === 'scene_three').asset_id, undefined);
    assert.equal(board().scenes.find(item => item.id === 'scene_three').attachment, undefined);
    assert.equal(board().missing_assets.length, 2);
    const detachAgain = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/asset', {asset_id: null});
    assert.equal(detachAgain.status, 409);
    console.log('  attach and detach: five distinct refusals, a recorded basis, and clean detach');
  });
}

async function testProductionAndPreview() {
  await withServer(async ({baseUrl, projectsRoot, state}) => {
    const folder = await buildApprovedStoryboard(baseUrl, projectsRoot, state);
    const directory = path.join(projectsRoot, folder);

    // A preview must not touch the plan, the revision or an approval. That is the whole point of it.
    const projectBefore = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'));
    const preview = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_two/render-preview', {});
    assert.equal(preview.status, 200, JSON.stringify(preview.payload).slice(0, 300));
    assert.equal(preview.payload.preview.template, 'bar-chart', 'A preview falls back to the assigned template');
    assert.equal(preview.payload.preview.preview, true);
    assert.ok(fs.existsSync(path.join(directory, preview.payload.preview.path)), 'The preview file must exist');
    const projectAfter = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'));
    assert.equal(projectAfter.workflow.revision, projectBefore.workflow.revision, 'A preview must not bump the revision');
    assert.equal(projectAfter.workflow.stages.storyboard.state, projectBefore.workflow.stages.storyboard.state, 'A preview must not reset the approval state');
    assert.equal(JSON.stringify(projectAfter.approvals), JSON.stringify(projectBefore.approvals), 'A preview must not change approvals');

    const suggested = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/render-preview', {template: 'text-card'});
    assert.equal(suggested.status, 200, 'A preview may try a template that is not assigned yet');
    const refused = await api(baseUrl, '/api/projects/' + folder + '/scenes/scene_three/render-preview', {template: 'bar-chart'});
    assert.equal(refused.status, 409, 'A template with no data cannot be previewed either');
    assert.match(refused.payload.error, /at least two entries/);

    // Now produce the assets. The injected renderer stands in for Chrome.
    renders.length = 0;
    const assets = await api(baseUrl, '/api/projects/' + folder + '/assets', {});
    assert.equal(assets.status, 200, JSON.stringify(assets.payload).slice(0, 400));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'generated/asset_manifest.json'), 'utf8'));
    const byScene = new Map(manifest.scenes.map(scene => [scene.scene_id, scene]));

    assert.equal(byScene.get('scene_one').status, 'own_media', 'Own media wins over everything');
    assert.equal(byScene.get('scene_one').origin, 'own');
    assert.equal(byScene.get('scene_one').media.kind, 'video', 'The composer must be told what kind of file this is');
    assert.equal(byScene.get('scene_two').status, 'rendered', 'An assigned template is drawn locally');
    assert.equal(byScene.get('scene_two').template, 'bar-chart');
    assert.equal(byScene.get('scene_two').origin, undefined, 'A drawn scene is not own media from the library');
    assert.equal(byScene.get('scene_two').rights_state.state, 'cleared', 'Our own drawing needs no licence from anyone else');
    assert.match(byScene.get('scene_two').rights.note, /Drawn locally/);
    assert.ok(fs.existsSync(path.join(directory, byScene.get('scene_two').path)), 'The drawn scene must be a real file');
    assert.equal(byScene.get('scene_three').status, 'failed', 'The scene left to sourcing reports its miss honestly');
    assert.ok(byScene.get('scene_three').reason.length > 0);

    assert.equal(manifest.counts.rendered, 1);
    assert.equal(manifest.counts.own_media, 1);
    assert.equal(manifest.counts.still_missing, 1);
    assert.equal(manifest.counts.generated_external, 0);
    assert.equal(manifest.status, 'incomplete', 'A scene with no media keeps the project incomplete');
    assert.ok(renders.some(entry => entry.template === 'bar-chart'), 'The bar chart must have been drawn');
    assert.ok(renders.every(entry => entry.template !== 'text-card'), 'Only assigned templates are drawn');

    // The drawn scene is recorded in the asset index with its provenance.
    const index = JSON.parse(fs.readFileSync(path.join(directory, 'analyzed/asset_index.json'), 'utf8'));
    assert.equal(index.rendered.length, 1);
    assert.equal(index.rendered[0].template, 'bar-chart');
    assert.match(index.rendered[0].note, /Drawn locally from this project/);

    // Re-running reuses the unchanged drawing rather than rendering it again.
    renders.length = 0;
    await api(baseUrl, '/api/projects/' + folder + '/assets', {});
    assert.equal(renders.length, 0, 'An unchanged scene must be reused, not redrawn');
    const reused = JSON.parse(fs.readFileSync(path.join(directory, 'generated/asset_manifest.json'), 'utf8'));
    assert.equal(reused.scenes.find(scene => scene.scene_id === 'scene_two').reused, true);

    // Changing the data invalidates the reuse, and invalidates the assets stage that had already run.
    await api(baseUrl, '/api/projects/' + folder + '/scene-graphic', {scene_id: 'scene_two', template: 'bar-chart', data: {bars: [{label: 'ROS2', value: 100}, {label: 'Dora-rs', value: 500}]}});
    const invalidated = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf8'));
    assert.equal(invalidated.workflow.stages.assets.state, 'needs_update', 'Editing the plan invalidates the assets built from it');
    assert.equal(invalidated.workflow.stages.compose.state, 'locked', 'A stage that never ran stays locked');
    renders.length = 0;
    await api(baseUrl, '/api/projects/' + folder + '/assets', {});
    assert.equal(renders.length, 1, 'Changed data must be redrawn');
    console.log('  production: own media beats a template, templates beat sourcing, unchanged work is reused');
  });
}

async function run() {
  await testHeuristics();
  await testGraphicData();
  await testPromptPack();
  await testAssignGraphic();
  await testAttachAndDetach();
  await testProductionAndPreview();
  console.log('All scene asset tests passed: heuristics, prompt pack, assignment, attachment, production precedence (mock network, injected renderer).');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
'use strict';
/* Creative stage tests. The provider is mocked, so these cover the logic this project owns:
   parsing and validating model output, refusing to save bad answers, and the stage engine's
   history, revision and rollback behaviour. No paid calls. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {extractJson} = require('../src/lib/jsonExtract');
const {parseStrategy, parseScript, parseStoryboard, checkResearch, assetCatalogue, visualAssets, RESEARCH_HEADINGS} = require('../src/lib/stages');
const {runStage} = require('../src/lib/stageRunner');
const {createProject} = require('../src/lib/projectGenerator');
const intake = require('../src/lib/intakeWorkflow');

async function run() {
  // ---------- JSON extraction ----------
  assert.equal(extractJson('{"a":1}').value.a, 1);
  assert.equal(extractJson('```json\n{"a":2}\n```').value.a, 2);
  assert.equal(extractJson('Here is the plan:\n{"a":3}\nHope that helps.').value.a, 3);
  assert.equal(extractJson('[1,2,3]').value.length, 3);
  assert.equal(extractJson('no json here').ok, false);
  assert.equal(extractJson('').ok, false);
  assert.equal(extractJson('{"broken":').ok, false, 'Truncated JSON must fail rather than be guessed at');
  assert.equal(extractJson('"just a string"').ok, false, 'A bare string is not a usable object');

  // ---------- research validation ----------
  checkResearch('## Summary\nx\n\n## Key findings\ny\n\n## Claims to verify\nz');
  assert.throws(() => checkResearch('## Findings\nonly one section'), /missing expected sections/);
  assert.equal(RESEARCH_HEADINGS.length, 3);

  // ---------- strategy parsing ----------
  const goodStrategy = JSON.stringify({
    story_promise: 'Understand the risk', target_audience: 'Managers', angle: 'Practical',
    structure: [{section: 'Hook', purpose: 'Open', seconds: 20}, {section: 'Body!', purpose: 'Explain', seconds: '100'}],
    hooks: ['A hook'], retention_moments: ['a moment'], material_usage: [{item: 'Interview', use: 'quoted'}],
    short_form_opportunities: ['Hook'], risks: ['unverified claim']
  });
  const parsed = parseStrategy(goodStrategy);
  assert.equal(parsed.story_promise, 'Understand the risk');
  assert.equal(parsed.structure.length, 2);
  assert.equal(parsed.structure[1].seconds, 100, 'A numeric string must be coerced');
  assert.equal(parsed.structure[1].id, 'body', 'Section ids must be slugged');
  assert.equal(parsed.material_usage.length, 1);
  assert.throws(() => parseStrategy('not json'), /did not return readable JSON/);
  assert.throws(() => parseStrategy(JSON.stringify({structure: [{section: 'A', seconds: 10}]})), /no story promise/);
  assert.throws(() => parseStrategy(JSON.stringify({story_promise: 'P', structure: []})), /no structure/);
  // Missing optional fields default rather than throwing.
  const sparse = parseStrategy(JSON.stringify({story_promise: 'P', structure: [{section: 'A'}]}));
  assert.deepEqual(sparse.hooks, []);
  assert.equal(sparse.structure[0].seconds, 0);

  // ---------- script parsing ----------
  const goodScript = JSON.stringify({
    sections: [
      {id: 'hook', title: 'Hook', narration: 'Opening line.', visual_notes: ['b-roll'], seconds: 20, source_refs: ['research'], short_form: true},
      {title: 'No narration here'},
      {title: 'Body', narration: 'Second line.', seconds: '160'}
    ],
    estimated_duration_seconds: 180
  });
  const script = parseScript(goodScript, 180);
  // A silent section is kept so asset production can report it, rather than vanishing from the plan.
  assert.equal(script.sections.length, 3, 'A section with a title but no narration must be kept and reported');
  assert.equal(script.sections[1].narration, '', 'The silent section must be visibly empty');
  assert.equal(script.sections[1].id, 'section_2', 'A missing id is generated from the position');
  assert.equal(script.sections[2].seconds, 160);
  assert.equal(script.estimated, 180);
  assert.throws(() => parseScript(JSON.stringify({sections: []})), /no narration/);

  // ---------- the asset catalogue the director chooses from ----------
  const rawAssets = [
    {id: 'a1', name: 'factory.mp4', kind: 'file', category: 'media', mime: 'video/mp4', analysis: {state: 'analyzed', media: {width: 1920, height: 1080, durationSeconds: 12.5}, transcription: {status: 'done'}, content: {text: 'The operator checks the light curtain.'}}},
    {id: 'a2', name: 'notes.txt', kind: 'file', category: 'knowledge', mime: 'text/plain', analysis: {state: 'analyzed', detected: {type: 'text'}, content: {text: 'Emergency stop procedure.'}}},
    {id: 'a3', name: 'a-note', kind: 'note', category: 'knowledge', content: 'written by hand'},
    {id: 'a4', name: 'logo.png', kind: 'file', category: 'brand', mime: 'image/png', analysis: {state: 'analyzed', media: {width: 512, height: 512}}}
  ];
  const catalogue = assetCatalogue(rawAssets);
  assert.equal(catalogue.length, 4);
  const video = catalogue.find(asset => asset.id === 'a1');
  assert.equal(video.description, 'The operator checks the light curtain.', 'A transcript must describe the footage');
  assert.equal(video.resolution, '1920x1080');
  assert.equal(video.durationSeconds, 12.5);
  const text = catalogue.find(asset => asset.id === 'a2');
  assert.equal(text.description, 'Emergency stop procedure.', 'Extracted text describes a text file');
  const note = catalogue.find(asset => asset.id === 'a3');
  assert.equal(note.description, null, 'An unanalyzed note must not be described');
  // Only real footage may be cut into the video.
  const visual = visualAssets(rawAssets).map(asset => asset.id);
  assert.deepEqual(visual.sort(), ['a1', 'a4'], 'Only media files are offered to the director, got: ' + visual.join(','));

  // ---------- storyboard parsing and asset validation ----------
  const storyboardJson = JSON.stringify({
    scenes: [
      {id: 'Scene One', title: 'Opening', narration_section_id: 'hook', seconds: 20, visual_intent: 'Wide shot', asset_id: 'a1', shot_type: 'wide'},
      // A hallucinated id must never be trusted.
      {id: 'scene_2', title: 'Detail', narration_section_id: 'body', seconds: 30, visual_intent: 'Close up', asset_id: 'does-not-exist', generation_prompt: 'Close-up of the light curtain'},
      // An unknown narration section must not be linked.
      {id: 'scene_3', title: 'Close', narration_section_id: 'nope', seconds: 10, visual_intent: 'Logo', asset_id: null, generation_prompt: 'Brand logo on white'}
    ],
    total_duration_seconds: 60
  });
  const storyboard = parseStoryboard(storyboardJson, {assetIds: ['a1', 'a4'], sectionIds: ['hook', 'body']});
  assert.equal(storyboard.scenes.length, 3);
  assert.equal(storyboard.scenes[0].id, 'scene_one', 'Scene ids must be slugged');
  assert.equal(storyboard.scenes[0].asset_id, 'a1');
  assert.equal(storyboard.scenes[1].asset_id, null, 'A hallucinated asset id must be dropped, not trusted');
  assert.deepEqual(storyboard.rejectedAssets, ['does-not-exist'], 'The rejected id must be reported');
  assert.equal(storyboard.scenes[2].narration_section_id, null, 'An unknown narration section must not be linked');
  assert.equal(storyboard.total, 60);
  assert.throws(() => parseStoryboard('not json', {assetIds: [], sectionIds: []}), /did not return readable JSON/);
  assert.throws(() => parseStoryboard(JSON.stringify({scenes: []}), {assetIds: [], sectionIds: []}), /no scenes/);
  // With no assets available, every named asset is rejected and every scene is missing.
  const noAssets = parseStoryboard(storyboardJson, {assetIds: [], sectionIds: ['hook', 'body']});
  assert.equal(noAssets.scenes.every(scene => scene.asset_id === null), true, 'With no available assets every scene must be missing');
  assert.deepEqual(noAssets.rejectedAssets.sort(), ['a1', 'does-not-exist'], 'Both named ids must be reported as unusable');

  // ---------- the stage engine ----------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-stages-'));
  const projectsRoot = path.join(root, 'projects');
  const created = createProject({outDir: projectsRoot, prompt: 'A video about robot safety for plant managers.'});
  const folder = path.basename(created.projectDirectory);

  // The intake gate must be satisfied before any stage runs.
  await assert.rejects(
    () => runStage({stage: 'strategy', label: 'Strategy', projectsRoot, folder, call: async () => ({outputs: {}})}),
    /Confirm your brief/,
    'A stage must not run before the brief and material are confirmed'
  );

  let ctx = intake.context(projectsRoot, folder);
  intake.confirmBrief(ctx, {...ctx.brief, angle: 'Safety', purpose: 'Reduce risk', revision: ctx.project.workflow.revision});
  ctx = intake.context(projectsRoot, folder);
  intake.confirmMaterials(ctx, {revision: ctx.project.workflow.revision, without_material: true}, () => ({id: 'x'}));

  const result = await runStage({
    stage: 'strategy', label: 'Strategy', projectsRoot, folder, status: 'strategy_ready',
    invalidates: ['script'],
    call: async () => ({outputs: {'strategy/content_strategy.md': '# Strategy\n\nbody'}, artifactPath: 'strategy/content_strategy.md', artifact: {sections: 2}}),
    apply: (c) => { c.project.strategy_result = {provider: 'anthropic'}; }
  });
  assert.equal(result.project.status, 'strategy_ready');
  assert.equal(result.project.workflow.stages.strategy.state, 'needs_review');
  assert.equal(result.project.workflow.stages.strategy.revision, 1);
  assert.equal(result.project.strategy_result.provider, 'anthropic', 'The apply hook must record stage fields');
  assert.ok(fs.readFileSync(path.join(created.projectDirectory, 'strategy/content_strategy.md'), 'utf8').includes('# Strategy'));

  // Regenerating archives the previous artifact under history.
  await runStage({stage: 'strategy', label: 'Strategy', projectsRoot, folder, call: async () => ({outputs: {'strategy/content_strategy.md': '# Strategy\n\nsecond'}})});
  const history = path.join(created.projectDirectory, 'strategy/history');
  assert.ok(fs.existsSync(history) && fs.readdirSync(history).length >= 1, 'The previous result must be archived');
  assert.equal(intake.context(projectsRoot, folder).project.workflow.stages.strategy.revision, 2);

  // A stage whose inputs changed while it was running must not save.
  const revisionAtStart = intake.context(projectsRoot, folder).project.workflow.revision;
  await assert.rejects(
    () => runStage({
      stage: 'strategy', label: 'Strategy', projectsRoot, folder,
      call: async () => {
        // Simulate the user editing the brief while the provider was working.
        const mid = intake.context(projectsRoot, folder);
        intake.confirmBrief(mid, {...mid.brief, angle: 'Changed', purpose: 'Changed', revision: mid.project.workflow.revision});
        return {outputs: {'strategy/content_strategy.md': '# Should not be saved'}};
      }
    }),
    /inputs changed while it was running/,
    'A result computed against stale inputs must be refused'
  );
  assert.ok(!fs.readFileSync(path.join(created.projectDirectory, 'strategy/content_strategy.md'), 'utf8').includes('Should not be saved'));

  // The stale-input test edited the brief, which correctly invalidated the material approval.
  // Re-establish the gate before testing the next failure mode.
  let reopened = intake.context(projectsRoot, folder);
  intake.confirmMaterials(reopened, {revision: reopened.project.workflow.revision, without_material: true}, () => ({id: 'x'}));

  // A failing write must leave the previous artifact intact.
  const before = fs.readFileSync(path.join(created.projectDirectory, 'strategy/content_strategy.md'), 'utf8');
  let outsideError = null;
  try {
    await runStage({stage: 'strategy', label: 'Strategy', projectsRoot, folder, call: async () => ({outputs: {'strategy/content_strategy.md': '# Replaced', 'strategy/ok.json': '{"a":1}', '../escape.txt': 'nope'}})});
  } catch (error) { outsideError = error; }
  assert.ok(outsideError, 'A write outside the project directory must be refused');
  assert.match(outsideError.message, /Refusing to write outside the project directory/, 'Unexpected refusal reason: ' + outsideError.message);
  assert.equal(fs.readFileSync(path.join(created.projectDirectory, 'strategy/content_strategy.md'), 'utf8'), before, 'A failed write must restore the previous artifact');
  assert.ok(!fs.existsSync(path.join(projectsRoot, 'escape.txt')), 'Nothing may be written outside the project');

  fs.rmSync(root, {recursive: true, force: true});
  console.log('All creative stage tests passed: JSON extraction, validation, asset catalogue, storyboard asset guard, stage engine history, stale-input refusal, and rollback.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
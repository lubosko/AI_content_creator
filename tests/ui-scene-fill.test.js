'use strict';
/* The scene fill panel, rendered by the real views in the fake DOM. The project's storyboard
   artifacts are written directly: this test is about what the interface shows and does, not about
   how the storyboard was generated, which tests/scene-assets.test.js covers. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {createServer} = require('../src/server');
const {boot} = require('./helpers/ui-harness');
const sceneAssets = require('../src/lib/sceneAssets');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

const SCENES = [
  {id: 'scene_one', title: 'Own media', narration_section_id: 'hook', seconds: 10, visual_intent: 'Factory floor', asset_id: 'library-asset', shot_type: 'wide', on_screen_text: '', generation_prompt: '', transition: ''},
  {id: 'scene_two', title: 'Benchmark bars', narration_section_id: 'body', seconds: 12, visual_intent: 'Two bars race upward', asset_id: null, shot_type: 'graphic', on_screen_text: 'ROS2=100 | Dora-rs=380', generation_prompt: 'A bar chart of the benchmark', transition: ''},
  {id: 'scene_three', title: 'Install terminal', narration_section_id: 'body', seconds: 14, visual_intent: 'Terminal showing the install', asset_id: null, shot_type: 'screen recording', on_screen_text: 'PS> pip install dora-rs', generation_prompt: 'A terminal window typing the install command', transition: ''}
];

async function writeStoryboard(projectsRoot, folder) {
  const directory = path.join(projectsRoot, folder, 'storyboard');
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'storyboard.json'), JSON.stringify({
    scenes: SCENES,
    total_duration_seconds: 36,
    missing_assets: sceneAssets.buildMissingAssets(SCENES, 'manual'),
    selected_asset_ids: ['library-asset'],
    warnings: []
  }, null, 2));
  const pack = sceneAssets.buildPromptPack({scenes: SCENES, provider: 'manual'});
  fs.writeFileSync(path.join(directory, 'scene_prompts.json'), JSON.stringify({
    provider: pack.provider, aspect_ratio: pack.aspect_ratio, profiles: pack.profiles, summary: pack.summary,
    prompts: sceneAssets.buildScenePrompts(SCENES, 'manual')
  }, null, 2));
  fs.writeFileSync(path.join(directory, 'scene_prompts.md'), sceneAssets.promptPackMarkdown(pack));
  const file = path.join(projectsRoot, folder, 'project.json');
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  project.workflow.stages.storyboard.revision = 1;
  project.workflow.stages.storyboard.state = 'needs_review';
  project.workflow.stages.script.revision = 1;
  project.workflow.stages.script.state = 'approved';
  project.workflow.stages.storyboard.revision = 1;
  fs.writeFileSync(file, JSON.stringify(project, null, 2));
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-scene-fill-'));
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
    const created = await (await fetch(base + '/api/projects', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({prompt: 'A video about robot safety for plant managers.'})})).json();
    const folder = created.folder;
    await writeStoryboard(projectsRoot, folder);

    const ui = boot({base});
    ui.navigate('#/project/' + encodeURIComponent(folder) + '/storyboard');
    await ui.settle(() => ui.document.querySelectorAll('.fill-scene').length >= 2, {description: 'the fill panel to render', timeout: 8000});

    const rows = ui.document.querySelectorAll('.fill-scene');
    assert.equal(rows.length, 2, 'Only scenes without own media get a fill editor, got ' + rows.length);
    const bodyText = ui.text(ui.document.getElementById('viewBody'));
    assert.ok(bodyText.indexOf('Fill each scene') >= 0, 'The panel must be present');
    assert.ok(bodyText.indexOf('Own media') >= 0, 'Scenes that already have media must still be listed in the table');
    assert.ok(bodyText.indexOf('To fill') >= 0, 'An unfilled scene must say so, and not call itself failed');
    assert.ok(bodyText.indexOf('Failed') === -1, 'A scene waiting to be filled is not a failure');
    assert.ok(bodyText.indexOf('Drawn locally') === -1, 'Nothing is assigned yet in this fixture');

    // The typographic caution, and the promise that nothing here costs money.
    assert.ok(bodyText.indexOf('Mostly on-screen text') >= 0, 'A mostly-text scene must be flagged');
    assert.ok(bodyText.indexOf('spells them exactly') >= 0, 'The flag must explain why drawing locally is better');
    assert.ok(bodyText.indexOf('Nothing here spends money') >= 0, 'The panel must say it costs nothing');

    // The template vocabulary comes from the server, not from the view.
    const templateSelect = ui.byId('template-scene_two');
    assert.ok(templateSelect, 'The template selector must exist');
    const options = templateSelect.querySelectorAll('option').map(node => node.value).filter(Boolean);
    assert.deepEqual(options.sort(), sceneAssets.graphicTemplates().slice().sort(), 'The selector must offer exactly the server vocabulary');

    // The suggested template is pre-selected from the storyboard, without the view guessing.
    assert.equal(templateSelect.value, 'bar-chart', 'A benchmark scene should be offered the bar chart first');

    // Tool notes change with the tool, and the prompt is offered verbatim.
    const promptBox = Array.prototype.filter.call(ui.document.querySelectorAll('.asset-excerpt'), node => ui.text(node).indexOf('bar chart of the benchmark') >= 0)[0];
    assert.ok(promptBox, 'The scene prompt must be shown verbatim');

    // Clipboard: with the API present the exact prompt is written; without it a fallback appears.
    const written = [];
    ui.window.navigator = {clipboard: {writeText: value => { written.push(value); return Promise.resolve(); }}};
    const copyButtons = Array.prototype.filter.call(ui.document.querySelectorAll('button'), node => ui.text(node).trim() === 'Copy prompt');
    assert.ok(copyButtons.length >= 2, 'Every scene must offer a copy button');
    copyButtons[0].click();
    await ui.settle(() => written.length > 0, {description: 'the prompt to reach the clipboard'});
    assert.ok(written[0].indexOf('bar chart of the benchmark') >= 0, 'The copied text must be the scene prompt, got: ' + written[0]);
    assert.equal(written[0].indexOf('guidance, not vendor documentation'), -1, 'Advice must never be copied as part of the prompt');

    delete ui.window.navigator;
    copyButtons[1].click();
    await ui.settle(() => ui.document.getElementById('copyFallback'), {description: 'the manual copy fallback'});
    assert.ok(ui.byId('copyFallback').value.indexOf('terminal') >= 0, 'The fallback must hold the second scene prompt');

    // Attach controls exist and are honest about why they may be unusable.
    assert.ok(ui.byId('attach-file-scene_two'), 'An upload control must be offered');
    const attachSelect = ui.byId('attach-scene_two');
    assert.ok(attachSelect, 'A selector of eligible library material must be offered');
    assert.ok(bodyText.indexOf('Record rights on an item first') >= 0, 'With nothing eligible, the panel must say why');

    // Clearing is refused when nothing is assigned, and the button reflects that.
    const clearButton = Array.prototype.filter.call(ui.document.querySelectorAll('button'), node => ui.text(node).trim() === 'Clear')[0];
    assert.ok(clearButton, 'A clear control must exist');
    assert.equal(clearButton.disabled, true, 'Clearing an unassigned scene must be unavailable rather than failing');

    console.log('All scene fill panel tests passed: rows, flags, vocabulary, clipboard and attach controls.');
    // The fake DOM leaves timers behind, so the exit is explicit rather than waiting on an empty loop.
    process.exit(0);
  } finally {
    // A keep-alive connection would otherwise hold the process open after the assertions finish.
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
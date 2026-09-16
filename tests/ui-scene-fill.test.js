'use strict';
/* The scene cards, rendered by the real views in the fake DOM.

   This screen was a five-column table plus a second list of the same scenes, with every control for
   every scene on screen at once, and the cards closed themselves whenever anything re-rendered. What
   is asserted here is the replacement: one list, three paths per scene with only one open, one
   vocabulary, and a card that survives a re-render.

   The project's storyboard artifacts are written directly: this is about what the interface shows and
   does, not about how the storyboard was generated. */

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
  // The script results, so the card can show the narration each scene covers.
  const script = path.join(projectsRoot, folder, 'script');
  fs.mkdirSync(script, {recursive: true});
  fs.writeFileSync(path.join(script, 'script.json'), JSON.stringify({
    sections: [
      {id: 'hook', title: 'Hook', narration: 'The robot will not warn you.', seconds: 10},
      {id: 'body', title: 'Body', narration: 'Check the light curtain before entry.', seconds: 26}
    ],
    estimated_duration_seconds: 36
  }, null, 2));
  const file = path.join(projectsRoot, folder, 'project.json');
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  project.workflow.stages.storyboard = Object.assign({}, project.workflow.stages.storyboard, {revision: 1, state: 'needs_review'});
  project.workflow.stages.script = Object.assign({}, project.workflow.stages.script, {revision: 1, state: 'approved'});
  fs.writeFileSync(file, JSON.stringify(project, null, 2));
}

function cards(ui) { return Array.prototype.slice.call(ui.document.querySelectorAll('.fill-scene')); }
function cardFor(ui, sceneId) { return cards(ui).filter(node => node.getAttribute('data-scene') === sceneId)[0]; }
function buttonsIn(node, ui) {
  return Array.prototype.slice.call(node.querySelectorAll('button')).filter(button => ui.text(button).trim() === 'Draw locally' || ui.text(button).trim() === 'Generate with Comfy' || ui.text(button).trim() === 'Use a file');
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
    await ui.settle(() => cards(ui).length >= 3, {description: 'the scene cards', timeout: 8000});

    // --- one list, every scene, one vocabulary ---
    assert.equal(cards(ui).length, 3, 'Every scene gets a card, not only the unfilled ones');
    const bodyText = ui.text(ui.document.getElementById('viewBody'));
    assert.equal(bodyText.indexOf('Missing'), -1, '"Missing" is gone: it read as an error for a scene that simply needs media');
    assert.equal(bodyText.indexOf('Not filled'), -1, '"Not filled" is gone');
    assert.equal(bodyText.indexOf('To fill'), -1, '"To fill" is gone');
    assert.equal(bodyText.indexOf('Where you will generate it'), -1, 'The select that changed nothing is gone');
    // Exactly the states listed, once each, as a pill and as a metric: nothing invented.
    assert.ok(cards(ui).some(node => node.getAttribute('data-state') === 'your_media'), 'A scene with own media reports it');
    assert.ok(cards(ui).some(node => node.getAttribute('data-state') === 'needs'), 'An unfilled scene reports needing media');
    assert.ok(bodyText.indexOf('Needs media') >= 0, 'The state is named in the same words everywhere');
    assert.ok(bodyText.indexOf('Your media') >= 0);

    // --- three paths per scene, only one open ---
    const subject = cardFor(ui, 'scene_two');
    assert.ok(subject, 'The scene card must be findable by its scene id');
    const pathButtons = buttonsIn(subject, ui);
    assert.equal(pathButtons.length, 3, 'Each scene offers three paths, got ' + pathButtons.length);
    assert.equal(subject.open, false, 'Cards start closed, so fourteen of them stay readable');

    // The fake DOM has no property setter for open, so the toggle event a browser fires is dispatched by hand.
    const openCard = (node) => { node.open = true; node.dispatch('toggle', {}); };
    openCard(subject);
    assert.equal(subject.open, true);
    assert.ok(!subject.getAttribute('data-path'), 'Opening a card does not pick a path for you');

    const byLabel = label => pathButtons.filter(button => ui.text(button).trim() === label)[0];
    const panelOf = name => subject.querySelectorAll('[data-path]').length;  // not used; panels are siblings
    void panelOf;

    byLabel('Draw locally').click();
    assert.equal(subject.getAttribute('data-path'), 'local', 'Choosing a path records it');
    assert.ok(ui.byId('template-scene_two'), 'The draw path offers the template vocabulary');
    const templateSelect = ui.byId('template-scene_two');
    assert.deepEqual(templateSelect.querySelectorAll('option').map(node => node.value).sort(), sceneAssets.graphicTemplates().slice().sort(), 'The selector comes from the server, not from the view');
    assert.equal(templateSelect.value, 'bar-chart', 'The suggested template is preselected from the storyboard');

    byLabel('Use a file').click();
    assert.equal(subject.getAttribute('data-path'), 'attach', 'Choosing another path replaces it, so one thing is open at a time');
    assert.ok(ui.byId('attach-scene_two'), 'The file path offers the project material picker');
    // The fake DOM matches attribute selectors with single quotes; a browser accepts either.
    const panel = name => subject.querySelector("[data-panel='" + name + "']");
    assert.equal(panel('attach').hidden, false, 'The chosen panel is shown');
    assert.equal(panel('local').hidden, true, 'The other panels are hidden, so one thing is on screen at a time');
    assert.equal(panel('generate').hidden, true);

    // --- the card survives a re-render, which is the bug this screen had ---
    ui.window.App.render();

    const afterRerender = cardFor(ui, 'scene_two');
    assert.ok(afterRerender, 'The card is still there after a re-render');
    assert.equal(afterRerender.open, true, 'A re-render must not close the card you are working in');
    assert.equal(afterRerender.getAttribute('data-path'), 'attach', 'A re-render must not lose the path you were on');

    // --- the library picker is scoped to this project ---
    // Nothing is selected for this project, so it must offer nothing, even though the library has items.
    const libraryAsset = await (await fetch(base + '/api/library/upload?name=unrelated.png&category=media', {
      method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: Buffer.from('89504e470d0a1a0a', 'hex')
    })).json();
    await fetch(base + '/api/library/rights', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({asset_ids: [libraryAsset.asset.id], basis: 'own'})});
    await ui.window.Api.library().then(payload => ui.window.Store.patch({library: payload.assets || []}));
    ui.window.App.render();
    await ui.settle(() => cardFor(ui, 'scene_two'), {description: 'the card after the library changed'});
    const emptyCard = cardFor(ui, 'scene_two');
    openCard(emptyCard);
    buttonsIn(emptyCard, ui).filter(button => ui.text(button).trim() === 'Use a file')[0].click();
    const picker = ui.byId('attach-scene_two');
    assert.ok(picker, 'The picker exists even when there is nothing to pick');
    assert.equal(picker.querySelectorAll('option').length, 0, 'A rights-cleared library file that this project never chose must not be offered');
    assert.ok(ui.text(emptyCard).indexOf('Nothing is chosen for this project yet') >= 0, 'And the panel must say where to choose it');

    // --- the prompt lives in the generate path, quoted verbatim, with copy ---
    const generateCard = cardFor(ui, 'scene_three');
    openCard(generateCard);
    buttonsIn(generateCard, ui).filter(button => ui.text(button).trim() === 'Generate with Comfy')[0].click();
    await ui.settle(() => ui.text(generateCard).indexOf('Comfy') >= 0, {description: 'the generate path to render'});
    assert.ok(ui.text(generateCard).indexOf('Add a Comfy API key') >= 0, 'With no key the path says so rather than offering a run that must fail');
    assert.ok(ui.text(generateCard).indexOf('Mostly on-screen text') >= 0, 'A typographic scene is flagged where the decision is made');
    assert.equal(ui.byId('comfy-prompt-scene_three'), null, 'No generation control is offered without a key');

    // --- draw controls behave as before ---
    const drawCard = cardFor(ui, 'scene_two');
    openCard(drawCard);
    buttonsIn(drawCard, ui).filter(button => ui.text(button).trim() === 'Draw locally')[0].click();
    assert.ok(ui.byId('data-scene_two'), 'The data box is offered');
    assert.equal(drawCard.querySelector("[data-panel='local']").hidden, false, 'The draw panel is the one shown');
    assert.equal(drawCard.querySelector("[data-panel='attach']").hidden, true, 'The upload control belongs to the file path, which is hidden');
    const clearButton = Array.prototype.filter.call(drawCard.querySelectorAll('button'), node => ui.text(node).trim() === 'Clear')[0];
    assert.ok(clearButton, 'A clear control must exist');
    assert.equal(clearButton.disabled, true, 'Clearing an unassigned scene is unavailable rather than failing');

    // --- a scene that already has media can be detached, which had no control before ---
    const mediaCard = cardFor(ui, 'scene_one');
    assert.equal(mediaCard.getAttribute('data-state'), 'your_media');
    openCard(mediaCard);
    buttonsIn(mediaCard, ui).filter(button => ui.text(button).trim() === 'Use a file')[0].click();
    const detach = Array.prototype.filter.call(mediaCard.querySelectorAll('button'), node => ui.text(node).trim() === 'Detach this scene')[0];
    assert.ok(detach, 'A scene using own media can be detached from here');
    // And the paths that cannot apply say so instead of failing on the server.
    buttonsIn(mediaCard, ui).filter(button => ui.text(button).trim() === 'Draw locally')[0].click();
    assert.ok(ui.text(mediaCard).indexOf('already uses your own media') >= 0, 'The draw path explains it would replace the media');
    assert.equal(ui.byId('template-scene_one'), null, 'And does not offer a template that the server would refuse');

    /* --- a failed results load must not be retried by every render ---
       The render-time guard used to read "no result yet" for a load that had already failed, so it
       asked again on each render: a request-and-render loop that never terminates. */
    let scriptRequests = 0;
    const failingUi = boot({
      base,
      fetchImpl: (url, options) => {
        if (String(url).indexOf('/results/script') >= 0) {
          scriptRequests++;
          return Promise.resolve(new Response('{"error":"nope"}', {status: 500, headers: {'content-type': 'application/json'}}));
        }
        return fetch(url, options);
      }
    });
    failingUi.navigate('#/project/' + encodeURIComponent(folder) + '/storyboard');
    await failingUi.settle(() => cards(failingUi).length >= 3, {description: 'the cards despite the failing script load', timeout: 8000});
    const afterFirst = scriptRequests;
    assert.equal(afterFirst, 1, 'A failed load is attempted once, got ' + afterFirst);
    for (let i = 0; i < 5; i++) failingUi.window.App.render();
    assert.equal(scriptRequests, 1, 'Five more renders must not re-request a load that already failed, got ' + scriptRequests);
    assert.ok(failingUi.window.Store.snapshot().resultsAttempted.script, 'The attempt is recorded, which is what stops the loop');

    console.log('All scene card tests passed: one list, three paths, one vocabulary, state that survives a re-render, a project-scoped file picker, and no retry loop.');
    process.exit(0);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exit(1); });
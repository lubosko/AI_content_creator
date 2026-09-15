'use strict';
/* The whole chain, in a real browser: the interface asks for a preview, the server draws it with
   Chrome and FFmpeg, and the page plays the file back. The storyboard artifacts are written
   directly, so this is about rendering and the interface, not about the language model. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {createServer} = require('../src/server');
const browserModule = require('../src/lib/browser');
const sceneAssets = require('../src/lib/sceneAssets');

const browser = browserModule.findBrowser();
if (!browser && process.env.ALLOW_SKIP_BROWSER_TESTS === '1') {
  console.log('Scene render browser tests skipped: no Chrome or Edge found, and ALLOW_SKIP_BROWSER_TESTS=1.');
  process.exit(0);
}
assert.ok(browser, 'No Chrome or Edge found, so the render round trip cannot be verified. Set CHROME_PATH or ALLOW_SKIP_BROWSER_TESTS=1.');

const SHOTS = path.join(__dirname, '..', 'test-results');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

const SCENES = [
  {id: 'card_one', title: 'Aspiration', narration_section_id: 'hook', seconds: 3, visual_intent: 'Large bold text', asset_id: null, shot_type: 'graphic', on_screen_text: 'Aspiration, not a shipped kernel', generation_prompt: 'large bold text card', transition: ''},
  {id: 'bars_one', title: 'Benchmark', narration_section_id: 'body', seconds: 3, visual_intent: 'Two bars race upward', asset_id: null, shot_type: 'graphic', on_screen_text: 'ROS2=100 | Dora-rs=380', generation_prompt: 'bar chart of the benchmark', transition: ''}
];

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-render-'));
  const projectsRoot = path.join(root, 'projects');
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')}
  });
  const base = await listen(server);
  let page = null;
  try {
    const created = await (await fetch(base + '/api/projects', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({prompt: 'A video about Dora-rs for robotics developers.'})})).json();
    const folder = created.folder;

    /* A project only reaches the storyboard stage with its brief and material decisions confirmed,
       and assigning a template writes through the stage engine, which enforces exactly that. */
    const post = (route, body) => fetch(base + route, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
    let intake = await (await fetch(base + '/api/projects/' + folder + '/intake')).json();
    await post('/api/projects/' + folder + '/brief', Object.assign({}, intake.brief, {angle: 'Practical introduction', purpose: 'Understand the system', revision: intake.project.workflow.revision}));
    intake = await (await fetch(base + '/api/projects/' + folder + '/intake')).json();
    await post('/api/projects/' + folder + '/materials-confirm', {revision: intake.project.workflow.revision, without_material: true});

    const directory = path.join(projectsRoot, folder, 'storyboard');
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'storyboard.json'), JSON.stringify({
      scenes: SCENES,
      total_duration_seconds: 6,
      missing_assets: sceneAssets.buildMissingAssets(SCENES, 'manual'),
      selected_asset_ids: [],
      warnings: []
    }, null, 2));
    const pack = sceneAssets.buildPromptPack({scenes: SCENES, provider: 'manual'});
    fs.writeFileSync(path.join(directory, 'scene_prompts.json'), JSON.stringify({
      provider: pack.provider, aspect_ratio: pack.aspect_ratio, profiles: pack.profiles, summary: pack.summary,
      prompts: sceneAssets.buildScenePrompts(SCENES, 'manual')
    }, null, 2));
    const projectFile = path.join(projectsRoot, folder, 'project.json');
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    project.workflow.stages.storyboard.revision = 1;
    project.workflow.stages.storyboard.state = 'needs_review';
    fs.writeFileSync(projectFile, JSON.stringify(project, null, 2));

    page = await browserModule.launch({width: 1440, height: 1000});
    await page.navigate(base + '/#/project/' + encodeURIComponent(folder) + '/storyboard');
    await page.waitFor('document.querySelectorAll(".fill-scene").length >= 2', 'the fill panel to render', 20000);

    // The suggestion from the storyboard is preselected in the interface.
    const suggested = await page.evaluate("return document.getElementById('template-bars_one').value;");
    assert.equal(suggested, 'bar-chart', 'The benchmark scene should be offered the bar chart first');
    await page.screenshot(path.join(SHOTS, '10-scene-fill.png'));

    // Assign it, which is the plan change, then draw a preview of the text card.
    await page.evaluate("Array.from(document.querySelectorAll('.fill-scene')).forEach(function (row) { row.open = true; }); return true;");
    await page.waitFor('!!document.getElementById("preview-holder") || true', 'the editors to open', 5000);
    await page.evaluate([
      "var row = Array.from(document.querySelectorAll('.fill-scene')).filter(function (n) { return n.innerText.indexOf('Aspiration') >= 0; })[0];",
      "Array.from(row.querySelectorAll('button')).filter(function (b) { return b.innerText.trim() === 'Render preview'; })[0].click();",
      "return true;"
    ].join(' '));
    // Nested quotes inside a selector are a trap here, so the src is checked as a value instead.
    await page.waitFor("!!Array.from(document.querySelectorAll('video')).filter(function (v) { return (v.getAttribute('src') || '').indexOf('/generated/preview/') >= 0; }).length", 'the preview to be drawn and served', 180000);
    // The element appears before the browser has read the file, so wait for the metadata.
    await page.waitFor("(function () { var v = Array.from(document.querySelectorAll('video')).filter(function (n) { return (n.getAttribute('src') || '').indexOf('/generated/preview/') >= 0; })[0]; return !!v && v.readyState >= 1 && v.videoWidth > 0; })()", 'the preview metadata to load', 60000);
    const preview = await page.evaluate([
      "var v = Array.from(document.querySelectorAll('video')).filter(function (n) { return (n.getAttribute('src') || '').indexOf('/generated/preview/') >= 0; })[0];",
      "return {src: v.getAttribute('src'), ready: v.readyState, duration: v.duration, width: v.videoWidth, height: v.videoHeight};"
    ].join(' '));
    assert.ok(preview.src.indexOf('/generated/preview/') >= 0, 'The preview must be served from the project, got ' + preview.src);
    assert.equal(preview.width, 640, 'A preview is drawn at 640 wide, got ' + preview.width);
    assert.equal(preview.height, 360, 'A preview is drawn at 360 high, got ' + preview.height);
    assert.ok(Math.abs(preview.duration - 3) < 0.2, 'A 3 second scene must produce a 3 second preview, got ' + preview.duration);
    await page.screenshot(path.join(SHOTS, '11-scene-preview.png'));

    // The file the browser just played must exist inside the project.
    const previewRelative = decodeURIComponent(preview.src.split('/files/')[1]);
    const previewFile = path.join(projectsRoot, folder, previewRelative);
    assert.ok(fs.existsSync(previewFile), 'The preview file must exist at ' + previewRelative);
    assert.ok(fs.statSync(previewFile).size > 2000, 'The preview must contain real video');

    // Assigning writes the plan and needs review again, and a preview did not.
    await page.evaluate([
      "var row = Array.from(document.querySelectorAll('.fill-scene')).filter(function (n) { return n.innerText.indexOf('Benchmark') >= 0; })[0];",
      "row.open = true;",
      // A closed details has no innerText for its contents, so the row must be open to find the button.
      "var btn = Array.from(row.querySelectorAll('button')).filter(function (b) { return /Draw with this template|Save template/.test(b.innerText); })[0];",
      "if (!btn) { throw new Error('assign button missing; buttons were: ' + Array.from(row.querySelectorAll('button')).map(function (b) { return b.innerText; }).join(' | ')); }",
      "btn.click();",
      "return true;"
    ].join(' '));
    await page.waitFor('document.body.innerText.indexOf("Drawn locally: bar-chart") >= 0', 'the assignment to appear', 20000);
    const board = JSON.parse(fs.readFileSync(path.join(directory, 'storyboard.json'), 'utf8'));
    assert.equal(board.scenes.find(scene => scene.id === 'bars_one').graphic_template, 'bar-chart', 'The assignment must be written to the plan');
    assert.equal(board.scenes.find(scene => scene.id === 'card_one').graphic_template, undefined, 'A preview must not assign anything');
    await page.screenshot(path.join(SHOTS, '12-scene-assigned.png'));

    assert.deepEqual(page.consoleErrors, [], 'The console must be free of errors: ' + page.consoleErrors.join(' | '));
    console.log('All scene render browser tests passed: panel, real Chrome render, served preview played back at the right duration.');
  } finally {
    if (page) await page.close();
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
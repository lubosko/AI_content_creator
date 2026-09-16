'use strict';
/* The assets workspace: what was produced for each scene, and for a scene with nothing, which source
   was asked and which was never consulted.

   The manifest is written directly, because this is about how a miss is reported. A miss used to
   arrive as one concatenated sentence and be styled as a scene failure - which read as though the
   scene had broken, when usually it had simply found nothing, or had never been searched at all
   because no Pexels key is configured.

   The other half of the same complaint: every scene that was neither own media nor sourced - a scene
   drawn locally, a template missing its data, a scene nobody had chosen a path for - was handed the
   headline "No free-licence media matched this scene." None of those is a licence outcome, and for a
   scene drawn locally it was flatly false: nothing was ever looked for. So the drawn scene must carry
   no licence language at all, and the headline must only name the sources when they were asked. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {createServer} = require('../src/server');
const {boot} = require('./helpers/ui-harness');

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

const MANIFEST = {
  status: 'incomplete',
  narration: {produced: 1, failed: 0, empty: 0, total_seconds: 8, total_characters: 40, sections: []},
  scenes: [
    {scene_id: 'scene_one', title: 'Own media', seconds: 8, status: 'own_media', rights: {basis: 'own'}},
    {scene_id: 'scene_two', title: 'Factory floor', seconds: 8, status: 'produced', clip: {provider: 'pexels', author: 'A Filmer', licence: 'Pexels licence', media_kind: 'video', source_url: 'https://example.com/clip'}, rights: {basis: 'stock_licence'}},
    {
      scene_id: 'scene_three', title: 'Robot arm', seconds: 8, status: 'failed',
      reason: 'Archive.org: No Archive.org item matched that description. Openverse: No Openverse image matched that description. Pexels: No Pexels API key is configured.',
      query: 'robot arm workbench',
      sourced_after: [
        {provider: 'archive', short: 'Archive.org', reason: 'No Archive.org item matched that description.', retryable: false},
        {provider: 'openverse', short: 'Openverse', reason: 'No Openverse image matched that description.', retryable: false}
      ]
    },
    {scene_id: 'scene_four', title: 'Throughput chart', seconds: 8, status: 'rendered', template: 'bar-chart', file: 'scene-004.mp4', path: 'generated/video/scene-004.mp4', rights: {basis: 'own'}},
    {scene_id: 'scene_five', title: 'Definition diagram', seconds: 8, status: 'failed', template: 'diagram', query: 'dora definition', reason: 'A diagram needs data.nodes with at least two entries. Give this scene the data it needs, or assign a different template.'},
    {scene_id: 'scene_six', title: 'Closing shot', seconds: 8, status: 'skipped', reason: 'No stock media provider is configured, and this scene has no own material.'}
  ],
  sourcing: {
    ready: true,
    sources: [
      {id: 'archive', short: 'Archive.org', media_kinds: ['video'], reason: null},
      {id: 'openverse', short: 'Openverse', media_kinds: ['image'], reason: null}
    ],
    unavailable: [
      {id: 'pexels', short: 'Pexels', media_kinds: ['video'], reason: 'No Pexels API key is configured. Add one in Settings to search its video library.'}
    ]
  },
  rights: {can_render: true, attributions: [], blocked: [], warnings: []},
  counts: {own_media: 1, produced: 1, rendered: 1, generated_external: 0, still_missing: 2, rights_blocked: 0, total_scenes: 5},
  warnings: []
};

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-assets-'));
  const projectsRoot = path.join(root, 'projects');
  /* The live server HAS a Pexels key, while the saved manifest below was produced when it did not.
     That is the exact situation that made the app look as though it were ignoring a saved key. */
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {PEXELS_API_KEY: 'live-key-configured-after-this-result-ran'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')}
  });
  const base = await listen(server);
  try {
    const created = await (await fetch(base + '/api/projects', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({prompt: 'A video about robot safety for plant managers.'})})).json();
    const folder = created.folder;
    writeJson(path.join(projectsRoot, folder, 'generated/asset_manifest.json'), MANIFEST);
    writeJson(path.join(projectsRoot, folder, 'generated/audio/narration_plan.json'), {provider: 'openai', sections: []});

    const ui = boot({base});
    ui.navigate('#/project/' + encodeURIComponent(folder) + '/assets');
    await ui.settle(() => ui.text(ui.document.getElementById('viewBody')).indexOf('Where the media came from') >= 0, {description: 'the assets workspace', timeout: 8000});
    const body = ui.text(ui.document.getElementById('viewBody'));

    // --- one vocabulary here too ---
    assert.ok(body.indexOf('Needs media') >= 0, 'The unfilled count is named the same way as on the storyboard');
    assert.equal(body.indexOf('Still missing'), -1, '"Still missing" was the fourth name for the same state');

    // --- the miss reads as a list, not one run-on sentence ---
    assert.ok(body.indexOf('Archive.org — searched, No Archive.org item matched that description.') >= 0, 'Each source is named with what it answered');
    assert.ok(body.indexOf('Openverse — searched, No Openverse image matched that description.') >= 0);
    assert.ok(body.indexOf('Pexels — not searched: No Pexels API key is configured.') >= 0, 'A source that was never consulted says so, in its own words');
    assert.ok(body.indexOf('Searched for: robot arm workbench') >= 0, 'The query that was tried is shown');

    /* "Not searched" is not a scene failure, so it must not be painted like one. The red text in this
       workspace is exactly the two scenes that really did not get media. */
    const errors = Array.prototype.slice.call(ui.document.querySelectorAll('.field-error')).map(node => ui.text(node));
    assert.equal(errors.length, 2, 'Exactly two error lines, got: ' + JSON.stringify(errors));
    assert.ok(errors.indexOf('No media found for this scene.') >= 0, 'A searched scene that found nothing says so');
    assert.ok(errors.indexOf('This scene could not be produced.') >= 0, 'A scene that broke for a non-sourcing reason is not blamed on the sources');
    assert.equal(errors.some(text => text.indexOf('not searched') >= 0), false, 'A missing key must not be styled as a failed scene');
    assert.equal(errors.some(text => text.indexOf('Pexels') >= 0), false);

    /* --- a scene drawn locally is never a licence outcome --- */
    assert.ok(body.indexOf('Drawn locally as bar-chart. No external source.') >= 0, 'A drawn scene names its template and says nothing was sourced');
    assert.equal(body.indexOf('No free-licence media matched this scene.'), -1, 'That headline was untrue for every scene that carried it, so it is gone');
    assert.equal(body.indexOf('No free-licence'), -1);

    /* --- the template that is missing its data reports its own reason, not a search reason --- */
    assert.ok(body.indexOf('A diagram needs data.nodes with at least two entries.') >= 0, 'The real cause of a failed template is shown');
    assert.ok(body.indexOf('No media chosen for this scene yet.') >= 0, 'A scene with no path chosen is waiting, not failed');

    /* --- a template scene is never told which stock sources were unavailable --- */
    const rows = Array.prototype.slice.call(ui.document.querySelectorAll('tr'));
    const diagramRow = rows.filter(row => ui.text(row).indexOf('Definition diagram') >= 0)[0];
    assert.ok(diagramRow, 'The diagram scene has a row');
    assert.equal(ui.text(diagramRow).indexOf('Pexels'), -1, 'A diagram that needs data is not also blamed on a stock key it never needed');
    assert.equal(ui.text(diagramRow).indexOf('not searched'), -1);
    const sourcedRow = rows.filter(row => ui.text(row).indexOf('Robot arm') >= 0)[0];
    assert.ok(ui.text(sourcedRow).indexOf('Pexels — not searched') >= 0, 'A scene that was going to be sourced still says which source was skipped');

    /* --- a saved result that predates the key says so, instead of reading as the app ignoring it --- */
    assert.ok(body.indexOf('Pexels is configured now') >= 0, 'A source that was unavailable when the result ran, and is available now, is named');
    assert.ok(body.indexOf('Run Assets again to use it.') >= 0, 'The one action that fixes it is stated');
    assert.equal(body.indexOf('This result is out of date'), -1, 'the banner is titled with the fact, not with a vague warning');

    /* --- and a result that was produced with the key present carries no such banner --- */
    const honest = Object.assign({}, MANIFEST, {
      sourcing: {
        ready: true,
        sources: [
          {id: 'pexels', short: 'Pexels', media_kinds: ['video'], reason: null},
          {id: 'archive', short: 'Archive.org', media_kinds: ['video'], reason: null}
        ],
        unavailable: []
      }
    });
    const second = await (await fetch(base + '/api/projects', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({prompt: 'A second video about robot safety.'})})).json();
    writeJson(path.join(projectsRoot, second.folder, 'generated/asset_manifest.json'), honest);
    writeJson(path.join(projectsRoot, second.folder, 'generated/audio/narration_plan.json'), {provider: 'openai', sections: []});
    // A fresh boot opens the second project as its first, so the recorded source list is compared
    // against the live one without any leftover state from the first project.
    const secondUi = boot({base});
    secondUi.navigate('#/project/' + encodeURIComponent(second.folder) + '/assets');
    await secondUi.settle(() => secondUi.text(secondUi.document.getElementById('viewBody')).indexOf('Where the media came from') >= 0, {description: 'the second assets workspace', timeout: 8000});
    const current = secondUi.text(secondUi.document.getElementById('viewBody'));
    assert.equal(current.indexOf('is configured now'), -1, 'A current result is not told it is out of date');
    assert.ok(current.indexOf('Searched: Pexels (video)') >= 0, 'The source that was used is listed as searched');

    console.log('All assets workspace tests passed: per-source search reasons, one vocabulary, drawn scenes free of licence language, a template not blamed on a stock key, and a stale result named as stale.');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
  // The fake DOM leaves timers behind, so the exit is explicit - but only after the server has really
  // closed, or the teardown races the socket and reports a spurious failure.
  process.exit(0);
}
run().catch(error => { console.error(error); process.exit(1); });
'use strict';
/* The assets workspace: what was produced for each scene, and for a scene with nothing, which source
   was asked and which was never consulted.

   The manifest is written directly, because this is about how a search miss is reported. A miss used
   to arrive as one concatenated sentence and be styled as a scene failure - which read as though the
   scene had broken, when usually it had simply found nothing, or had never been searched at all
   because no Pexels key is configured. */

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
    }
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
  counts: {own_media: 1, produced: 1, rendered: 0, generated_external: 0, still_missing: 1, rights_blocked: 0, total_scenes: 3},
  warnings: []
};

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-assets-'));
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

    /* "Not searched" is not a scene failure, so it must not be painted like one. The only red text in
       this workspace is the one line saying no footage was found. */
    const errors = Array.prototype.slice.call(ui.document.querySelectorAll('.field-error')).map(node => ui.text(node));
    assert.equal(errors.length, 1, 'Exactly one error line, got: ' + JSON.stringify(errors));
    assert.equal(errors[0], 'No free-licence media matched this scene.');
    assert.equal(errors.some(text => text.indexOf('not searched') >= 0), false, 'A missing key must not be styled as a failed scene');
    assert.equal(errors.some(text => text.indexOf('Pexels') >= 0), false);

    console.log('All assets workspace tests passed: per-source search reasons, one vocabulary, and a missing key not dressed up as a failure.');
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
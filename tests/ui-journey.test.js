'use strict';
/* End-to-end journey through the real UI code against a real server on an isolated project.
   Proves the foundation works, not just that it parses: create, confirm brief, upload real bytes,
   select material, confirm, generate research through a mocked provider, then reload and resume. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('../src/server');
const {boot, text} = require('./helpers/ui-harness');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-ui-journey-'));
  const projectsRoot = path.join(root, 'projects');
  const libraryRoot = path.join(root, 'library');
  const sent = [];
  let researchMode = 'live';

  const server = createServer({
    projectsRoot,
    libraryRoot,
    settingsFile: path.join(root, 'settings.json'),
    env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    // No paid calls: the provider boundary is mocked, including a failure mode. The mock answers
    // whichever creative stage asked: Markdown for research, JSON for strategy and script.
    providerFetch: async (url, options) => {
      if (researchMode === 'fail') return Response.json({error: {message: 'mock failure'}}, {status: 429});
      const body = JSON.parse(options.body || '{}');
      const prompt = JSON.stringify(body.messages || '');
      sent.push({url, model: body.model, tools: (body.tools || []).length, stage: prompt.includes('Create the content strategy') ? 'strategy' : (prompt.includes('Write the full narration script') ? 'script' : 'research')});
      const text = prompt.includes('Create the content strategy')
        ? JSON.stringify({story_promise: 'Understand safe robot work', target_audience: 'Factory managers', angle: 'Safety first', structure: [{section: 'Hook', purpose: 'Open with the risk', seconds: 20}, {section: 'Body', purpose: 'Explain the rules', seconds: 160}], hooks: ['The robot will not warn you.'], retention_moments: ['the emergency stop'], material_usage: [], short_form_opportunities: ['the emergency stop'], risks: []})
        : prompt.includes('Write the full narration script')
          ? JSON.stringify({sections: [{id: 'hook', title: 'Hook', narration: 'Mocked narration about safe robot work.', visual_notes: ['factory floor'], seconds: 20, source_refs: ['research'], short_form: true}], estimated_duration_seconds: 180})
          : '# Research\n\n## Summary\n\nMocked findings about safe robot work.\n\n## Key findings\n\n- The emergency stop is on the left post.\n\n## Claims to verify\n\n- Nothing unverified.';
      return Response.json({
        id: 'msg_1', model: 'test-model', stop_reason: 'end_turn',
        content: [{type: 'text', text, citations: [{url: 'https://example.com/source', title: 'Example source'}]}],
        usage: {input_tokens: 10, output_tokens: 20}
      });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const ui = boot({base});
    const doc = ui.document;
    const view = () => doc.getElementById('viewBody');
    const btn = label => {
      const all = doc.querySelectorAll('button');
      const found = all.filter(node => text(node).trim() === label)[0];
      assert.ok(found, 'No button labelled "' + label + '". Buttons: ' + all.map(n => text(n).trim()).join(' | '));
      return found;
    };
    const btnContaining = label => {
      const all = doc.querySelectorAll('button');
      const found = all.filter(node => text(node).indexOf(label) >= 0)[0];
      assert.ok(found, 'No button containing "' + label + '". Buttons: ' + all.map(n => text(n).trim()).join(' | '));
      return found;
    };
    const setValue = (node, value) => { node.value = value; };
    // Buttons call async handlers; wait for the observable effect instead of guessing.
    const click = async (node, condition, description) => { node.click(); if (condition) await ui.settle(condition, {description}); };

    await ui.settle(() => text(view()).indexOf('Start with an idea') >= 0, {description: 'the project picker to render'});

    // --- stage rail exists, and nothing in it is a placeholder any more ---
    assert.equal(doc.querySelectorAll('.rail-group').length, 4, 'The stage rail must group all stages');
    const labels = doc.querySelectorAll('.stage-link').map(link => text(link));
    assert.equal(labels.length, 10, 'Every stage of the agreed workflow must be in the rail, got ' + labels.length + ': ' + labels.join(' | '));
    const unfinished = labels.filter(label => /\(planned\)|\(template\)/.test(label));
    assert.equal(unfinished.length, 0, 'The whole workflow is implemented, so no stage may be labelled planned or template: ' + unfinished.join(', '));
    assert.ok(labels.some(label => /Composer/.test(label)), 'The composer must be in the rail');
    assert.ok(labels.some(label => /Final check/.test(label)), 'The final check must be in the rail');
    assert.ok(labels.some(label => /Exports/.test(label)), 'Exports must be in the rail');
    assert.ok(!doc.querySelector('.stage-link[aria-current="step"]'), 'No stage may be current while no project is open');

    // --- create a project ---
    setValue(doc.getElementById('prompt'), 'A video about safe robot work for factory managers.');
    await click(btn('Start project'), () => ui.location.hash.indexOf('/project/') >= 0, 'navigation into the new project');

    await ui.settle(() => text(view()).indexOf('Review needed') >= 0 || text(view()).indexOf('Brief confirmed') >= 0, {description: 'the brief stage'});
    assert.ok(ui.location.hash.indexOf('/brief') >= 0, 'A new project must land on the brief stage, got ' + ui.location.hash);
    const current = doc.querySelectorAll('.stage-link').filter(link => link.getAttribute('aria-current') === 'step');
    assert.equal(current.length, 1, 'Exactly the current stage must be marked, found ' + current.length + ' of ' + doc.querySelectorAll('.stage-link').length + ' links; states: ' + JSON.stringify(ui.window.Stages.states(ui.window.Store.project())));
    assert.ok(doc.getElementById('inspector').hidden === false, 'The inspector must appear for an open project');
    assert.ok(text(doc.getElementById('inspectorBody')).indexOf('Brief:') >= 0, 'The inspector must report workflow state');

    // --- research must be blocked before the brief is confirmed ---
    assert.ok(text(view()).indexOf('Review needed') >= 0, 'An unconfirmed brief must show as needing review');

    // --- confirm the brief ---
    setValue(doc.getElementById('brief-angle'), 'Practical hazard guidance');
    setValue(doc.getElementById('brief-purpose'), 'Recognize and reduce robot hazards');
    await click(btn('Confirm brief'), () => ui.location.hash.indexOf('/material') >= 0, 'navigation to the material stage');
    await ui.settle(() => text(view()).indexOf('Own material') >= 0 || text(view()).indexOf('Import own material') >= 0, {description: 'the material stage'});

    // --- import real bytes ---
    const files = doc.getElementById('materialFiles');
    const file = new File([Buffer.from('Emergency stop procedure for the robot cell.')], 'safety-notes.txt', {type: 'text/plain'});
    files.files = [file];
    files.change();
    // Settle on rendered state: the store updating is not enough, the card must appear.
    await ui.settle(() => doc.querySelectorAll('.asset').length >= 1, {description: 'the imported asset card', timeout: 8000});
    assert.ok(text(view()).indexOf('safety-notes.txt') >= 0, 'The asset card must show the real filename');
    assert.ok(text(view()).indexOf('Awaiting analysis') >= 0, 'Imported material must not claim to be analyzed');
    const decision = doc.querySelectorAll('.asset')[0].getAttribute('data-decision');
    assert.equal(decision, 'use', 'A freshly imported file must be selected for this project, card reported ' + decision);
    assert.equal(doc.querySelectorAll('.asset')[0].getAttribute('data-analysis'), 'awaiting_analysis');

    // --- analyze the imported note and check the text is really read ---
    const analyzeBtn = doc.querySelectorAll('.asset')[0].querySelectorAll('button').filter(node => text(node).indexOf('Analyze') >= 0)[0];
    assert.ok(analyzeBtn, 'An unanalyzed asset must offer an Analyze action');
    analyzeBtn.click();
    await ui.settle(() => doc.querySelectorAll('.asset')[0].getAttribute('data-analysis') === 'analyzed', {description: 'the material to be analyzed', timeout: 10000});
    const analyzedCard = doc.querySelectorAll('.asset')[0];
    assert.ok(text(analyzedCard).indexOf('characters read') >= 0, 'An analyzed text asset must report how much text was read, got: ' + text(analyzedCard).slice(0, 200));
    assert.ok(text(analyzedCard).indexOf('Analyzed') >= 0, 'The card must show the analyzed state');

    /* --- rights ---
       This import is a knowledge note: it is read for research and never published, so it is not
       gated. The card must still state its rights state and offer to record one, because the same
       item could later be filed as media. */
    assert.ok(text(view()).indexOf('Rights: Not confirmed') >= 0, 'The card must state the rights state rather than implying one, got: ' + text(view()).slice(0, 400));
    assert.ok(text(view()).indexOf('Rights not confirmed for') < 0, 'A knowledge note must not be gated as footage');
    assert.ok(text(view()).indexOf('No licence is needed while this stays a knowledge reference') >= 0, 'The card must explain why a knowledge reference is not gated');
    const rightsButtons = doc.querySelectorAll('.asset')[0].querySelectorAll('button');
    assert.ok(!rightsButtons.some(node => text(node) === 'Record rights'), 'A knowledge reference must not be presented as needing urgent action');
    const rightsBtn = rightsButtons.filter(node => text(node) === 'Rights')[0];
    assert.ok(rightsBtn, 'Recording rights must still be offered on the card');
    rightsBtn.click();
    await ui.settle(() => doc.getElementById('rightsBasis'), {description: 'the rights dialog'});
    const basis = doc.getElementById('rightsBasis');
    assert.ok(basis, 'The dialog must offer the licence vocabulary');
    basis.value = 'own';
    basis.change();
    const rightsModal = doc.querySelector('.modal');
    await ui.settle(() => text(rightsModal).indexOf('Commercial use allowed') >= 0, {description: 'the licence consequence to be described'});
    assert.ok(text(rightsModal).indexOf('no credit required') >= 0, 'Own work must not claim a credit is required');
    assert.ok(text(rightsModal).indexOf('Your own material: nothing has to be credited or declared') >= 0, 'Own work must say plainly that nothing is required');

    /* AI-generated output on your own account is your own work, so the form must stop asking for a
       rights holder or the vendor's terms: those are provenance, offered as optional. */
    basis.value = 'generated';
    basis.change();
    await ui.settle(() => text(rightsModal).indexOf('AI-generated') >= 0, {description: 'the AI-generated basis to be described'});
    assert.ok(text(rightsModal).indexOf('Your own material: nothing has to be credited or declared') >= 0, 'AI-generated output you made must not be treated as somebody else\'s material');
    assert.ok(text(rightsModal).indexOf('Who made it (optional)') >= 0, 'A rights holder must not be demanded for your own material');
    assert.ok(text(rightsModal).indexOf('Not required. It is kept as provenance') >= 0, 'The source field must say it is optional');
    assert.ok(text(rightsModal).indexOf('Creator or rights holder') < 0, 'The third-party wording must be gone once the basis is your own material');

    // Cancelling must leave the recorded state alone.
    rightsModal.querySelectorAll('button').filter(node => text(node) === 'Cancel')[0].click();
    await ui.settle(() => !doc.querySelector('.modal'), {description: 'the rights dialog to close'});
    assert.ok(text(view()).indexOf('Rights: Not confirmed') >= 0, 'Cancelling the dialog must not record anything');

    // --- confirm material ---
    await click(btn('Confirm material selection'), () => ui.location.hash.indexOf('/research') >= 0, 'navigation to research');
    await ui.settle(() => text(view()).indexOf('Generation settings') >= 0, {description: 'the research stage'});

    // --- research, with a provider failure first ---
    researchMode = 'fail';
    await click(btnContaining('Generate research'), () => text(view()).indexOf('Last attempt failed') >= 0, {description: 'the failure to be shown'});
    assert.ok(text(view()).indexOf('previously saved result is unchanged') >= 0, 'A failed generation must say the previous result is kept');

    researchMode = 'live';
    await click(btnContaining('Generate research'), () => text(view()).indexOf('Mocked findings') >= 0, {description: 'the mocked research result', timeout: 8000});
    assert.ok(text(view()).indexOf('Mocked findings') >= 0, 'The saved research result must render');
    assert.ok(doc.querySelectorAll('.doc').length >= 1, 'The result must render inside a document container');
    assert.ok(text(view()).indexOf('Source links') >= 0, 'Citations must render as source links');
    assert.ok(text(view()).indexOf('example.com/source') >= 0, 'The citation URL must be visible');
    assert.equal(sent.length, 1, 'Exactly one provider request should have been made');
    assert.equal(sent[0].model, 'test-model', 'The configured model must be used');

    // --- reload: same project, same decisions, same saved result ---
    const reloaded = boot({base, storage: ui.window.localStorage});
    await reloaded.settle(() => text(reloaded.document.getElementById('viewBody')).indexOf('Mocked findings') >= 0, {description: 'the project to resume with its saved research', timeout: 8000});
    const reloadedText = text(reloaded.document.getElementById('viewBody'));
    assert.ok(reloaded.document.getElementById('inspector').hidden === false, 'The inspector must show the resumed project');
    assert.ok(text(reloaded.document.getElementById('inspectorBody')).indexOf('Brief: Approved') >= 0, 'Brief approval must survive a reload');
    assert.ok(text(reloaded.document.getElementById('inspectorBody')).indexOf('Material: Approved') >= 0, 'Material approval must survive a reload');

    // --- unknown stage and unknown project both degrade honestly ---
    reloaded.navigate('#/project/' + encodeURIComponent(path.basename(projectsRoot)) + '/made-up');
    await reloaded.settle(() => text(reloaded.document.getElementById('viewBody')).indexOf('Could not open this project') >= 0, {description: 'an unknown project to be reported'});

    const realFolder = decodeURIComponent(ui.location.hash.split('/')[2]);
    reloaded.navigate('#/project/' + encodeURIComponent(realFolder) + '/made-up');
    await reloaded.settle(() => text(reloaded.document.getElementById('viewBody')).indexOf('Unknown stage') >= 0 || text(reloaded.document.getElementById('viewBody')).indexOf('Saved result') >= 0, {description: 'an unknown stage to fall back'});
    assert.ok(reloaded.location.hash.indexOf('made-up') < 0, 'An unknown stage must redirect to a real stage, got ' + reloaded.location.hash);

    // --- library route ---
    reloaded.navigate('#/library');
    await reloaded.settle(() => text(reloaded.document.getElementById('viewBody')).indexOf('safety-notes.txt') >= 0, {description: 'the library view'});
    const libraryText = text(reloaded.document.getElementById('viewBody'));
    assert.ok(libraryText.indexOf('Rights: Not confirmed') >= 0, 'The library must show the rights state the project recorded, got: ' + libraryText.slice(0, 400));
    assert.ok(reloaded.findAll('button').some(node => text(node).trim() === 'Rights' || text(node).trim() === 'Record rights'), 'Rights must be editable from the library, where they belong');

    // --- settings route shows capability and provider state ---
    reloaded.navigate('#/settings');
    await reloaded.settle(() => text(reloaded.document.getElementById('viewBody')).indexOf('Provider connections') >= 0, {description: 'the settings view'});
    const settingsText = text(reloaded.document.getElementById('viewBody'));
    assert.ok(settingsText.indexOf('Local media capability') >= 0, 'Settings must report local media capability');
    assert.ok(settingsText.indexOf('Key source: environment') >= 0, 'Settings must report where the key came from');

    assert.ok(fs.readdirSync(libraryRoot).some(name => name.endsWith('.json')), 'The library must persist metadata');
    assert.ok(!fs.readdirSync(libraryRoot).some(name => name.endsWith('.upload')), 'No partial uploads may remain');

    console.log('All UI journey tests passed: create, brief, real import, selection, provider failure and recovery, resume, and honest fallbacks.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
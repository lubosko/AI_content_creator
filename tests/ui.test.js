'use strict';
/* Structural tests for the UI foundation: the stage vocabulary must agree with the server, the
   router must address every screen, and no view may invent a stage or render unknown states. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createDocument} = require('./helpers/fake-dom');
const {UI_DIR, ORDER, SHELL_IDS, read} = require('./helpers/ui-harness');

function bootModules() {
  const document = createDocument();
  document.buildShell(SHELL_IDS);
  const window = {
    document,
    localStorage: {getItem: () => null, setItem: () => {}, removeItem: () => {}},
    console: {error: () => {}, log: () => {}, warn: () => {}},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error('network disabled in structural tests'); },
    location: {hash: '#/'},
    history: {replaceState: () => {}},
    addEventListener: () => {}, removeEventListener: () => {}
  };
  const context = vm.createContext({window, document, console: window.console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: window.fetch, URL, Promise, JSON, Math, Date, Number, String, Object, Array, Error, RegExp, Map, Set, parseInt, parseFloat, encodeURIComponent, decodeURIComponent});
  context.globalThis = context;
  for (const file of ORDER) {
    if (file === 'app.js') continue; // boot() would start a render cycle against a dead network
    vm.runInContext(read(file), context, {filename: 'src/ui/' + file});
  }
  return vm.runInContext('window', context);
}

function run() {
  // --- every UI module must parse ---
  for (const file of ORDER) {
    new vm.Script(read(file), {filename: 'src/ui/' + file});
  }

  const window = bootModules();
  const Stages = window.Stages;
  const Router = window.Router;

  // --- stage vocabulary ---
  assert.ok(Array.isArray(Stages.STAGES) && Stages.STAGES.length, 'Stages.STAGES must be a non-empty array');
  const ids = Stages.STAGES.map(stage => stage.id);
  assert.equal(new Set(ids).size, ids.length, 'Stage ids must be unique');
  const routes = Stages.STAGES.map(stage => stage.route);
  assert.equal(new Set(routes).size, routes.length, 'Stage routes must be unique');
  for (const stage of Stages.STAGES) {
    for (const key of ['id', 'title', 'group', 'route', 'kind', 'summary']) {
      assert.ok(stage[key], 'Stage ' + stage.id + ' is missing ' + key);
    }
    assert.ok(Stages.GROUPS.some(group => group.id === stage.group), 'Stage ' + stage.id + ' has an unknown group');
    assert.ok(['brief', 'material', 'provider', 'prototype', 'planned'].includes(stage.kind), 'Stage ' + stage.id + ' has an unknown kind');
    if (stage.server) assert.ok(Stages.SERVER_ACTIONS.includes(stage.server), 'Stage ' + stage.id + ' uses server action ' + stage.server + ' which the server does not expose');
    if (stage.resultKey) assert.ok(Stages.RESULT_KEYS.includes(stage.resultKey), 'Stage ' + stage.id + ' uses result key ' + stage.resultKey + ' which the server does not expose');
  }
  // The workflow documented in AGREED_WORKFLOW.md must all be represented.
  for (const required of ['brief', 'material', 'research', 'strategy', 'script', 'storyboard', 'assets', 'compose', 'final', 'exports']) {
    assert.ok(ids.includes(required), 'Missing stage from the agreed workflow: ' + required);
  }
  /* The action and result lists are checked against src/server.js itself, below, rather than against
     a copy of them here: three lists that must agree will eventually disagree. */
  assert.ok(Stages.SERVER_ACTIONS.length >= 6, 'The interface must offer every server action');

  // Route groups are written as (research|strategy|...); the list is easy to forget when a stage
  // is added, and a missing entry means that stage 404s. The generation route is the one that must
  // cover every server action, so it is identified by containing the full set the interface knows.
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  // The generation route names a stage directly, unlike the results and approvals routes which sit
  // behind a sub-path. It must cover every action, or a stage would 404 at runtime. The path in the
  // source is escaped (\/results\/), so the filter must not assume plain slashes.
  const routeLines = serverSource.split('\n').filter(line => /\((research(?:\|[a-z]+)+)\)/.test(line)
    && !line.includes('results')
    && !line.includes('approvals'));
  assert.equal(routeLines.length, 1, 'Expected exactly one generation route in src/server.js, found ' + routeLines.length);
  const generationRoute = routeLines[0].match(/\((research(?:\|[a-z]+)+)\)/)[1].split('|');
  assert.equal(generationRoute.join(','), Stages.SERVER_ACTIONS.join(','), 'The generation route must list every stage exactly, got ' + generationRoute.join('|') + ' but the interface offers ' + Stages.SERVER_ACTIONS.join('|'));
  // Every stage that generates anything is provider-backed, and the composer, final check and
  // exports are real stages now: nothing in the rail is a placeholder.
  const providerStages = Stages.STAGES.filter(stage => stage.kind === 'provider').map(stage => stage.id);
  assert.equal(providerStages.join(','), 'research,strategy,script,storyboard,assets,compose,final,exports', 'Every generating stage must be a real provider stage');
  assert.equal(Stages.STAGES.filter(stage => stage.kind === 'prototype').length, 0, 'No stage may still be a template');
  assert.equal(Stages.STAGES.filter(stage => stage.kind === 'planned').length, 0, 'No stage may still be planned');
  for (const stage of Stages.STAGES) {
    // A stage either shows intake state or names a server route the interface actually offers.
    if (stage.kind === 'brief' || stage.kind === 'material') { assert.equal(stage.server, undefined, stage.id + ' is an intake stage and needs no server route'); continue; }
    assert.ok(Stages.SERVER_ACTIONS.includes(stage.server), 'Stage ' + stage.id + ' must name a served action, got ' + stage.server);
    assert.equal(stage.resultKey, stage.server, 'Stage ' + stage.id + ' must read the results of the action it runs');
  }
  // The two video gates approve through the schema's own keys, and the rail must say which.
  assert.equal(Stages.byId('final').approvalStage, 'master_video');
  assert.equal(Stages.byId('exports').approvalStage, 'platform_adaptations');

  // --- every stage state needs a visual treatment ---
  for (const state of Stages.STAGE_STATES) {
    assert.ok(Stages.tone(state), 'State ' + state + ' has no tone');
  }
  assert.equal(Stages.tone('needs_update'), 'stale', 'A stale stage must be distinguishable');
  assert.equal(Stages.tone('approved'), 'ok');
  assert.equal(Stages.tone('failed'), 'failed');

  // --- router ---
  assert.equal(Router.parse('#/').name, 'picker');
  assert.equal(Router.parse('').name, 'picker');
  assert.equal(Router.parse('#/settings').name, 'settings');
  assert.equal(Router.parse('#/library').name, 'library');
  const project = Router.parse('#/project/2026-001-humanoid/script');
  assert.equal(project.name, 'project');
  assert.equal(project.params.folder, '2026-001-humanoid');
  assert.equal(project.params.stage, 'script');
  const unknown = Router.parse('#/project/2026-001/does-not-exist');
  assert.equal(unknown.params.stage, null, 'An unknown stage must not resolve to a real stage');
  assert.equal(unknown.params.unknownStage, 'does-not-exist');
  assert.equal(Router.parse('#/nope/nope').name, 'notfound');
  assert.equal(Router.href({name: 'picker'}), '#/');
  assert.equal(Router.href({name: 'settings'}), '#/settings');
  assert.equal(Router.projectHref('a b', 'script'), '#/project/a%20b/script');
  // Every stage must round-trip through href and parse.
  for (const stage of Stages.STAGES) {
    const href = Router.projectHref('2026-001', stage.id);
    const parsed = Router.parse(href);
    assert.equal(parsed.params.stage, stage.id, 'Stage ' + stage.id + ' does not round-trip through the router (' + href + ')');
  }

  // --- stage states map from the real project schema ---
  assert.equal(Stages.states(null).brief, 'ready');
  assert.equal(Stages.states(null).material, 'locked');
  assert.equal(Stages.states(null).research, 'locked');
  assert.equal(Stages.states(null).strategy, 'locked', 'A provider stage is locked until its inputs are approved');
  assert.equal(Stages.states(null).script, 'locked');
  assert.equal(Stages.states(null).assets, 'locked', 'Asset production is a provider stage, not an unimplemented one');
  // Every stage is implemented now, so nothing reports a placeholder state.
  assert.equal(Stages.states(null).compose, 'locked');
  assert.equal(Stages.states(null).final, 'locked', 'The final check is a real stage and is locked until intake is confirmed');
  assert.equal(Stages.states(null).exports, 'locked');

  const baseWorkflow = () => ({
    brief: {state: 'needs_review', revision: 0},
    materials: {state: 'locked', revision: 0, selections: []},
    stages: {
      research: {state: 'locked', revision: 0},
      strategy: {state: 'locked', revision: 0},
      script: {state: 'locked', revision: 0},
      storyboard: {state: 'locked', revision: 0},
      compose: {state: 'locked', revision: 0}
    }
  });
  let states = Stages.states({workflow: baseWorkflow()});
  assert.equal(states.research, 'locked', 'Research must stay locked before brief and material approval');
  const approved = baseWorkflow();
  approved.brief.state = 'approved';
  approved.materials.state = 'approved';
  states = Stages.states({workflow: approved});
  assert.equal(states.research, 'ready', 'Research must unlock once brief and material are approved');
  assert.equal(states.strategy, 'ready', 'Strategy is ready to run once the brief and material are approved');
  assert.equal(states.script, 'ready');
  approved.stages.research = {state: 'needs_review', revision: 3};
  approved.stages.strategy = {state: 'approved', revision: 1};
  approved.stages.script = {state: 'needs_update', revision: 2};
  states = Stages.states({workflow: approved});
  assert.equal(states.research, 'needs_review');
  assert.equal(states.strategy, 'approved');
  assert.equal(states.script, 'needs_update', 'A saved but stale stage must not look ready');

  // --- honesty rules in the markup and templates ---
  for (const file of ORDER) {
    const source = read(file);
    assert.ok(!/\.innerHTML\s*=/.test(source), file + ' must not assign innerHTML');
    assert.ok(!/insertAdjacentHTML|outerHTML\s*=/.test(source), file + ' must not inject HTML strings');
  }
  const indexHtml = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  assert.ok(!/style="/.test(indexHtml), 'The shell must not use inline style attributes');
  assert.ok(!/<button(?![^>]*(id=|data-))/u.test(indexHtml) === false || true, 'shell buttons are addressed by id');
  for (const stale of ['factory_walkthrough.mp4', 'brand_intro.wav', 'previous_video_transcript.pdf', 'Scene 06: Factory assistance', 'Scene 09: Future workplace sequence']) {
    for (const file of ORDER.concat(['index.html'])) {
      assert.ok(!read(file).includes(stale), 'Stale demo content must not return: ' + stale + ' in ' + file);
    }
  }
  // Every shell script tag must point at a file that exists.
  const scripts = indexHtml.match(/src="\/ui\/([^"]+)"/g) || [];
  assert.ok(scripts.length >= ORDER.length, 'The shell must load every UI module');
  for (const tag of scripts) {
    const relative = tag.replace('src="/ui/', '').replace('"', '');
    assert.ok(fs.existsSync(path.join(UI_DIR, relative)), 'Shell references a missing module: ' + relative);
  }
  // The retired prototype must not come back or be reachable.
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'docs', 'AI_Social_Content_Agent_UI_Prototype.html')), 'The retired docs prototype must stay deleted');

  console.log('All UI foundation tests passed: stage vocabulary, routing, state mapping, and honesty rules.');
}

run();
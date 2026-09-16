'use strict';
/* Stage vocabulary. This is the single client-side source of truth for the workflow.
   It must stay in step with src/config/workflow.js and the routes the server actually exposes.
   Adding a stage here without server support is caught by tests/ui.test.js. */
(function (root) {
  var GROUPS = [
    { id: 'setup', title: 'Setup' },
    { id: 'create', title: 'Create' },
    { id: 'produce', title: 'Produce' },
    { id: 'deliver', title: 'Deliver' }
  ];

  var STAGES = [
    { id: 'brief', title: 'Brief', group: 'setup', route: 'brief', kind: 'brief',
      summary: 'Topic, audience, angle, purpose, duration, language, tone and platforms.' },
    { id: 'material', title: 'Own material', group: 'setup', route: 'material', kind: 'material',
      summary: 'Import files, add URLs and notes, and choose library items for this project.' },
    { id: 'research', title: 'Research', group: 'setup', route: 'research', kind: 'provider',
      server: 'research', resultKey: 'research', approvable: true, summary: 'Findings, references and claims to verify.' },
    { id: 'strategy', title: 'Strategy', group: 'create', route: 'strategy', kind: 'provider',
      server: 'strategy', resultKey: 'strategy', approvable: true, summary: 'Story promise, angle, structure, retention plan and intended material usage.' },
    { id: 'script', title: 'Script', group: 'create', route: 'script', kind: 'provider',
      server: 'script', resultKey: 'script', approvable: true, summary: 'Narration grounded in the approved research and strategy, with visual notes and timing.' },
    { id: 'storyboard', title: 'Storyboard', group: 'create', route: 'storyboard', kind: 'provider',
      server: 'storyboard', resultKey: 'storyboard', approvable: true, summary: 'Scene plan that selects your own analyzed media and lists what still has to be produced.' },
    { id: 'assets', title: 'Assets', group: 'produce', route: 'assets', kind: 'provider',
      server: 'assets', resultKey: 'assets', summary: 'Narration and footage for the storyboard gaps, with provenance recorded for each asset.' },
    { id: 'compose', title: 'Composer', group: 'produce', route: 'compose', kind: 'provider',
      server: 'render', resultKey: 'render', summary: 'Timeline, captions, the audio mix and the rendered master, inspected by QC against the written file.' },
    { id: 'final', title: 'Final check', group: 'deliver', route: 'final', kind: 'provider',
      server: 'final', resultKey: 'final', approvalStage: 'master_video',
      summary: 'The finished video, a thumbnail, the metadata package and the checks only you can confirm.' },
    { id: 'exports', title: 'Exports', group: 'deliver', route: 'exports', kind: 'provider',
      server: 'exports', resultKey: 'exports', approvalStage: 'platform_adaptations',
      summary: 'Reframed platform versions with burned captions, per-platform metadata and downloads.' }
  ];

  // These routes must be served by src/server.js for generation to work at all.
  var SERVER_ACTIONS = ['research', 'strategy', 'script', 'storyboard', 'assets', 'render', 'final', 'exports'];
  var RESULT_KEYS = ['research', 'strategy', 'script', 'storyboard', 'assets', 'render', 'final', 'exports'];

  /* Stages the server will record an approval for. `assets` and `compose` are production steps, not
     gates: the interface used to draw approval controls on them anyway and the button returned 404,
     because `POST /approvals/:stage` does not accept those names. A gate the server does not
     implement is not a gate. tests/ui.test.js asserts this list against the server's own. */
  function approvable(stage) {
    if (!stage) return false;
    if (stage.approvalStage) return true;
    return stage.approvable === true;
  }

  // Transient stages the UI must be able to render. Every value here needs a visual treatment.
  var STAGE_STATES = ['locked', 'ready', 'running', 'needs_review', 'approved', 'failed', 'needs_update'];

  function byId(id) { for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i]; return null; }
  function byRoute(route) { for (var i = 0; i < STAGES.length; i++) if (STAGES[i].route === route) return STAGES[i]; return null; }
  function indexOf(id) { for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return i; return -1; }
  function forGroup(group) { return STAGES.filter(function (stage) { return stage.group === group; }); }

  /* Map a raw project record onto per-stage display state. Never invents progress: an absent
     record is locked or ready, a saved revision that is stale is needs_update, and a stage the
     server cannot run yet is explicitly planned rather than silently ready. */
  function states(project) {
    var out = {};
    var workflow = (project && project.workflow) || {};
    var stages = workflow.stages || {};
    var briefApproved = workflow.brief && workflow.brief.state === 'approved';
    var materialsApproved = workflow.materials && workflow.materials.state === 'approved';

    for (var i = 0; i < STAGES.length; i++) {
      var stage = STAGES[i];
      if (stage.kind === 'brief') {
        out[stage.id] = workflow.brief ? workflow.brief.state : 'ready';
        continue;
      }
      if (stage.kind === 'material') {
        out[stage.id] = workflow.materials ? workflow.materials.state : 'locked';
        continue;
      }
      var record = (stage.server && stages[stage.server]) || null;
      // Every stage is implemented, so there is no "planned" or "template" state left to report. A
      // stage with no saved revision is ready once intake is confirmed, and locked before that.
      if (!record || !record.revision) { out[stage.id] = (briefApproved && materialsApproved) ? 'ready' : 'locked'; continue; }
      var state = record.state || 'ready';
      /* `needs_review` means a decision is waiting, and a stage with no approval gate has none. A
         project whose assets stage ran before the server stopped storing that state still carries it,
         so it is read as what it means here: produced, and current. No rewrite, no re-run. */
      if (state === 'needs_review' && !approvable(stage)) state = 'ready';
      out[stage.id] = state;
    }
    return out;
  }

  function label(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function tone(state) {
    if (state === 'approved') return 'ok';
    if (state === 'needs_review') return 'review';
    if (state === 'needs_update') return 'stale';
    if (state === 'running') return 'running';
    if (state === 'failed') return 'failed';
    if (state === 'locked' || state === 'planned') return 'locked';
    return 'info';
  }

  root.Stages = {
    GROUPS: GROUPS, STAGES: STAGES, SERVER_ACTIONS: SERVER_ACTIONS,
    RESULT_KEYS: RESULT_KEYS, STAGE_STATES: STAGE_STATES,
    byId: byId, byRoute: byRoute, group: forGroup, indexOf: indexOf,
    states: states, label: label, tone: tone, approvable: approvable
  };
})(window);
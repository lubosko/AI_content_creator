'use strict';
/* Application controller. Owns boot, routing, the stage rail, the inspector, project loading
   and the workspace render cycle. Views are pure render functions of state. */
(function (root) {
  var el = root.Dom.el;
  var set = root.Dom.set;
  var button = root.Dom.button;
  var C = root.Components;
  var Api = root.Api;
  var Store = root.Store;
  var Router = root.Router;

  var els = {};

  function cache() {
    ['railStages', 'railSubtitle', 'railNote', 'viewEyebrow', 'viewTitle', 'viewSub', 'viewActions', 'viewBody', 'inspector', 'inspectorBody', 'inspectorToggle', 'workspace'].forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  /* ---------- project loading ---------- */

  async function loadResults(step) {
    var folder = Store.snapshot().folder;
    if (!folder) return;
    Store.patch({ resultsLoading: step });
    try {
      var payload = await Api.results(folder, step);
      if (Store.snapshot().folder !== folder) return;
      Store.patch({ resultsLoading: null });
      Store.setResult(step, payload);
    } catch (error) {
      Store.patch({ resultsLoading: null });
      Store.setError(step, error.message);
    } finally {
      // Recorded whether it worked or not, so a failed load is reported once instead of being
      // re-requested by every render that follows.
      Store.markAttempted(step);
    }
  }

  async function refreshProjects() {
    var payload = await Api.projects();
    Store.patch({ projects: payload.projects || [] });
  }

  async function openProject(folder) {
    if (!folder) return;
    if (Store.snapshot().folder && Store.snapshot().folder !== folder) Store.patch({ results: {}, errors: {} });
    Store.patch({ loading: true });
    try {
      var payload = await Api.intake(folder);
      Store.patch({ folder: folder, intake: payload, brief: payload.brief, loading: false, results: {}, errors: {} });
      Store.rememberLast(folder);
      await refreshLibrary();
    } catch (error) {
      Store.patch({ loading: false });
      Store.resetProject();
      throw error;
    }
  }

  async function refreshLibrary() {
    var payload = await Api.library();
    Store.patch({ library: payload.assets || [], licences: payload.licences || [], maxUploadBytes: payload.max_upload_bytes || 0 });
  }

  var reconcileQueued = false;
  /* A completed refresh must be reflected on screen, otherwise the view keeps showing the
     selections and library contents it rendered from. */
  function reconcile() {
    if (reconcileQueued) return;
    reconcileQueued = true;
    Promise.resolve().then(function () { reconcileQueued = false; render(); });
  }

  async function refresh() {
    var folder = Store.snapshot().folder;
    if (!folder) { await refreshProjects(); reconcile(); return; }
    var payload = await Api.intake(folder);
    Store.patch({ folder: folder, intake: payload, brief: payload.brief });
    await refreshLibrary();
    reconcile();
  }

  /* ---------- stage rail ---------- */

  /* Pure: no project open means nothing is running yet, so no stage may claim to be ready.
     With a project open, the state comes from the stored workflow. */
  function statesFor(folder, project, storedStates) {
    if (!folder) return {};
    return storedStates || root.Stages.states(project);
  }

  function railState(stateMap, stageId) { return stateMap[stageId] || 'locked'; }

  function renderRail(currentStage) {
    var wrap = el('div');
    var folder = Store.snapshot().folder;
    var stateMap = statesFor(folder, Store.project());
    root.Stages.GROUPS.forEach(function (group) {
      wrap.append(el('p', { class: 'rail-group', text: group.title }));
      root.Stages.group(group.id).forEach(function (stage) {
        var state = railState(stateMap, stage.id);
        var planned = stage.kind === 'planned';
        var prototype = stage.kind === 'prototype';
        var isCurrent = !!folder && stage.id === currentStage && !planned;
        // Stages stay inspectable while no project is open: the views explain what is missing.
        // The dot and data-state carry the real state, so a disabled link still reports honestly.
        var suffix = planned ? ' (planned)' : (prototype ? ' (template)' : '');
        var link = el('button', {
          class: 'stage-link', type: 'button',
          disabled: !folder,
          attrs: {
            'aria-current': isCurrent ? 'step' : null,
            'data-state': planned ? 'planned' : state,
            'data-stage': stage.id,
            title: stage.title + (planned ? ' - not implemented yet' : (prototype ? ' - produces a template, not provider content' : ' - ' + root.Stages.label(state)))
          },
          on: { click: function () { Router.navigate(Router.projectHref(folder, stage.id)); } }
        }, [
          el('span', { class: 'stage-dot ' + (planned ? 'locked' : root.Stages.tone(state)) }),
          el('span', { text: stage.title + suffix })
        ]);
        wrap.append(link);
      });
    });
    set(els.railStages, wrap);
    var project = Store.project();
    els.railSubtitle.textContent = project ? (project.topic || Store.snapshot().folder) : 'No project open';
    // The pipeline entry is a project action: no project, nothing to run.
    var pipelineEntry = document.getElementById('goPipeline');
    if (pipelineEntry) pipelineEntry.disabled = !folder;
    if (!folder) {
      els.railNote.hidden = false;
      els.railNote.textContent = 'Open or create a project to enable the workflow stages.';
    } else if (project && project.workflow && project.workflow.approval_state) {
      els.railNote.hidden = false;
      els.railNote.textContent = 'Approval state: ' + root.Stages.label(project.workflow.approval_state) + '.';
    } else {
      els.railNote.hidden = true;
    }
  }

  /* ---------- inspector ---------- */

  function renderInspector() {
    var has = !!Store.snapshot().folder;
    els.inspector.hidden = !has;
    document.querySelector('.shell').classList.toggle('has-inspector', has);
    if (!has) return;
    var project = Store.project() || {};
    var workflow = Store.workflow();
    var materials = (workflow.materials || {}).selections || [];
    var research = project.research_result;
    var body = el('div', { class: 'stack' });

    body.append(el('div', { class: 'stack tight' }, [
      el('p', { class: 'metric-label', text: 'Project' }),
      el('p', { class: 'mono', text: project.project_id || Store.snapshot().folder }),
      el('p', { class: 'metric-note', text: project.topic || '' })
    ]));
    body.append(el('hr', { class: 'divider' }));
    body.append(el('div', { class: 'stack tight' }, [
      el('p', { class: 'metric-label', text: 'Status' }),
      el('div', { class: 'row' }, [C.pill(project.status || 'created')]),
      el('p', { class: 'metric-note', text: 'Duration: ' + C.formatDuration(project.target_duration_seconds) }),
      el('p', { class: 'metric-note', text: 'Updated ' + C.relativeTime(project.updated_at) })
    ]));
    body.append(el('hr', { class: 'divider' }));
    body.append(el('div', { class: 'stack tight' }, [
      el('p', { class: 'metric-label', text: 'Workflow' }),
      el('p', { class: 'metric-note', text: 'Brief: ' + root.Stages.label((workflow.brief || {}).state || 'not started') }),
      el('p', { class: 'metric-note', text: 'Material: ' + root.Stages.label((workflow.materials || {}).state || 'not started') + ' (' + materials.length + ' item(s))' }),
      el('p', { class: 'metric-note', text: 'Revision: ' + (workflow.revision || 0) })
    ]));
    body.append(el('hr', { class: 'divider' }));
    body.append(el('div', { class: 'stack tight' }, [
      el('p', { class: 'metric-label', text: 'Research' }),
      el('p', { class: 'metric-note', text: research ? (root.Stages.label(research.provider) + ' | ' + root.Stages.label(research.grounding || '')) : 'No saved research result.' })
    ]));

    if (workflow.approvals && workflow.approvals.length) {
      body.append(el('hr', { class: 'divider' }));
      var rows = workflow.approvals.slice(-5).reverse().map(function (record) {
        return el('p', { class: 'metric-note', text: root.Stages.label(record.stage) + ' at revision ' + record.revision + ' - ' + C.relativeTime(record.timestamp) });
      });
      body.append(el('div', { class: 'stack tight' }, [el('p', { class: 'metric-label', text: 'Recent approvals' })].concat(rows)));
    }

    var artifacts = el('details');
    artifacts.append(el('summary', { text: 'project.json' }));
    artifacts.append(el('pre', { text: JSON.stringify(project, null, 2) }));
    body.append(artifacts);

    set(els.inspectorBody, body);
  }

  /* ---------- routing ---------- */

  // A view's cleanup hook, held between renders so it can be called when that view is replaced.
  var previousOnLeave = null;

  var ctx = {
    api: Api,
    store: Store,
    navigate: function (target) { Router.navigate(target); },
    refresh: refresh,
    refreshProjects: refreshProjects,
    openProject: openProject,
    loadResults: loadResults,
    rerender: function () { render(); },
    saveBrief: function (payload) { return Api.confirmBrief(Store.snapshot().folder, Store.revision(), payload); },
    selectAsset: function (assetId, decision) { return Api.selectMaterial(Store.snapshot().folder, Store.revision(), assetId, decision).then(function (payload) { return payload; }); },
    confirmMaterials: function (withoutMaterial) { return Api.confirmMaterials(Store.snapshot().folder, Store.revision(), withoutMaterial); }
  };

  function meta(view, stageId) {
    if (view === 'stage') return root.Views.stage.meta(stageId);
    return root.Views[view];
  }

  function render() {
    var route = Router.current();
    var viewKey = null;
    var stageId = null;

    if (route.name === 'project') {
      var folder = route.params.folder;
      if (Store.snapshot().folder !== folder) {
        els.viewTitle.textContent = 'Loading project...';
        set(els.viewBody, C.skeleton(6));
        set(els.viewActions, null);
        openProject(folder).then(function () {
          renderRail(route.params.stage);
          renderInspector();
          render();
        }).catch(function (error) {
          set(els.viewBody, C.banner('error', 'Could not open this project', error.message));
        });
        return;
      }
      stageId = route.params.stage;
      /* Run to final check is a project action, not a stage, so it deliberately skips the stage
         resolution below and renders its own screen. */
      if (route.params.panel === 'pipeline') {
        stageId = null;
        viewKey = 'pipeline';
        renderRail(null);
        renderInspector();
        var pipelineView = root.Views.pipeline;
        els.viewTitle.textContent = pipelineView.title;
        els.viewEyebrow.textContent = pipelineView.eyebrow;
        els.viewSub.textContent = pipelineView.subtitle || '';
        set(els.viewActions, null);
        if (typeof previousOnLeave === 'function') {
          try { previousOnLeave(); } catch (error) { if (root.console) root.console.error(error); }
        }
        previousOnLeave = null;
        try {
          set(els.viewBody, pipelineView.render(ctx));
        } catch (error) {
          set(els.viewBody, C.banner('error', 'This view failed to render', error.message));
          if (root.console) root.console.error(error);
        }
        previousOnLeave = typeof ctx.onLeave === 'function' ? ctx.onLeave : null;
        delete ctx.onLeave;
        return;
      }
      if (!stageId) {
        var states = root.Stages.states(Store.project());
        for (var i = 0; i < root.Stages.STAGES.length; i++) {
          var candidate = root.Stages.STAGES[i];
          if (states[candidate.id] === 'needs_review') { stageId = candidate.id; break; }
        }
        if (!stageId) {
          for (var j = 0; j < root.Stages.STAGES.length; j++) {
            if (states[root.Stages.STAGES[j].id] === 'ready') { stageId = root.Stages.STAGES[j].id; break; }
          }
        }
        if (!stageId) stageId = 'brief';
        Router.navigate(Router.projectHref(folder, stageId), true);
      }
      if (route.params.unknownStage) C.toast('Unknown stage "' + route.params.unknownStage + '". Showing ' + root.Stages.byId(stageId).title + '.', 'error');
      var stage = root.Stages.byId(stageId);
      viewKey = stage.kind === 'brief' ? 'brief' : stage.kind === 'material' ? 'material' : 'stage';
    } else {
      viewKey = route.name === 'settings' ? 'settings' : route.name === 'library' ? 'library' : 'picker';
    }
    renderRail(stageId);
    renderInspector();

    var view = root.Views[viewKey];
    var info = viewKey === 'stage' ? root.Views.stage.meta(stageId) : view;
    els.viewTitle.textContent = info.title;
    els.viewEyebrow.textContent = info.eyebrow;
    els.viewSub.textContent = info.subtitle || '';
    set(els.viewActions, null);

    /* A view that keeps working after it is replaced - a poll, a timer - registers here and is told
       to stop. Without this a screen that watches a long run would keep polling forever. */
    if (typeof previousOnLeave === 'function') {
      try { previousOnLeave(); } catch (error) { if (root.console) root.console.error(error); }
    }
    previousOnLeave = typeof ctx.onLeave === 'function' ? ctx.onLeave : null;
    delete ctx.onLeave;

    if (viewKey === 'project' && !Store.snapshot().folder) {
      set(els.viewBody, C.banner('warn', 'No project selected', 'Create a project or open a saved one.'));
      return;
    }
    try {
      set(els.viewBody, viewKey === 'stage' ? view.render(ctx, stageId) : view.render(ctx));
    } catch (error) {
      set(els.viewBody, C.banner('error', 'This view failed to render', error.message));
      if (root.console) root.console.error(error);
    }

    // Load the saved result only when the store does not already have it, and only once: a load that
    // failed must not be retried by every render that follows.
    if (viewKey === 'stage') {
      var serverStep = root.Stages.byId(stageId).server;
      if (serverStep && !Store.snapshot().results[serverStep] && !Store.snapshot().resultsAttempted[serverStep] && Store.snapshot().resultsLoading !== serverStep) {
        loadResults(serverStep).then(function () { render(); });
      }
    }
  }

  /* ---------- boot ---------- */

  async function boot() {
    cache();
    document.getElementById('goPicker').addEventListener('click', function () { Router.navigate('#/'); });
    document.getElementById('goSettings').addEventListener('click', function () { Router.navigate('#/settings'); });
    document.getElementById('goLibrary').addEventListener('click', function () { Router.navigate('#/library'); });
    /* The pipeline entry is a project action, so it is disabled until a project is open - the same
       rule the stage rail uses, rather than opening a screen that cannot do anything. */
    document.getElementById('goPipeline').addEventListener('click', function () {
      var folder = Store.snapshot().folder;
      if (folder) Router.navigate(Router.pipelineHref(folder));
    });
    els.inspectorToggle.addEventListener('click', function () {
      els.inspector.hidden = true;
      document.querySelector('.shell').classList.remove('has-inspector');
    });
    Store.subscribe(function () { /* render cycle is explicit to avoid render storms */ });

    Router.onChange(function () { render(); });

    try {
      await Promise.all([
        Api.settings().then(function (data) { Store.patch({ settings: data }); }),
        // The template vocabulary comes from the server so the interface never hard-codes one.
        Api.renderTemplates().then(function (data) { Store.patch({ renderTemplates: data }); }).catch(function () { Store.patch({ renderTemplates: null }); }),
        refreshProjects()
      ]);
      var last = Store.lastProject();
      if (last && Store.snapshot().projects.some(function (project) { return project.folder === last; })) {
        await openProject(last);
        // Loading a project puts it in state; the address must follow, or the user stays on the
        // picker while a project is open. Only redirect when the user landed on the default route.
        if (Router.current().name === 'picker') {
          Router.navigate(Router.projectHref(last, null), true);
          // replaceState does not fire hashchange in every browser, so render explicitly.
          render();
        }
      }
    } catch (error) {
      C.toast(error.message, 'error');
    }
    Store.patch({ ready: true });
    render();
  }

  root.App = { boot: boot, ctx: ctx, render: render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
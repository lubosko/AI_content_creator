'use strict';
/* Application state. Views read from here and never fetch directly, so there is exactly one
   place that knows what is loaded, what is busy, and which project is open. */
(function (root) {
  var listeners = [];
  var state = {
    ready: false,
    loading: false,
    busy: false,
    folder: null,
    projects: [],
    intake: null,
    brief: null,
    library: [],
    licences: [],
    renderTemplates: null,
    maxUploadBytes: 0,
    settings: null,
    results: {},
    /* Steps whose results have been asked for at least once, successfully or not. Without this the
       render-time guard reads "no result yet" for a load that already failed, and asks again on every
       render - a request-and-render loop that never terminates. */
    resultsAttempted: {},
    errors: {}
  };

  function snapshot() { return state; }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (error) { if (root.console) root.console.error(error); }
    }
  }

  function subscribe(fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (item) { return item !== fn; }); }; }

  function patch(values) {
    for (var key in values) state[key] = values[key];
    emit();
    return state;
  }

  function project() { return state.intake ? state.intake.project : null; }
  function workflow() { return project() ? project().workflow || {} : {}; }
  function revision() { return workflow().revision || 0; }

  function stageState(id) { return Stages.states(project())[id] || 'locked'; }

  function setResult(step, value) { state.results[step] = value; emit(); }
  function setError(step, message) { if (message) state.errors[step] = message; else delete state.errors[step]; emit(); }
  function markAttempted(step) { state.resultsAttempted[step] = true; }

  /* Busy is a counter so overlapping operations cannot clear each other's lock. */
  var busyCount = 0;
  function begin() { busyCount++; if (!state.busy) { state.busy = true; emit(); } }
  function end() { busyCount = Math.max(0, busyCount - 1); if (!busyCount && state.busy) { state.busy = false; emit(); } }

  var LAST_KEY = 'contentAgentLastProject';
  function rememberLast(folder) { try { window.localStorage.setItem(LAST_KEY, folder); } catch (error) { /* private mode */ } }
  function lastProject() { try { return window.localStorage.getItem(LAST_KEY); } catch (error) { return null; } }

  function resetProject() {
    state.folder = null; state.intake = null; state.brief = null;
    state.results = {}; state.resultsAttempted = {}; state.errors = {};
    emit();
  }

  root.Store = {
    snapshot: snapshot, subscribe: subscribe, patch: patch,
    project: project, workflow: workflow, revision: revision, stageState: stageState,
    setResult: setResult, setError: setError, markAttempted: markAttempted, begin: begin, end: end,
    rememberLast: rememberLast, lastProject: lastProject, resetProject: resetProject
  };
})(window);
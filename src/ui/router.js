'use strict';
/* Hash routing. Every screen is addressable, reloadable and bookmarkable, which the previous
   single-page prototype could not do. Unknown stages fall back to the project overview instead
   of rendering a blank screen. */
(function (root) {
  var Stages = root.Stages;

  function parse(hash) {
    var raw = String(hash || '').replace(/^#/, '');
    var clean = raw.replace(/^\/+/, '').replace(/\/+$/, '');
    var parts = clean ? clean.split('/').map(decodeURIComponent) : [];
    if (!parts.length) return { name: 'picker', params: {} };
    if (parts[0] === 'settings') return { name: 'settings', params: {} };
    if (parts[0] === 'library') return { name: 'library', params: {} };
    if (parts[0] === 'project' && parts[1]) {
      // "Run to final check" is a project action, not a stage: it is deliberately absent from the
      // stage vocabulary, so it cannot be mistaken for a step in the approval chain.
      if (parts[2] === 'pipeline') return { name: 'project', params: { folder: parts[1], stage: null, panel: 'pipeline' } };
      var stage = parts[2] ? Stages.byRoute(parts[2]) : null;
      return { name: 'project', params: { folder: parts[1], stage: stage ? stage.id : null, unknownStage: parts[2] && !stage ? parts[2] : null } };
    }
    return { name: 'notfound', params: { path: clean } };
  }

  function href(route) {
    if (route.name === 'picker') return '#/';
    if (route.name === 'settings') return '#/settings';
    if (route.name === 'library') return '#/library';
    if (route.name === 'project') {
      if (route.panel === 'pipeline') return '#/project/' + encodeURIComponent(route.folder) + '/pipeline';
      var stage = route.stage ? (Stages.byId(route.stage) || {}).route : null;
      return '#/project/' + encodeURIComponent(route.folder) + (stage ? '/' + stage : '');
    }
    return '#/';
  }

  function projectHref(folder, stageId) { return href({ name: 'project', folder: folder, stage: stageId }); }
  function pipelineHref(folder) { return href({ name: 'project', folder: folder, panel: 'pipeline' }); }

  function navigate(route, replace) {
    var target = typeof route === 'string' ? route : href(route);
    if (replace) window.history.replaceState(null, '', target);
    else window.location.hash = target;
  }

  function current() { return parse(window.location.hash); }

  function onChange(handler) {
    window.addEventListener('hashchange', function () { handler(current()); });
    handler(current());
  }

  root.Router = { parse: parse, href: href, projectHref: projectHref, pipelineHref: pipelineHref, navigate: navigate, current: current, onChange: onChange };
})(window);
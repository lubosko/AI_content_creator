'use strict';
/* Run to final check. A project action rather than a stage: it drives the stages but is not one, and
   it deliberately stops at the final check without approving anything.

   The run happens on the server, so this screen only starts it, watches it and reports it. That is
   what lets a reload re-attach to a run already in progress instead of losing it. */
(function (root) {
  var el = root.Dom.el;
  var button = root.Dom.button;
  var C = root.Components;
  var Api = root.Api;

  /* Polling starts quick so the first step is visibly running, then backs off. A generation pass plus
     a render takes minutes, and there is nothing to gain from asking every second for that long. */
  var POLL_START_MS = 1500;
  var POLL_MAX_MS = 8000;
  var POLL_FACTOR = 1.5;

  function describe(run) {
    if (!run) return 'No run has been started yet.';
    if (run.status === 'running') return 'Running. You can leave this page: the run continues on the server.';
    if (run.status === 'interrupted') return 'Interrupted.';
    if (run.status === 'canceled') return 'Cancelled.';
    if (run.status === 'stopped') return 'Stopped before finishing.';
    if (run.status === 'failed') return 'Failed.';
    return 'Finished.';
  }

  function stepTone(status) {
    if (status === 'succeeded') return 'ok';
    if (status === 'failed') return 'failed';
    if (status === 'running') return 'running';
    if (status === 'skipped') return 'info';
    return 'locked';
  }

  function runPanel(run) {
    var wrap = el('div', { class: 'stack' });
    wrap.append(C.metrics([
      { label: 'Status', value: root.Stages.label(run.status) },
      { label: 'Started', value: run.started_at ? new Date(run.started_at).toLocaleTimeString() : '-' },
      { label: 'Generated', value: String((run.generated && run.generated.succeeded || []).length), numeric: true },
      { label: 'Failed', value: String((run.generated && run.generated.failed || []).length), numeric: true }
    ]));

    if (run.status === 'running' && run.last_scene) {
      var progress = run.last_progress && typeof run.last_progress.value === 'number' ? run.last_progress.value : null;
      wrap.append(el('p', { class: 'metric-note', text: 'Working on ' + run.last_scene + (progress === null ? '' : ' (' + Math.round(progress * 100) + '% of the current job)') }));
    }

    (run.steps || []).forEach(function (step) {
      var lines = [el('p', { class: 'metric-note', text: step.detail || 'Waiting.' })];
      wrap.append(C.panel(step.label, { subtitle: root.Stages.label(step.status), children: lines }));
      void stepTone(step.status);
    });

    if ((run.generated && run.generated.failed || []).length) {
      var failures = el('div', { class: 'stack tight' }, run.generated.failed.map(function (item) {
        return el('p', { class: 'field-error', text: item.scene_id + ': ' + item.reason });
      }));
      wrap.append(C.panel('Scenes that could not be generated', { subtitle: 'A re-run retries only these', children: failures }));
    }

    if (run.stop_reason) {
      var tone = run.status === 'succeeded' ? 'ok' : (run.status === 'running' ? 'info' : 'warn');
      wrap.append(C.banner(tone, describe(run), run.stop_reason));
    }
    return wrap;
  }

  function render(ctx) {
    var folder = ctx.store.snapshot().folder;
    var host = el('div', { class: 'stack' });
    var status = el('p', { class: 'metric-note', text: 'Loading...' });
    var timer = null;
    var stopped = false;
    var delay = POLL_START_MS;

    function stopPolling() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } }

    function schedule() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, delay);
      delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_FACTOR));
    }

    /* Polls while a run is in flight and stops as soon as it settles or the view is replaced. */
    function load() {
      return Api.pipeline(folder).then(function (state) {
        if (stopped) return;
        paint(state);
        if (state.run && state.run.status === 'running') schedule();
        return state;
      }).catch(function (error) {
        if (!stopped) status.textContent = error.message;
      });
    }

    function paint(state) {
      var plan = state.plan || {};
      var comfy = state.comfy || {};
      host.replaceChildren();

      host.append(C.metrics([
        { label: 'Scenes needing media', value: String(plan.scenes_needing_media || 0), numeric: true },
        { label: 'Would be generated', value: String(plan.scenes_to_generate || 0), numeric: true, note: 'each costs Comfy credits' },
        { label: 'Storyboard', value: plan.storyboard_approved ? 'Approved' : 'Not approved' },
        { label: 'Comfy', value: comfy.configured && comfy.workflows && comfy.workflows.length ? 'Ready' : 'Not configured' }
      ]));

      var blocked = el('div', { class: 'stack tight' });
      if ((state.problems || []).length) {
        state.problems.forEach(function (problem) { blocked.append(el('p', { class: 'field-error', text: problem })); });
      }
      if (!comfy.configured) {
        blocked.append(el('p', { class: 'metric-note', text: 'No Comfy API key is configured, so no scene will be generated. The run still does narration, local drawings, stock sourcing, the render and the final check.' }));
      }
      if (comfy.workflow_problem) {
        blocked.append(el('p', { class: 'metric-note', text: comfy.workflow_problem }));
      }
      if (blocked.childNodes.length) {
        host.append(C.panel('Before you start', { children: blocked }));
      }

      host.append(C.banner('info', 'What this does',
        'It generates media for the scenes that still need it, then runs the assets stage, renders the master and runs the final check - and stops there. It never approves anything and never builds the platform exports, because those are decisions only you can make.'));

      var stopAfter = C.select({ id: 'pipelineStopAfter', value: 'final_check' }, [
        { value: 'final_check', label: 'Run all the way to the final check' },
        { value: 'generate', label: 'Stop after generating media, so I can review it first' }
      ]);

      var running = state.run && state.run.status === 'running';
      var start = button('Start the run', { variant: 'primary', disabled: !state.can_start || running, on: function () {
        start.setBusy(true, 'Starting');
        delay = POLL_START_MS;
        Api.startPipeline(folder, { stop_after: stopAfter.value }).then(function () {
          C.toast('The run has started. It continues on the server if you leave this page.');
          return load();
        }).catch(function (error) {
          C.toast(error.message, 'error');
          return load();
        }).finally(function () { start.setBusy(false); });
      } });

      var cancel = button('Cancel the run', { disabled: !running, on: function () {
        cancel.setBusy(true, 'Cancelling');
        Api.cancelPipeline(folder).then(function () {
          C.toast('The run was asked to stop. The job in flight is cancelled too.');
          return load();
        }).catch(function (error) { C.toast(error.message, 'error'); })
          .finally(function () { cancel.setBusy(false); });
      } });

      host.append(C.panel('Start a run', {
        children: el('div', { class: 'stack' }, [
          C.field('Stop point', stopAfter, { hint: 'Either way the run stops after the final check, with the approval left to you.' }),
          el('div', { class: 'row' }, [start, cancel])
        ])
      }));

      if (state.run) host.append(runPanel(state.run));
      status.textContent = state.run ? describe(state.run) : 'Ready to start.';
    }

    host.append(status);
    load();
    // The router re-renders on navigation; nothing here may keep polling after that.
    ctx.onLeave = stopPolling;
    return host;
  }

  root.Views = root.Views || {};
  root.Views.pipeline = {
    title: 'Run to final check',
    eyebrow: 'Project action',
    subtitle: 'Generate what is missing, render the master and check it - then stop for your approval.',
    render: render
  };
})(window);
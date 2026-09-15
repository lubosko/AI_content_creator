'use strict';
/* Reusable library: the global view of every imported item a project can draw on. */
(function (root) {
  var el = root.Dom.el;
  var button = root.Dom.button;
  var C = root.Components;
  var Views = root.Views = root.Views || {};

  function render(ctx) {
    var state = ctx.store.snapshot();
    var selections = ((ctx.store.workflow().materials || {}).selections) || [];
    var inProject = {};
    selections.forEach(function (item) { inProject[item.asset_id] = item.decision; });
    var body = el('div', { class: 'stack' });

    if (state.folder) {
      body.append(C.banner('info', 'Project open: ' + state.folder, 'Decisions shown here are read-only. Change them in the Own material stage of that project.', {
        actions: button('Open material stage', { size: 'sm', on: function () { ctx.navigate(root.Router.projectHref(state.folder, 'material')); } })
      }));
    } else {
      body.append(C.banner('info', 'No project open', 'Library items persist independently of any project.'));
    }

    var grid = el('div', { class: 'asset-grid' });
    if (!state.library.length) {
      grid.append(C.empty('Your library is empty', 'Open a project and import a file, add a URL, or write a note.'));
    }
    /* Rights belong to the library original, so they can be recorded here as well as in a project.
       The badge is on every card regardless, so nothing looks cleared by omission. */
    function openRights(asset) {
      C.rightsDialog({
        subject: asset.name,
        licences: state.licences || [],
        rights: asset.rights || {},
        onSave: async function (body) {
          await ctx.api.setAssetRights(asset.id, body);
          await ctx.refresh();
          C.toast('Rights recorded.');
        }
      });
    }
    state.library.forEach(function (asset) {
      var decision = inProject[asset.id];
      grid.append(C.assetCard(asset, {
        selection: decision ? { decision: decision } : null,
        onRights: function () { openRights(asset); },
        onDecision: state.folder ? function (next) {
          ctx.selectAsset(asset.id, next).then(function () { return ctx.refresh(); }).then(function () { ctx.rerender(); }).catch(function (error) { C.toast(error.message, 'error'); });
        } : null,
        onAnalyze: function (control) {
          if (control && control.setBusy) control.setBusy(true, 'Analyzing');
          ctx.api.analyzeAsset(asset.id)
            .then(function (result) {
              var summary = result.summary || {};
              if (summary.state === 'analyzed') C.toast('Analyzed: ' + asset.name);
              else if (summary.state === 'needs_confirmation') C.toast(asset.name + ' needs transcription confirmation in its project.');
              else C.toast(asset.name + ': ' + (summary.message || 'analysis did not complete'), 'error');
            })
            .catch(function (error) { C.toast(error.message, 'error'); })
            .then(function () { return ctx.refresh(); })
            .then(function () { ctx.rerender(); })
            .catch(function (error) { C.toast(error.message, 'error'); });
        },
        onConfirmTranscribe: function (control) {
          var summary = C.analysisState(asset);
          var estimate = summary.estimate;
          var minutes = estimate ? estimate.minutes : Math.round((summary.durationSeconds || 0) / 60);
          C.confirmDialog({
            title: 'Transcribe ' + minutes + ' minute(s)?',
            message: asset.name + ' is about ' + minutes + ' minute(s) long. Transcription costs approximately ' + (estimate ? '$' + estimate.usd.toFixed(2) : 'the provider rate') + ' and sends the audio to the provider. The prepared audio file is deleted afterwards.',
            confirmLabel: 'Transcribe',
            onConfirm: function () {
              if (control && control.setBusy) control.setBusy(true, 'Transcribing');
              ctx.api.analyzeAsset(asset.id, true)
                .then(function (result) { C.toast((result.summary || {}).state === 'analyzed' ? 'Transcribed: ' + asset.name : 'Transcription did not complete', (result.summary || {}).state === 'analyzed' ? null : 'error'); })
                .catch(function (error) { C.toast(error.message, 'error'); })
                .then(function () { return ctx.refresh(); })
                .then(function () { ctx.rerender(); })
                .catch(function (error) { C.toast(error.message, 'error'); });
            }
          });
        }
      }));
    });

    body.append(C.panel('Library items', {
      subtitle: state.library.length + ' item(s). Maximum ' + Math.round((state.maxUploadBytes || 0) / 1024 / 1024) + ' MB per file.',
      actions: button('Refresh', { size: 'sm', on: function () { ctx.refresh().catch(function (error) { C.toast(error.message, 'error'); }); } }),
      children: grid,
      class: 'flush'
    }));
    return body;
  }

  Views.library = { render: render, title: 'Library', eyebrow: 'Reusable library', subtitle: 'Everything imported so far. Removing a project selection never removes the library original.' };
})(window);
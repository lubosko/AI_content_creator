'use strict';
/* Material stage: import files, add URLs and notes, and decide Use/Maybe/Skip for this project.
   Imported never implies analyzed, and the confirmation gate is enforced on the server too. */
(function (root) {
  var el = root.Dom.el;
  var button = root.Dom.button;
  var C = root.Components;
  var Views = root.Views = root.Views || {};

  function hasMissing(asset) { return !!asset.missing; }

  var SHOW_ALL_KEY = 'materialShowWholeLibrary';
  function readShowAll() {
    try { return window.localStorage.getItem(SHOW_ALL_KEY) === 'true'; } catch (error) { return false; }
  }
  function writeShowAll(value) {
    try { window.localStorage.setItem(SHOW_ALL_KEY, String(!!value)); } catch (error) { /* private mode */ }
  }

  function render(ctx) {
    var state = ctx.store.snapshot();
    var workflow = ctx.store.workflow();
    var briefApproved = (workflow.brief || {}).state === 'approved';
    var materials = workflow.materials || {};
    var confirmed = materials.state === 'approved';
    var selections = materials.selections || [];
    var body = el('div', { class: 'stack' });
    var messages = el('div', { class: 'stack tight' });

    function message(text, tone) {
      messages.append(el('p', { class: tone === 'error' ? 'field-error' : 'field-hint', text: text }));
    }

    if (!briefApproved) {
      body.append(C.banner('warn', 'Confirm the brief first', 'Material choices unlock once the brief is approved.', {
        actions: button('Go to brief', { on: function () { ctx.navigate(root.Router.projectHref(state.folder, 'brief')); } })
      }));
    } else if (confirmed) {
      body.append(C.banner('ok', materials.without_material ? 'Continuing without own material' : 'Material selection confirmed',
        materials.without_material ? 'You chose to continue without own material. Research can be generated.' : selections.filter(function (s) { return s.decision === 'use'; }).length + ' item(s) marked Use.'));
    } else {
      body.append(C.banner('info', 'Decide for each item', 'Mark every item Use, Maybe or Skip. Maybe items must be resolved before you can confirm.'));
    }

    // --- rights summary ---
    /* The gate is enforced on the server. Restating it here is not a second opinion: it is the
       warning that arrives before the operator wastes a click on Confirm. */
    var useAssets = selections.filter(function (item) { return item.decision === 'use'; }).map(function (item) {
      return state.library.filter(function (asset) { return asset.id === item.asset_id; })[0] || null;
    }).filter(Boolean);
    var blockedUse = useAssets.filter(function (asset) { return asset.publishable !== false && C.rightsState(asset).state === 'blocked'; });
    var creditUse = useAssets.filter(function (asset) { return asset.publishable !== false && C.rightsState(asset).attribution; });

    function openRightsDialog(assets, subject) {
      var first = assets[0] || {};
      var existing = assets.length === 1 ? (first.rights || {}) : {};
      C.rightsDialog({
        subject: subject,
        licences: state.licences || [],
        rights: existing,
        onSave: async function (body) {
          var ids = assets.map(function (asset) { return asset.id; });
          if (ids.length === 1) await ctx.api.setAssetRights(ids[0], body);
          else await ctx.api.setRights(ids, body);
          await ctx.refresh();
          C.toast(ids.length === 1 ? 'Rights recorded.' : 'Rights recorded for ' + ids.length + ' items.');
        }
      });
    }

    if (blockedUse.length) {
      body.append(C.banner('warn', 'Rights not confirmed for ' + blockedUse.length + ' selected item(s)',
        'Everything marked Use needs a recorded basis before the material selection can be confirmed: ' +
        blockedUse.slice(0, 3).map(function (asset) { return asset.name; }).join(', ') +
        (blockedUse.length > 3 ? ' and ' + (blockedUse.length - 3) + ' more' : '') +
        '. Unrecorded material is also withheld from the storyboard, so a scene cannot quietly depend on it.', {
          actions: button('Record rights for these', { variant: 'primary', on: function () { openRightsDialog(blockedUse, blockedUse.length + ' items'); } })
        }));
    }
    if (creditUse.length) {
      body.append(C.banner('info', creditUse.length + ' item(s) require a credit',
        'Their licences require attribution, so the credit is written into the export metadata automatically: ' +
        creditUse.map(function (asset) { return C.rightsState(asset).attribution; }).join(' ')));
    }

    // --- import ---
    var category = C.select({ id: 'materialCategory', value: 'knowledge' }, [
      { value: 'knowledge', label: 'Knowledge (research and script)' },
      { value: 'media', label: 'Media (storyboard and composer)' },
      { value: 'brand', label: 'Brand (logo, music, style)' }
    ]);
    var files = el('input', { type: 'file', id: 'materialFiles', attrs: { multiple: 'multiple', 'aria-label': 'Choose files to import' } });
    var showAllControl = C.checkbox('Show the whole reusable library', { id: 'showLibrary', checked: readShowAll() });
    var showAll = showAllControl.input.checked;
    showAllControl.input.addEventListener('change', function () { writeShowAll(showAllControl.input.checked); ctx.rerender(); });
    body.append(C.panel('Import own material', {
      subtitle: 'Files are copied into managed library storage. Moving the original later will not break this project.',
      children: [
        C.field('Category for new items', category, { hint: 'Knowledge feeds research and script. Media feeds storyboard and composer. Brand feeds the director and composer.' }),
        C.field('Files', files, { hint: 'Video, image, audio, PDF, DOCX, text, SVG or font files. Up to ' + Math.round((state.maxUploadBytes || 0) / 1024 / 1024) + ' MB each.' }),
        showAllControl.node,
        messages
      ]
    }));

    var kind = C.select({ id: 'materialKind', value: 'note' }, [{ value: 'note', label: 'Note' }, { value: 'url', label: 'URL reference' }]);
    var title = C.textInput({ id: 'materialTitle', placeholder: 'Title' });
    var content = C.textArea({ id: 'materialContent', rows: 4, placeholder: 'Write the note, or paste an https:// URL.' });
    var saveText = button('Save to library and use', { on: async function () {
      if (!title.value.trim()) { C.toast('Give this item a title.', 'error'); title.focus(); return; }
      if (!content.value.trim()) { C.toast('Add the note text or the URL.', 'error'); content.focus(); return; }
      saveText.setBusy(true, 'Saving');
      try {
        var created = await ctx.api.addText({ kind: kind.value, name: title.value.trim(), content: content.value.trim(), category: category.value });
        title.value = ''; content.value = '';
        try { await ctx.selectAsset(created.asset.id, 'use'); }
        catch (error) { message('Saved to the library, but selecting it failed: ' + error.message, 'error'); }
        await ctx.refresh();
        C.toast('Saved: ' + created.asset.name);
      } catch (error) {
        C.toast(error.message, 'error');
      } finally { saveText.setBusy(false); }
    } });
    body.append(C.panel('Add a note or URL', {
      subtitle: 'URLs are saved as references. Fetching and extracting a page is a separate, later step.',
      children: [
        el('div', { class: 'grid cols-2' }, [C.field('Type', kind), C.field('Title', title)]),
        C.field('Content', content)
      ],
      footer: [saveText]
    }));

    // --- library ---
    var assets = state.library.filter(function (asset) {
      return showAll || selections.some(function (item) { return item.asset_id === asset.id; });
    });
    var grid = el('div', { class: 'asset-grid' });
    if (!assets.length) {
      grid.append(C.empty(showAll ? 'Your library is empty' : 'No material selected',
        showAll ? 'Import a file, add a URL, or write a note above.' : 'Import something, or tick "Show the whole reusable library" to select from existing items.'));
    }
    assets.forEach(function (asset) {
      var selection = selections.filter(function (item) { return item.asset_id === asset.id; })[0] || null;
      var summary = C.analysisState(asset);
      grid.append(C.assetCard(asset, {
        selection: selection,
        onDecision: function (decision) {
          ctx.selectAsset(asset.id, decision).then(function () { ctx.refresh(); }).catch(function (error) { C.toast(error.message, 'error'); });
        },
        onRights: function () { openRightsDialog([asset], asset.name); },
        onAnalyze: function (control) { analyzeOne(asset, control, false); },
        onConfirmTranscribe: function (control) { askToTranscribe(asset, summary, control); }
      }));
    });

    /* Analyzing always reports the real outcome, including "not supported" and the reason a
       failure happened. The card is re-rendered from the refreshed library, never optimistically. */
    async function analyzeOne(asset, control, confirmLong) {
      if (control && control.setBusy) control.setBusy(true, 'Analyzing');
      try {
        var result = await ctx.api.analyzeAsset(asset.id, confirmLong);
        var summary = result.summary || {};
        if (summary.state === 'analyzed') C.toast('Analyzed: ' + asset.name);
        else if (summary.state === 'needs_confirmation') C.toast(asset.name + ' needs transcription confirmation.');
        else C.toast(asset.name + ': ' + (summary.message || 'analysis did not complete'), 'error');
      } catch (error) {
        C.toast(error.message, 'error');
      } finally {
        try { await ctx.refresh(); } catch (error) { C.toast(error.message, 'error'); }
      }
    }

    /* Transcription costs money per minute, so a long file is confirmed explicitly, with the
       estimate and the provider shown before anything is spent. */
    function askToTranscribe(asset, summary, control) {
      var estimate = summary.estimate;
      var minutes = estimate ? estimate.minutes : Math.round((summary.durationSeconds || 0) / 60);
      var cost = estimate ? '$' + estimate.usd.toFixed(2) : 'an amount set by the provider';
      var provider = (state.settings && state.settings.transcription && state.settings.transcription.model) || 'the transcription provider';
      C.confirmDialog({
        title: 'Transcribe ' + minutes + ' minute(s)?',
        message: asset.name + ' is about ' + minutes + ' minute(s) long. Using ' + provider + ' costs approximately ' + cost + ' at the published rate. The audio is sent to the provider for transcription. The prepared audio file is deleted afterwards.',
        confirmLabel: 'Transcribe and spend ' + cost,
        onConfirm: function () { analyzeOne(asset, control, true); }
      });
    }

    var awaiting = state.library.filter(function (asset) { return C.analysisState(asset).canAnalyze; });
    var analyzeAll = button(awaiting.length ? 'Analyze ' + awaiting.length + ' item(s)' : 'Nothing to analyze', {
      disabled: !awaiting.length,
      on: async function () {
        analyzeAll.setBusy(true, 'Analyzing');
        try {
          var result = await ctx.api.analyzePending();
          var parts = [];
          if (result.analyzed) parts.push(result.analyzed + ' analyzed');
          if (result.failed) parts.push(result.failed + ' failed');
          if (result.unsupported) parts.push(result.unsupported + ' not supported');
          C.toast(parts.length ? parts.join(', ') + '.' : 'Nothing needed analysis.', result.failed ? 'error' : null);
        } catch (error) {
          C.toast(error.message, 'error');
        } finally { analyzeAll.setBusy(false); try { await ctx.refresh(); } catch (error) { C.toast(error.message, 'error'); } }
      }
    });

    var libraryPanel = C.panel('Project material', {
      subtitle: 'Decisions belong to this project. Removing a selection never deletes the library original. Analysis reads what each item actually contains; it does not change the original.',
      actions: el('div', { class: 'row' }, [
        analyzeAll,
        button('Record rights', { size: 'sm', disabled: !useAssets.length, on: function () { openRightsDialog(useAssets, useAssets.length + ' items'); } }),
        button('Refresh library', { size: 'sm', on: function () { ctx.refresh().catch(function (error) { C.toast(error.message, 'error'); }); } })
      ]),
      children: grid,
      class: 'flush'
    });
    body.append(libraryPanel);

    // --- confirm ---
    var anyUse = selections.some(function (item) { return item.decision === 'use'; });
    var anyMaybe = selections.some(function (item) { return item.decision === 'maybe'; });
    var confirmBtn = button('Confirm material selection', { variant: 'primary', disabled: !briefApproved || anyMaybe, on: async function () {
      confirmBtn.setBusy(true, 'Confirming');
      try {
        await ctx.confirmMaterials(false);
        C.toast('Material selection confirmed.');
        await ctx.refresh();
        ctx.navigate(root.Router.projectHref(state.folder, 'research'));
      } catch (error) { C.toast(error.message, 'error'); } finally { confirmBtn.setBusy(false); }
    } });
    var skipBtn = button('Continue without material', { on: async function () {
      skipBtn.setBusy(true, 'Confirming');
      try {
        await ctx.confirmMaterials(true);
        C.toast('Continuing without own material.');
        await ctx.refresh();
        ctx.navigate(root.Router.projectHref(state.folder, 'research'));
      } catch (error) { C.toast(error.message, 'error'); } finally { skipBtn.setBusy(false); }
    } });

    body.append(C.panel('Confirm this selection', {
      children: el('div', { class: 'stack' }, [
        el('p', { class: 'metric-note', text: anyMaybe ? 'Resolve every Maybe item before confirming.' : (blockedUse.length ? 'Record rights for ' + blockedUse.length + ' item(s) before confirming; the server will refuse otherwise.' : (anyUse ? 'Selected items will be available to research, storyboard and the composer.' : 'Nothing is marked Use, so choose "Continue without material" to proceed.')) })
      ]),
      footer: [skipBtn, confirmBtn]
    }));

    files.addEventListener('change', async function (event) {
      var chosen = Array.prototype.slice.call(event.target.files || []);
      if (!chosen.length) return;
      files.disabled = true;
      C.clear(messages);
      for (var i = 0; i < chosen.length; i++) {
        var file = chosen[i];
        message('Importing ' + file.name + '...');
        try {
          var uploaded = await ctx.api.upload(file, category.value);
          try {
            await ctx.selectAsset(uploaded.asset.id, 'use');
            message('Imported and selected: ' + file.name);
          } catch (error) {
            message('Saved to the library: ' + file.name + '. Selecting it failed: ' + error.message, 'error');
          }
        } catch (error) {
          message(file.name + ': ' + error.message, 'error');
        }
      }
      event.target.value = '';
      files.disabled = false;
      try { await ctx.refresh(); } catch (error) { C.toast(error.message, 'error'); }
    });

    return body;
  }

  Views.material = { render: render, title: 'Own material', eyebrow: 'Stage 2 of 10', subtitle: 'Import files, add URLs and notes, and choose what this project should use.' };
})(window);
'use strict';
/* Settings: provider credentials, models, research defaults, and the local capability report.
   Credential problems are shown as recoverable states with a way out, never as a dead end. */
(function (root) {
  var el = root.Dom.el;
  var button = root.Dom.button;
  var C = root.Components;
  var Views = root.Views = root.Views || {};

  function capabilityPanel(capabilities) {
    if (!capabilities) return null;
    var rows = (capabilities.tools || []).map(function (tool) {
      return el('tr', {}, [
        el('td', {}, el('span', { class: 'mono', text: tool.name })),
        el('td', {}, tool.available ? C.pill('approved') : C.pill('failed')),
        el('td', { class: 'mono', text: tool.version || (tool.reason || 'not found') }),
        el('td', { class: 'metric-note', text: tool.available ? ((tool.encoders || []).join(', ') || 'encoders not reported') : '' })
      ]);
    });
    return C.panel('Local media capability', {
      subtitle: 'Video composition needs both binaries. Detection also checks the WinGet Links folder, so a fresh install is found without restarting the server.',
      children: [
        capabilities.ready ? C.banner('ok', 'Ready to compose', capabilities.summary) : C.banner('warn', 'Composition unavailable', capabilities.summary),
        el('table', { class: 'table' }, [
          el('thead', {}, el('tr', {}, [el('th', { text: 'Tool' }), el('th', { text: 'Status' }), el('th', { text: 'Version' }), el('th', { text: 'Encoders' })])),
          el('tbody', {}, rows)
        ])
      ]
    });
  }

  function render(ctx) {
    var state = ctx.store.snapshot();
    var data = state.settings;
    if (!data) return C.skeleton(5);
    var body = el('div', { class: 'stack' });

    var providerSelect = C.select({ id: 'settingsProvider', value: 'anthropic' }, data.providers.map(function (item) {
      return { value: item.id, label: item.name + (item.available ? '' : ' (planned)') };
    }));
    var key = C.textInput({ id: 'settingsKey', type: 'password', placeholder: 'Enter your API key' });
    var model = C.textInput({ id: 'settingsModel', value: '' });
    var statusLine = el('p', { class: 'metric-note' });
    var capabilityLine = el('p', { class: 'metric-note' });
    var testResult = el('p', { class: 'metric-note' });
    var message = el('p', { class: 'metric-note' });
    var modelField = C.field('Model', model);
    var keyField = C.field('API key', key, { hint: 'The saved key is never sent back to the browser. Leave blank to keep the current key.' });

    var removeBtn = button('Remove saved key', { variant: 'danger' });
    var testBtn = button('Test connection');

    function current() {
      return data.providers.filter(function (item) { return item.id === providerSelect.value; })[0] || data.providers[0];
    }

    function paint() {
      var item = current();
      key.value = '';
      key.placeholder = item.configured ? 'Key configured (hidden). Leave blank to keep.' : 'Enter your API key';
      model.value = item.model || '';
      modelField.hidden = ['anthropic', 'openai', 'google'].indexOf(item.id) < 0;
      statusLine.textContent = item.category + ' | ' + root.Stages.label(item.status) + ' | Key source: ' + item.source;
      // Be specific about what each connected provider actually does today.
      var manualOnly = item.id === 'leonardo' || item.id === 'mootion';
      capabilityLine.textContent = item.id === 'anthropic'
        ? 'Connected feature: research. Strategy, script and storyboard still use their existing generators.'
        : item.id === 'openai'
          ? 'Connected feature: speech transcription of your own video and audio, and narration. Long files ask for confirmation first.'
          : manualOnly
            ? 'No API adapter, and none is planned for this provider. Use the scene prompt pack in the Storyboard stage and attach what you generate, or draw the graphic scenes locally for free.'
            : item.available
              ? 'Connected feature: research. Other stages still use their existing generators.'
              : 'Credential storage only. This provider does not run in the workflow yet, and connection testing is unavailable.';
      testBtn.disabled = !item.available || !item.configured;
      removeBtn.disabled = item.source !== 'settings';
      testResult.textContent = item.credential_error
        ? item.credential_error
        : (item.test ? item.test.message + ' (' + new Date(item.test.at).toLocaleString() + ')' : 'This configuration has not been tested.');
      // A verified key with an unavailable model is a real problem worth flagging in colour.
      testResult.className = item.test && item.test.modelAvailable === false ? 'field-error' : 'metric-note';
    }

    removeBtn.addEventListener('click', async function () {
      removeBtn.setBusy(true, 'Removing');
      try {
        var next = await ctx.api.saveSettings(data.revision, { provider: providerSelect.value, key_action: 'remove' });
        ctx.store.patch({ settings: next });
        message.textContent = 'Saved key removed. The environment value becomes active again if one exists.';
        ctx.rerender();
      } catch (error) { message.textContent = error.message; }
      finally { removeBtn.setBusy(false); }
    });

    var saveBtn = button('Save connection', { variant: 'primary', on: async function () {
      saveBtn.setBusy(true, 'Saving');
      try {
        var hasKey = key.value.trim().length > 0;
        var payload = { provider: providerSelect.value, model: model.value, key_action: hasKey ? 'replace' : 'keep' };
        if (hasKey) payload.api_key = key.value;
        var next2 = await ctx.api.saveSettings(data.revision, payload);
        ctx.store.patch({ settings: next2 });
        key.value = '';
        message.textContent = 'Settings saved. New requests use this configuration.';
        ctx.rerender();
      } catch (error) { message.textContent = error.message; }
      finally { saveBtn.setBusy(false); }
    } });

    testBtn.addEventListener('click', async function () {
      testBtn.setBusy(true, 'Testing');
      try {
        var next3 = await ctx.api.testSettings(data.revision, providerSelect.value);
        ctx.store.patch({ settings: next3 });
        message.textContent = 'Connection test completed.';
        ctx.rerender();
      } catch (error) { message.textContent = error.message; }
      finally { testBtn.setBusy(false); }
    });

    providerSelect.addEventListener('change', paint);

    body.append(C.panel('Provider connections', {
      subtitle: 'Credentials are encrypted for this Windows account. On other systems, use environment variables.',
      children: [
        C.field('Connection', providerSelect),
        statusLine,
        capabilityLine,
        el('div', { class: 'grid cols-2' }, [keyField, modelField]),
        testResult,
        message
      ],
      footer: [removeBtn, testBtn, saveBtn]
    }));

    var webDefault = C.checkbox('Allow web search by default', { checked: !!data.defaults.web_search });
    var materialDefault = C.checkbox('Share selected material by default', { checked: !!data.defaults.include_materials });
    var defaultsMsg = el('p', { class: 'metric-note' });
    body.append(C.panel('Research defaults', {
      subtitle: 'Used for research when a project has no saved Claude settings of its own.',
      children: [webDefault.node, materialDefault.node, defaultsMsg],
      footer: [button('Save defaults', { on: async function () {
        try {
          var next4 = await ctx.api.saveSettings(data.revision, { defaults: { web_search: webDefault.input.checked, include_materials: materialDefault.input.checked } });
          ctx.store.patch({ settings: next4 });
          defaultsMsg.textContent = 'Defaults saved.';
          ctx.rerender();
        } catch (error) { defaultsMsg.textContent = error.message; }
      } })]
    }));

    var capabilities = capabilityPanel(data.capabilities);
    if (capabilities) body.append(capabilities);

    paint();
    return body;
  }

  Views.settings = { render: render, title: 'Settings', eyebrow: 'Configuration', subtitle: 'Provider credentials, models, research defaults and local media capability.' };
})(window);
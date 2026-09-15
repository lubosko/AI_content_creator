'use strict';
/* Project picker: create a project from a simple prompt, or open an existing one.
   This is the only place a project is created. */
(function (root) {
  var el = root.Dom.el;
  var button = root.Dom.button;
  var C = root.Components;
  var Views = root.Views = root.Views || {};

  var DRAFT_KEY = 'socialContentAgentDraft';

  function readDraft() {
    try { return JSON.parse(window.localStorage.getItem(DRAFT_KEY) || 'null'); } catch (error) { return null; }
  }

  function visualProviders(value) {
    var map = {
      leonardo_mootion: { sceneProvider: 'leonardo', sequenceProvider: 'mootion' },
      leonardo_only: { sceneProvider: 'leonardo', sequenceProvider: 'none' },
      mootion_only: { sceneProvider: 'none', sequenceProvider: 'mootion' },
      manual_only: { sceneProvider: 'manual', sequenceProvider: 'none' }
    };
    return map[value] || map.leonardo_mootion;
  }

  function parseDurationSeconds(value) {
    var text = String(value || '').trim().toLowerCase();
    var number = Number.parseFloat(text);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    if (text.indexOf('sec') >= 0) return Math.round(number);
    return Math.round(number * 60);
  }

  function render(ctx) {
    var state = ctx.store.snapshot();
    var draft = readDraft() || {};
    var body = el('div', { class: 'stack' });

    // --- create ---
    var prompt = C.textArea({ id: 'prompt', value: draft.prompt || '', rows: 4, placeholder: 'Create an 8-minute YouTube video about humanoid robots in factories for technology enthusiasts.' });
    var advanced = el('details');
    var language = C.textInput({ id: 'language', value: draft.language || 'en' });
    var tone = C.textInput({ id: 'tone', value: draft.tone || 'Clear, cinematic, practical' });
    var duration = C.textInput({ id: 'duration', value: draft.duration || '8 min' });
    var visualSelect = C.select({ id: 'visualProvider', value: draft.visualProvider || 'manual_only' }, [
      { value: 'manual_only', label: 'Manual / own media only' },
      { value: 'leonardo_only', label: 'Leonardo scenes' },
      { value: 'mootion_only', label: 'Mootion sequences' },
      { value: 'leonardo_mootion', label: 'Leonardo scenes and Mootion sequences' }
    ]);
    var selectedPlatforms = (draft.targetPlatforms || ['youtube']).slice();
    var platformChips = C.chips([
      { value: 'youtube', label: 'YouTube' },
      { value: 'youtube_shorts', label: 'YouTube Shorts' },
      { value: 'tiktok', label: 'TikTok' },
      { value: 'instagram', label: 'Instagram' },
      { value: 'facebook', label: 'Facebook' }
    ], selectedPlatforms, function (value, chip) {
      var index = selectedPlatforms.indexOf(value);
      if (index >= 0) selectedPlatforms.splice(index, 1); else selectedPlatforms.push(value);
      chip.setAttribute('aria-pressed', String(selectedPlatforms.indexOf(value) >= 0));
    });

    advanced.append(el('summary', { text: 'Advanced preferences' }));
    advanced.append(el('div', { class: 'panel-body' }, [
      el('div', { class: 'grid cols-2' }, [
        C.field('Language', language),
        C.field('Tone', tone, { hint: 'Comma-separated descriptors.' })
      ]),
      C.field('Target duration', duration, { hint: 'For example "8 min" or "180 sec".' }),
      C.field('Target platforms', platformChips),
      C.field('Visual generation', visualSelect, { hint: 'Adapters are not connected yet, so this records intent only.' })
    ]));

    function payload() {
      var result = {
        prompt: prompt.value,
        llmProvider: 'anthropic',
        voiceProvider: 'elevenlabs',
        language: language.value,
        tone: tone.value,
        targetDurationSeconds: parseDurationSeconds(duration.value),
        primaryPlatform: selectedPlatforms[0] || 'youtube',
        targetPlatforms: selectedPlatforms.slice()
      };
      Object.assign(result, visualProviders(visualSelect.value));
      if (!advanced.open) {
        ['targetDurationSeconds', 'targetPlatforms', 'primaryPlatform', 'language', 'tone'].forEach(function (key) { delete result[key]; });
      }
      return result;
    }

    var saveDraft = button('Save draft in browser', { on: function () {
      try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(payload())); C.toast('Draft saved in this browser. It is not a project yet.'); }
      catch (error) { C.toast('Could not save a draft in this browser.', 'error'); }
    } });

    var start = button('Start project', { variant: 'primary', on: async function () {
      if (!prompt.value.trim()) { C.toast('Describe what you want to create first.', 'error'); prompt.focus(); return; }
      start.setBusy(true, 'Creating');
      try {
        var created = await ctx.api.createProject(Object.assign(payload(), { prompt: prompt.value.trim() }));
        C.toast('Project created locally.');
        await ctx.openProject(created.folder);
        await ctx.refreshProjects();
        ctx.navigate(root.Router.projectHref(created.folder, 'brief'));
      } catch (error) {
        C.toast(error.message, 'error');
      } finally {
        start.setBusy(false);
      }
    } });

    var createPanel = C.panel('Start with an idea', {
      subtitle: 'A short prompt is enough. You will confirm the brief before anything is generated.',
      actions: saveDraft,
      children: [
        C.field('What should this video be about?', prompt),
        advanced,
        el('div', { class: 'banner info' }, el('div', { class: 'banner-text' }, [
          el('strong', { text: 'What happens next' }),
          el('span', { text: 'The project is scaffolded locally, then you confirm the brief and add your own material before research is generated.' })
        ]))
      ],
      footer: [start]
    });
    body.append(createPanel);

    // --- open existing ---
    var list = el('div', { class: 'project-list' });
    if (!state.projects.length) {
      list.append(C.empty('No projects yet', 'Create your first project above.'));
    } else {
      state.projects.forEach(function (project) {
        var open = button('Open', { on: function () { ctx.openProject(project.folder).then(function () { ctx.navigate(root.Router.projectHref(project.folder, null)); }).catch(function (error) { C.toast(error.message, 'error'); }); } });
        list.append(el('div', { class: 'project-row' }, [
          el('div', { class: 'project-row-main' }, [
            el('strong', { text: project.topic || project.folder }),
            el('div', { class: 'project-row-meta' }, [
              el('span', { class: 'mono', text: project.project_id || '' }),
              el('span', { text: C.formatDuration(project.target_duration_seconds) }),
              el('span', { text: 'Updated ' + C.relativeTime(project.updated_at) })
            ])
          ]),
          el('div', { class: 'row' }, [C.pill(project.status || 'created'), open])
        ]));
      });
    }
    body.append(C.panel('Saved projects', { subtitle: 'Projects are stored locally under projects/.', children: list, flush: false }));

    return body;
  }

  Views.picker = { render: render, title: 'Your projects', eyebrow: 'Projects', subtitle: 'Create a new project or resume a saved one.' };
})(window);
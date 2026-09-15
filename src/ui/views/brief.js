'use strict';
/* Brief stage: review the inferred brief, correct it, and confirm it.
   Confirming is a real approval record and is required before material or research. */
(function (root) {
  var el = root.Dom.el;
  var button = root.Dom.button;
  var C = root.Components;
  var Views = root.Views = root.Views || {};

  var FIELDS = [
    { key: 'topic', label: 'Topic', hint: 'What the video is about.' },
    { key: 'audience', label: 'Audience', hint: 'Who it is for.' },
    { key: 'angle', label: 'Angle', hint: 'The specific take that makes this worth watching.' },
    { key: 'purpose', label: 'Purpose', hint: 'What the viewer should take away.' }
  ];

  function render(ctx) {
    var state = ctx.store.snapshot();
    var brief = state.brief || {};
    var workflow = ctx.store.workflow();
    var briefState = (workflow.brief || {}).state || 'ready';
    var body = el('div', { class: 'stack' });
    var controls = {};

    var notice = briefState === 'approved'
      ? C.banner('ok', 'Brief confirmed', 'Approved at revision ' + (workflow.brief || {}).revision + '. Editing and confirming again will mark later stages as needing review.')
      : C.banner('warn', 'Review needed', 'Nothing is generated until you confirm this brief. Check the inferred values and correct anything wrong.');
    body.append(notice);

    var grid = el('div', { class: 'grid cols-2' });
    FIELDS.forEach(function (item) {
      var input = C.textInput({ id: 'brief-' + item.key, value: brief[item.key] || '' });
      controls[item.key] = input;
      grid.append(C.field(item.label, input, { hint: item.hint }));
    });
    body.append(grid);

    var duration = C.textInput({ id: 'brief-duration', type: 'number', value: String(brief.target_duration_seconds || 180), min: '1', max: '14400' });
    controls.duration = duration;
    var language = C.textInput({ id: 'brief-language', value: brief.language || 'en' });
    controls.language = language;
    var tone = C.textInput({ id: 'brief-tone', value: brief.tone || '' });
    controls.tone = tone;

    var platforms = ['youtube', 'youtube_shorts', 'tiktok', 'instagram', 'facebook'];
    var selected = (brief.target_platforms || ['youtube']).slice();
    var platformChips = C.chips(platforms.map(function (value) { return { value: value, label: root.Stages.label(value) }; }), selected, function (value, chip) {
      var index = selected.indexOf(value);
      if (index >= 0) selected.splice(index, 1); else selected.push(value);
      chip.setAttribute('aria-pressed', String(selected.indexOf(value) >= 0));
    });

    var confirm = button(briefState === 'approved' ? 'Save and re-confirm brief' : 'Confirm brief', { variant: 'primary', on: async function () {
      var missing = FIELDS.map(function (item) { return item.key; }).filter(function (key) { return !controls[key].value.trim(); });
      if (missing.length) { C.toast('Complete: ' + missing.join(', ') + '.', 'error'); controls[missing[0]].focus(); return; }
      if (!selected.length) { C.toast('Choose at least one platform.', 'error'); return; }
      var seconds = Number(duration.value);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 14400) { C.toast('Duration must be between 1 and 14400 seconds.', 'error'); return; }
      confirm.setBusy(true, 'Saving');
      try {
        var payload = {};
        FIELDS.forEach(function (item) { payload[item.key] = controls[item.key].value.trim(); });
        payload.language = language.value.trim();
        payload.tone = tone.value.trim();
        payload.target_duration_seconds = seconds;
        payload.target_platforms = selected.slice();
        await ctx.saveBrief(payload);
        C.toast('Brief confirmed.');
        await ctx.refresh();
        ctx.navigate(root.Router.projectHref(state.folder, 'material'));
      } catch (error) {
        C.toast(error.message, 'error');
      } finally {
        confirm.setBusy(false);
      }
    } });

    body.append(C.panel('Format and platforms', {
      children: [
        el('div', { class: 'grid cols-2' }, [
          C.field('Target duration (seconds)', duration),
          C.field('Language', language)
        ]),
        C.field('Tone', tone),
        C.field('Target platforms', platformChips, { hint: 'The first selection becomes the primary platform.' })
      ],
      footer: [confirm]
    }));

    if (brief.original_prompt) {
      body.append(C.panel('Original idea', { children: el('p', { text: brief.original_prompt }) }));
    }
    return body;
  }

  Views.brief = { render: render, title: 'Brief', eyebrow: 'Stage 1 of 10', subtitle: 'Confirm the topic, audience, angle, purpose, format and platforms.' };
})(window);
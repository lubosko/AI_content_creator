'use strict';
/* Reusable components. Every visual primitive in section 9.4 of the completion strategy lives
   here so stages stay declarative and the design stays consistent. */
(function (root) {
  var el = root.Dom.el;
  var append = root.Dom.append;
  var set = root.Dom.set;
  var clear = root.Dom.clear;
  var button = root.Dom.button;

  function panel(title, options) {
    var opts = options || {};
    var head = null;
    if (title) {
      head = el('div', { class: 'panel-head' }, [
        el('div', { class: 'panel-head-text' }, [
          el('h2', { text: title }),
          opts.subtitle ? el('p', { text: opts.subtitle }) : null
        ]),
        opts.actions || null
      ]);
    }
    var body = el('div', { class: 'panel-body' + (opts.flush ? ' flush' : '') });
    var foot = opts.footer ? el('div', { class: 'panel-foot' }, opts.footer) : null;
    var node = el('section', { class: 'panel' + (opts.class ? ' ' + opts.class : ''), id: opts.id }, [head, body, foot]);
    node.body = body;
    if (opts.children) append(body, opts.children);
    return node;
  }

  function field(labelText, control, options) {
    var opts = options || {};
    var id = opts.id || ('f-' + Math.random().toString(36).slice(2, 9));
    if (!control.id) control.id = id;
    return el('div', { class: 'field' }, [
      el('label', { text: labelText, htmlFor: control.id }),
      control,
      opts.hint ? el('p', { class: 'field-hint', text: opts.hint }) : null,
      opts.error ? el('p', { class: 'field-error', text: opts.error }) : null
    ]);
  }

  function textInput(options) {
    var opts = options || {};
    return el('input', {
      type: opts.type || 'text', id: opts.id, value: opts.value, placeholder: opts.placeholder,
      attrs: { autocomplete: 'off', inputmode: opts.inputmode, min: opts.min, max: opts.max, 'aria-label': opts.ariaLabel || null }
    });
  }

  function textArea(options) {
    var opts = options || {};
    return el('textarea', { id: opts.id, value: opts.value, placeholder: opts.placeholder, attrs: { rows: opts.rows || 5, 'aria-label': opts.ariaLabel || null } });
  }

  function select(options, items) {
    var opts = options || {};
    var node = el('select', { id: opts.id, attrs: { 'aria-label': opts.ariaLabel || null } });
    for (var i = 0; i < items.length; i++) {
      node.append(el('option', { value: items[i].value, text: items[i].label, disabled: items[i].disabled }));
    }
    if (opts.value !== undefined) node.value = opts.value;
    return node;
  }

  function checkbox(labelText, options) {
    var opts = options || {};
    var input = el('input', { type: 'checkbox', id: opts.id, checked: opts.checked });
    return { node: el('label', { class: 'check', htmlFor: input.id }, [input, el('span', { text: labelText })]), input: input };
  }

  function chips(items, selected, onToggle) {
    var wrap = el('div', { class: 'chips' });
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var on = selected.indexOf(item.value) >= 0;
        var chip = el('button', {
          class: 'chip', type: 'button', text: item.label,
          attrs: { 'aria-pressed': String(on), 'data-platform': item.value },
          on: { click: function () { onToggle(item.value, chip); } }
        });
        wrap.append(chip);
      })(items[i]);
    }
    return wrap;
  }

  function pill(state) {
    return el('span', { class: 'pill ' + root.Stages.tone(state), text: root.Stages.label(state) });
  }

  function banner(tone, title, message, options) {
    var opts = options || {};
    return el('div', { class: 'banner ' + (tone || 'info'), attrs: { role: tone === 'error' ? 'alert' : 'status' } }, [
      el('div', { class: 'banner-text' }, [
        title ? el('strong', { text: title }) : null,
        message ? el('span', { text: message }) : null,
        opts.extra || null
      ]),
      opts.actions || null
    ]);
  }

  function metrics(items) {
    var wrap = el('div', { class: 'metrics' });
    for (var i = 0; i < items.length; i++) {
      wrap.append(el('div', { class: 'metric' }, [
        el('div', { class: 'metric-label', text: items[i].label }),
        el('div', { class: 'metric-value' + (items[i].numeric ? ' num' : ''), text: items[i].value }),
        items[i].note ? el('div', { class: 'metric-note', text: items[i].note }) : null
      ]));
    }
    return wrap;
  }

  function empty(title, message, action) {
    return el('div', { class: 'empty' }, [
      el('h3', { text: title }),
      message ? el('p', { text: message }) : null,
      action || null
    ]);
  }

  function skeleton(lines) {
    var wrap = el('div', { class: 'stack' });
    for (var i = 0; i < (lines || 3); i++) wrap.append(el('div', { class: 'skeleton line' }));
    return wrap;
  }

  function progress(value) {
    var bar = el('span', { props: { style: 'width:' + Math.max(0, Math.min(100, value)) + '%' } });
    return el('div', { class: 'progress', attrs: { role: 'progressbar', 'aria-valuenow': String(Math.round(value)), 'aria-valuemin': '0', 'aria-valuemax': '100' } }, bar);
  }

  function toast(message, tone) {
    var host = document.getElementById('toasts');
    if (!host) return;
    var node = el('div', { class: 'toast' + (tone ? ' ' + tone : ''), text: message });
    host.append(node);
    window.setTimeout(function () { node.remove(); }, tone === 'error' ? 6000 : 3200);
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return null;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return 'not set';
    if (seconds >= 60 && seconds % 60 === 0) return (seconds / 60) + ' min';
    if (seconds >= 60) return Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' sec';
    return seconds + ' sec';
  }

  function relativeTime(value) {
    if (!value) return 'unknown';
    var then = new Date(value).getTime();
    if (!Number.isFinite(then)) return 'unknown';
    var diff = Date.now() - then;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.round(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.round(diff / 3600000) + ' h ago';
    return new Date(value).toLocaleDateString();
  }

  /* Human-readable analysis detail, built only from what analysis actually read. */
  function analysisDetail(summary) {
    var record = summary && summary.record;
    if (!summary || !record) return null;
    if (summary.state === 'needs_confirmation') {
      var minutes = summary.estimate ? summary.estimate.minutes : Math.round((summary.durationSeconds || 0) / 60);
      var cost = summary.estimate ? ' About $' + summary.estimate.usd.toFixed(2) + ' to transcribe.' : '';
      var suffix = record.media && record.media.videoCodec ? ' ' + record.media.width + 'x' + record.media.height + ' ' + record.media.videoCodec + '.' : '';
      return 'Metadata read only. This file is about ' + minutes + ' minute(s) long, so speech has not been transcribed yet.' + cost + suffix;
    }
    if (summary.state !== 'analyzed') return null;
    var parts = [];
    if (record.content && record.content.characters) parts.push(record.content.characters.toLocaleString() + ' characters read');
    if (record.content && record.content.truncated) parts.push('truncated');
    if (record.pages) parts.push(record.pages + ' page(s)');
    if (record.transcription && record.transcription.status === 'done') parts.push('transcribed with ' + record.transcription.model);
    if (record.media) {
      if (record.media.width && record.media.height) parts.push(record.media.width + 'x' + record.media.height);
      if (record.media.aspectRatio) parts.push(record.media.aspectRatio);
      if (record.media.durationSeconds) parts.push(record.media.durationSeconds.toFixed(1) + 's');
      if (record.media.videoCodec) parts.push(record.media.videoCodec);
      if (record.media.audioCodec) parts.push(record.media.audioCodec);
      if (record.media.sampleRate) parts.push(record.media.sampleRate + ' Hz');
    }
    return parts.length ? parts.join(' | ') : null;
  }

  /* Analysis state for a card. Prefers the server's summary; falls back to the recorded state so an
     asset saved before this feature still reports honestly instead of claiming to be analyzed. */
  function analysisState(asset) {
    if (asset.analysis_summary) return asset.analysis_summary;
    var state = (asset.analysis && asset.analysis.state) || asset.analysis_state || 'awaiting_analysis';
    var labels = {awaiting_analysis: 'Awaiting analysis', analyzing: 'Analyzing', analyzed: 'Analyzed', failed: 'Analysis failed', unsupported: 'Not supported', needs_confirmation: 'Confirm transcription'};
    var tones = {awaiting_analysis: 'info', analyzing: 'running', analyzed: 'ok', failed: 'failed', unsupported: 'locked', needs_confirmation: 'review'};
    var record = asset.analysis || null;
    return {
      state: state,
      label: labels[state] || 'Awaiting analysis',
      tone: tones[state] || 'info',
      message: (record && record.reason) || '',
      retryable: state === 'failed' && record ? record.retryable !== false : false,
      needsConfirmation: state === 'needs_confirmation',
      estimate: (record && record.transcription && record.transcription.estimate) || null,
      durationSeconds: (record && record.transcription && record.transcription.durationSeconds) || null,
      canAnalyze: state === 'awaiting_analysis',
      record: record
    };
  }

  /* The server decides what may be used; the browser only renders that decision. An asset with no
     summary falls back to "not confirmed", so a card can never look cleared by accident. */
  function rightsState(asset) {
    if (asset.rights_summary) return asset.rights_summary;
    return {state: 'blocked', basis: 'unknown', short: 'Rights not confirmed', tone: 'failed', reasons: ['Rights are not confirmed.'], warnings: [], attribution: null};
  }

  function rightsTone(rights) {
    if (rights.state === 'cleared') return 'ok';
    if (rights.state === 'warning') return 'review';
    return 'failed';
  }

  function rightsLabel(rights) { return 'Rights: ' + (rights.short || rights.label || 'not confirmed'); }

  /* The one place library assets are rendered. Imported never looks analyzed: the badge reflects
     the recorded analysis state, and a failure shows its real reason with a retry only when one
     could actually change the outcome. */
  function assetCard(asset, options) {
    var opts = options || {};
    var selection = opts.selection || null;
    var decision = selection ? selection.decision : null;
    var summary = analysisState(asset);
    var rights = rightsState(asset);
    var detail = analysisDetail(summary);
    var card = el('article', { class: 'asset', dataset: { decision: decision || '', assetId: asset.id, missing: String(!!asset.missing), analysis: summary.state } });

    var previewable = asset.kind === 'file' && !asset.missing;
    var mime = String(asset.mime || '');
    var thumbnail = previewable && asset.analysis && asset.analysis.thumbnail ? root.Api.thumbnailUrl(asset.id) : null;

    if (thumbnail) card.append(el('img', { class: 'asset-preview', src: thumbnail, attrs: { alt: 'Preview frame of ' + asset.name, loading: 'lazy' } }));
    else if (previewable && mime.indexOf('image/') === 0) card.append(el('img', { class: 'asset-preview', src: root.Api.fileUrl(asset.id), attrs: { alt: asset.name, loading: 'lazy' } }));
    else if (previewable && mime.indexOf('video/') === 0) card.append(el('video', { class: 'asset-preview', src: root.Api.fileUrl(asset.id), attrs: { controls: 'controls', preload: 'metadata' } }));
    else if (previewable && mime.indexOf('audio/') === 0) card.append(el('audio', { class: 'asset-preview asset-preview-audio', src: root.Api.fileUrl(asset.id), attrs: { controls: 'controls', preload: 'metadata' } }));

    var badges = [el('span', { class: 'pill ' + summary.tone, text: summary.label })];
    badges.push(el('span', { class: 'pill ' + rightsTone(rights), text: rightsLabel(rights) }));
    if (asset.missing) badges.push(el('span', { class: 'pill failed', text: 'File missing' }));
    var title = el('div', { class: 'asset-title' }, [el('h4', { text: asset.name }), el('div', { class: 'row' }, badges)]);

    var metaParts = [asset.kind, asset.category, formatBytes(asset.size)];
    var main = el('div', { class: 'asset-main' }, [
      title,
      el('p', { class: 'asset-meta', text: metaParts.filter(Boolean).join(' | ') })
    ]);

    if (asset.missing) main.append(el('p', { class: 'asset-meta', text: 'The saved original is missing. Import the file again.' }));
    else if (summary.state === 'analyzed' || summary.state === 'needs_confirmation') main.append(el('p', { class: 'asset-meta', text: detail || (summary.state === 'analyzed' ? 'Analyzed.' : summary.message) }));
    else if (summary.message) main.append(el('p', { class: 'asset-meta', text: summary.message }));

    var warnings = (summary.record && summary.record.warnings) || [];
    for (var w = 0; w < warnings.length; w++) main.append(el('p', { class: 'asset-meta', text: warnings[w] }));
    if (summary.record && summary.record.note) main.append(el('p', { class: 'asset-meta', text: summary.record.note }));

    /* Rights are stated on the card only when they matter: an item that can reach the video and
       cannot legally be used, or one whose licence obliges a credit in the finished video. An item
       that cannot reach the video says so, rather than showing a red warning it does not need. */
    var gated = asset.publishable !== false;
    var rightsMatters = decision === 'use' || rights.state !== 'cleared';
    if (rightsMatters && rights.state === 'blocked') {
      if (gated) {
        for (var r = 0; r < (rights.reasons || []).length; r++) main.append(el('p', { class: 'field-error', text: rights.reasons[r] }));
      } else {
        main.append(el('p', { class: 'asset-meta', text: 'No licence is needed while this stays a knowledge reference: it is read for research, never published. File it as media to use it inside the video.' }));
      }
    } else if (rightsMatters && rights.state === 'warning') {
      for (var v = 0; v < (rights.warnings || []).length; v++) main.append(el('p', { class: 'asset-meta', text: rights.warnings[v] }));
    }
    if (gated && rights.attribution) main.append(el('p', { class: 'asset-meta', text: 'Credit: ' + rights.attribution }));

    if (asset.kind === 'note' && asset.content) main.append(el('div', { class: 'asset-excerpt', text: asset.content }));
    if (asset.kind === 'url' && asset.content) main.append(el('a', { class: 'mono', href: asset.content, text: asset.content, attrs: { target: '_blank', rel: 'noopener noreferrer' } }));
    if (asset.kind === 'file' && !asset.missing) main.append(el('a', { class: 'mono', href: root.Api.fileUrl(asset.id), text: 'Open saved original', attrs: { target: '_blank', rel: 'noopener' } }));

    if (summary.state === 'analyzed' && summary.record && summary.record.content && summary.record.content.text) {
      var label = summary.record.transcription && summary.record.transcription.status === 'done' ? 'Transcript' : (summary.record.detected && summary.record.detected.type === 'pdf' ? 'Extracted text' : 'Extracted text');
      var details = el('details');
      details.append(el('summary', { text: label }));
      if (summary.record.transcription && summary.record.transcription.status === 'done') {
        details.append(el('p', { class: 'asset-meta', text: 'Transcribed with ' + summary.record.transcription.model + (summary.record.transcription.costUsd ? ' | cost about $' + summary.record.transcription.costUsd.toFixed(4) : '') }));
      }
      details.append(el('pre', { text: summary.record.content.text.slice(0, 4000) }));
      main.append(details);
    }
    // A transcription problem is stated even when the media metadata was read fine.
    if (summary.record && summary.record.transcription && summary.record.transcription.status === 'failed') {
      main.append(el('p', { class: 'field-error', text: 'Transcription failed: ' + summary.record.transcription.reason }));
    }
    if (summary.record && summary.record.transcription && summary.record.transcription.status === 'none' && summary.record.transcription.reason) {
      main.append(el('p', { class: 'asset-meta', text: summary.record.transcription.reason }));
    }

    card.append(main);

    if (opts.onDecision || opts.onAnalyze) {
      var actions = el('div', { class: 'asset-actions' });
      if (opts.onAnalyze && summary.canAnalyze) {
        var analyzeBtn = button(summary.state === 'failed' ? 'Retry analysis' : 'Analyze', { size: 'sm', on: function () { opts.onAnalyze(analyzeBtn); } });
        actions.append(analyzeBtn);
      }
      // Long audio needs an explicit decision because transcription costs money per minute.
      if (opts.onConfirmTranscribe && summary.needsConfirmation) {
        var estimate = summary.estimate;
        var confirmBtn = button(estimate ? 'Transcribe (~$' + estimate.usd.toFixed(2) + ')' : 'Transcribe', { size: 'sm', variant: 'primary', on: function () { opts.onConfirmTranscribe(confirmBtn); } });
        actions.append(confirmBtn);
      }
      if (opts.onDecision) {
        var decisionButtons = [['use', 'Use'], ['maybe', 'Maybe'], ['skip', 'Skip']];
        if (selection) decisionButtons.push(['remove', 'Remove from project']);
        for (var i = 0; i < decisionButtons.length; i++) {
          (function (pair) {
            var isCurrent = decision === pair[0];
            var action = button(pair[1], {
              size: 'sm', variant: isCurrent && pair[0] !== 'remove' ? 'primary' : (pair[0] === 'remove' ? 'danger' : ''),
              disabled: !!asset.missing && pair[0] !== 'remove',
              on: function () { opts.onDecision(pair[0]); }
            });
            if (isCurrent && pair[0] !== 'remove') action.setAttribute('aria-pressed', 'true');
            actions.append(action);
          })(decisionButtons[i]);
        }
      }
      // Recording rights is offered before Use, because Use is what the gate blocks.
      if (opts.onRights) {
        var needed = rights.state === 'blocked' && gated;
        var rightsBtn = button(needed ? 'Record rights' : 'Rights', {
          size: 'sm', variant: needed ? 'primary' : '',
          on: function () { opts.onRights(rightsBtn); }
        });
        actions.append(rightsBtn);
      }
      card.append(actions);
    }
    return card;
  }

  /* Renders the server's result file payload. Markdown is converted to text nodes only. */
  function renderDocument(container, content) {
    var list = null;
    var lines = String(content).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var heading = line.match(/^(#{1,3}) (.*)$/);
      var bullet = line.match(/^(?:- |\d+\. )(.*)$/);
      if (bullet) {
        if (!list) { list = el('ul'); container.append(list); }
        list.append(el('li', { text: bullet[1] }));
        continue;
      }
      list = null;
      if (!line.trim()) continue;
      var tag = heading ? 'h' + Math.min(heading[1].length + 1, 4) : 'p';
      container.append(el(tag, { text: heading ? heading[2] : line }));
    }
  }

  function safeUrl(value) {
    try {
      var url = new URL(value);
      if (['http:', 'https:'].indexOf(url.protocol) < 0 || url.username || url.password) return null;
      return url.href;
    } catch (error) { return null; }
  }

  function resultFiles(payload) {
    var wrap = el('div', { class: 'doc' });
    var files = (payload && payload.files) || [];
    var rendered = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (file.path.indexOf('provider_result.json') >= 0 && !file.content) continue;
      if (file.path.indexOf('sources.json') >= 0 && file.content) {
        var parsed = null;
        try { parsed = JSON.parse(file.content); } catch (error) { parsed = null; }
        var sources = (parsed && parsed.sources) || [];
        if (sources.length) {
          wrap.append(el('h3', { text: 'Source links' }));
          for (var s = 0; s < sources.length; s++) {
            var href = safeUrl(sources[s].url);
            if (!href) continue;
            wrap.append(el('p', {}, el('a', { href: href, text: '[' + sources[s].id + '] ' + (sources[s].title || href), attrs: { target: '_blank', rel: 'noopener noreferrer' } })));
          }
        }
      }
      wrap.append(el('p', { class: 'doc-file', text: file.path }));
      if (file.content === null) {
        wrap.append(el('p', { text: 'No saved result for this file yet.' }));
      } else if (file.path.slice(-3) === '.md') {
        renderDocument(wrap, file.content);
        rendered++;
      } else {
        wrap.append(el('details', {}, [el('summary', { text: 'View supporting data' }), el('pre', { text: file.content })]));
        rendered++;
      }
    }
    if (!rendered) wrap.append(empty('Nothing saved yet', 'Generate this stage to create a saved result.'));
    return wrap;
  }

  /* Puts a live element after a field's label and control. Kept separate so the reason is explicit:
     field hints are text, and an element passed as one would be shown as "[object ...]". */
  function appendFieldConsequence(fieldNode, node) {
    fieldNode.append(node);
    return fieldNode;
  }

  /* The rights form. What each licence permits is shown from the licence data the server sent, so
     the operator sees the consequence before saving rather than after a render is blocked. */
  function rightsDialog(options) {
    var opts = options || {};
    var licences = opts.licences || [];
    var byId = {};
    for (var i = 0; i < licences.length; i++) byId[licences[i].id] = licences[i];
    var current = opts.rights || {};
    var subject = opts.subject || 'this item';

    var backdrop = el('div', { class: 'modal-backdrop' });
    var basis = select({ id: 'rightsBasis', value: current.basis || 'unknown' }, licences.map(function (l) {
      return { value: l.id, label: l.short + ' — ' + l.label };
    }));
    var title = textInput({ id: 'rightsTitle', value: current.title || '', placeholder: 'Original title' });
    var holder = textInput({ id: 'rightsHolder', value: current.holder || '', placeholder: 'Creator, channel, or rights holder' });
    var source = textInput({ id: 'rightsSource', value: current.source_url || '', placeholder: 'https:// where it came from' });
    var note = textArea({ id: 'rightsNote', rows: 2, placeholder: 'How permission was given, or anything worth recording.' });
    note.value = current.note || '';
    var consequence = el('p', { class: 'field-hint' });
    var error = el('p', { class: 'field-error' });
    var save = button('Save rights', { variant: 'primary' });
    var cancel = button('Cancel');
    // These three change with the basis: material you made yourself has nobody else to credit and
    // nowhere it "came from", so asking for a rights holder would be asking a meaningless question.
    var holderLabel = el('label', { text: 'Creator or rights holder', htmlFor: holder.id });
    var sourceLabel = el('label', { text: 'Where it came from', htmlFor: source.id });
    var sourceHint = el('p', { class: 'field-hint', text: 'Required for Creative Commons material, because the credit must point at the original.' });

    function describe() {
      var licence = byId[basis.value] || {};
      var mine = !!licence.self_owned;
      holderLabel.textContent = mine ? 'Who made it (optional)' : 'Creator or rights holder';
      sourceLabel.textContent = mine ? 'Where it came from (optional)' : 'Where it came from';
      holder.placeholder = mine ? 'You, or the tool you used' : 'Creator, channel, or rights holder';
      source.placeholder = mine ? 'https:// (only for your own records)' : 'https:// where it came from';
      note.placeholder = mine ? 'Anything worth remembering about this file.' : 'How permission was given, or anything worth recording.';
      sourceHint.textContent = mine
        ? 'Not required. It is kept as provenance for your own records, nothing more.'
        : 'Required for Creative Commons material, because the credit must point at the original.';
      if (!licence.reuse) { consequence.textContent = 'Without a confirmed basis this material cannot be used in a video.'; return; }
      var parts = [];
      if (mine) parts.push('Your own material: nothing has to be credited or declared');
      parts.push(licence.commercial ? 'Commercial use allowed' : 'Non-commercial only: a monetised video cannot use it');
      parts.push(licence.derivatives ? 'editing allowed' : 'no derivatives: it cannot be cut into your video');
      parts.push(licence.attribution ? 'a credit is required' : 'no credit required');
      if (licence.shareAlike) parts.push('the finished video must carry the same licence');
      consequence.textContent = parts.join('. ') + '.';
    }
    basis.addEventListener('change', describe);
    describe();

    var modal = el('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Rights for ' + subject } }, [
      el('div', { class: 'panel-head' }, el('div', { class: 'panel-head-text' }, [
        el('h2', { text: 'Rights for ' + subject }),
        el('p', { text: 'The rights gate blocks material with no recorded basis. Recording it here is what lets this material into a render.' })
      ])),
      el('div', { class: 'stack' }, [
        // The consequence is a live node, not a hint string: field() renders hints as text and would
        // stringify an element instead of showing it.
        appendFieldConsequence(field('Basis for using it', basis), consequence),
        el('div', { class: 'grid cols-2' }, [field('Original title', title), el('div', { class: 'field' }, [holderLabel, holder])]),
        el('div', { class: 'field' }, [sourceLabel, source, sourceHint]),
        field('Note', note),
        error
      ]),
      el('div', { class: 'panel-foot' }, [cancel, save])
    ]);
    backdrop.append(modal);

    function close(notify) { backdrop.remove(); document.removeEventListener('keydown', onKey); if (notify && opts.onCancel) opts.onCancel(); }
    function onKey(event) { if (event.key === 'Escape') close(true); }
    cancel.addEventListener('click', function () { close(true); });
    backdrop.addEventListener('click', function (event) { if (event.target === backdrop) close(true); });
    document.addEventListener('keydown', onKey);
    save.addEventListener('click', function () {
      error.textContent = '';
      save.setBusy(true, 'Saving');
      Promise.resolve(opts.onSave({
        basis: basis.value,
        title: title.value,
        holder: holder.value,
        source_url: source.value,
        note: note.value
      })).then(function () { close(false); }).catch(function (problem) {
        // A rejected record keeps the dialog open with the reason, so nothing is lost.
        error.textContent = problem.message;
        save.setBusy(false);
      });
    });
    document.body.append(backdrop);
    basis.focus();
    return backdrop;
  }

  /* Copying a prompt. The clipboard API needs a secure context, which localhost and 127.0.0.1 are,
     but it is absent under the test harness and in some browsers, so the fallback shows the text
     selected for a manual copy instead of failing silently. */
  function copyText(text) {
    var value = String(text === undefined || text === null ? '' : text);
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      return root.navigator.clipboard.writeText(value).then(function () { return 'copied'; }, function () { return revealForCopy(value); });
    }
    return Promise.resolve(revealForCopy(value));
  }

  function revealForCopy(value) {
    var existing = document.getElementById('copyFallback');
    if (existing) existing.remove();
    var box = textArea({ id: 'copyFallback', rows: 4, ariaLabel: 'Press Ctrl+C to copy this prompt' });
    box.value = value;
    var panel = el('div', { class: 'stack tight' }, [
      el('p', { class: 'field-hint', text: 'Your browser did not allow an automatic copy. The text is selected: press Ctrl+C to copy it.' }),
      box
    ]);
    document.body.append(panel);
    try { box.focus(); box.select(); } catch (error) { /* selection is a convenience, not a requirement */ }
    toast('Select and copy the prompt, then press Escape.');
    return 'manual';
  }

  function confirmDialog(options) {
    var opts = options || {};
    var backdrop = el('div', { class: 'modal-backdrop' });
    var confirmBtn = button(opts.confirmLabel || 'Confirm', { variant: opts.danger ? 'danger' : 'primary' });
    var cancelBtn = button('Cancel');
    var modal = el('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Confirm' } }, [
      el('div', { class: 'panel-head' }, el('div', { class: 'panel-head-text' }, [el('h2', { text: opts.title || 'Confirm' }), opts.message ? el('p', { text: opts.message }) : null])),
      el('div', { class: 'panel-foot' }, [cancelBtn, confirmBtn])
    ]);
    backdrop.append(modal);
    function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); if (opts.onCancel) opts.onCancel(); }
    function onKey(event) { if (event.key === 'Escape') close(); }
    cancelBtn.addEventListener('click', close);
    confirmBtn.addEventListener('click', function () { backdrop.remove(); document.removeEventListener('keydown', onKey); opts.onConfirm(); });
    backdrop.addEventListener('click', function (event) { if (event.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    confirmBtn.focus();
    return backdrop;
  }

  root.Components = {
    el: el, append: append, clear: clear, set: set,
    panel: panel, field: field, textInput: textInput, textArea: textArea, select: select,
    checkbox: checkbox, chips: chips, pill: pill, banner: banner, metrics: metrics,
    empty: empty, skeleton: skeleton, progress: progress, toast: toast,
    assetCard: assetCard, analysisState: analysisState, analysisDetail: analysisDetail, resultFiles: resultFiles, renderDocument: renderDocument,
    confirmDialog: confirmDialog, rightsDialog: rightsDialog, rightsState: rightsState, rightsTone: rightsTone, rightsLabel: rightsLabel, safeUrl: safeUrl,
    copyText: copyText,
    formatBytes: formatBytes, formatDuration: formatDuration, relativeTime: relativeTime
  };
  root.notify = toast;
})(window);
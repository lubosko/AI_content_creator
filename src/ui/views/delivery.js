'use strict';
/* The delivery screens: the composer's master, the final check, and the platform exports.

   Each of these reads artifacts the server wrote and shows them as files the operator can watch,
   inspect and download. Nothing here re-derives a decision the server already made: the QC verdict,
   the checklist and the export manifest are displayed as they were recorded. */
(function (root) {
  var el = root.Dom.el;
  var button = root.Dom.button;
  var C = root.Components;
  var Views = root.Views = root.Views || {};

  function fileFrom(saved, pattern) {
    return ((saved || {}).files || []).filter(function (item) { return pattern.test(item.path); })[0] || null;
  }
  function parse(file) {
    if (!file || !file.content) return null;
    try { return JSON.parse(file.content); } catch (error) { return null; }
  }
  function fileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    return C.formatBytes(bytes);
  }
  function downloadLink(ctx, relativePath, label) {
    return el('a', { class: 'btn sm', href: root.Api.projectFileUrl(ctx.store.snapshot().folder, relativePath), text: label, attrs: { download: '' } });
  }

  /* The last decision recorded for an approval gate, from the decision log. The two video gates are
     approved through their own keys, so the composer's state is not what says whether the video was
     approved. */
  function gateDecision(project, key) {
    var records = ((project || {}).workflow || {}).approvals || [];
    for (var i = records.length - 1; i >= 0; i--) if (records[i].stage === key) return records[i];
    return null;
  }

  function checkRow(item) {
    var mark = item.ok === null ? C.pill('locked') : (item.ok ? C.pill('approved') : C.pill('failed'));
    var row = el('div', { class: 'stack tight' }, [
      el('div', { class: 'row gap' }, [mark, el('strong', { text: item.label })]),
      item.detail ? el('p', { class: 'metric-note', text: item.detail }) : null
    ]);
    row.dataset.checkId = item.id;
    row.dataset.checkOk = item.ok === null ? 'unmeasured' : String(!!item.ok);
    return row;
  }

  /* --- the composer --- */
  function composeWorkspace(ctx, saved) {
    var qc = parse(fileFrom(saved, /qc_report\.json$/));
    if (!qc) return null;
    /* `measured` is written only when QC inspects a real file. Without it there is no video yet — which
       is the case for a project created before the composer existed — so this says so instead of
       reading an empty report as a failure. */
    if (!qc.measured) {
      return el('div', { class: 'stack' }, [
        C.banner('info', 'No video has been composed yet', 'Press "Render the video" to compose the master. QC then inspects the file it wrote.'),
        (qc.note ? el('p', { class: 'metric-note', text: qc.note }) : null)
      ].filter(Boolean));
    }
    var log = parse(fileFrom(saved, /render_log\.json$/));
    var timeline = parse(fileFrom(saved, /timeline\.json$/));
    var folder = ctx.store.snapshot().folder;
    var wrap = el('div', { class: 'stack' });
    var measured = qc.measured || {};

    wrap.append(C.metrics([
      { label: 'Video', value: timeline ? timeline.width + 'x' + timeline.height : '—', note: timeline ? timeline.fps + ' fps' : '' },
      { label: 'Duration', value: (measured.duration_seconds || 0).toFixed(1) + 's', numeric: true, note: qc.planned ? 'planned ' + Number(qc.planned.duration_seconds).toFixed(1) + 's' : '' },
      { label: 'Size', value: fileSize(measured.size_bytes), note: measured.loudness_lufs ? Number(measured.loudness_lufs).toFixed(1) + ' LUFS' : '' },
      { label: 'Caption cues', value: String(((timeline || {}).tracks || []).filter(function (t) { return t.id === 'captions'; }).map(function (t) { return t.cues; })[0] || 0), numeric: true },
      { label: 'Blocking issues', value: String((qc.blocking_issues || []).length), numeric: true, note: qc.can_approve_master ? 'QC passed' : 'cannot be approved' }
    ]));

    wrap.append(C.banner(qc.can_approve_master ? 'ok' : 'error',
      qc.can_approve_master ? 'QC passed against the written file' : 'QC blocked this video',
      qc.can_approve_master
        ? 'Every check was made by reading the file that was written, not the plan that produced it.'
        : (qc.blocking_issues || []).join(' ')));

    if (measured.size_bytes) {
      wrap.append(C.panel('The video', {
        subtitle: 'final/youtube_master.mp4, ' + fileSize(measured.size_bytes) + '. Captions are a sidecar file so players can toggle them.',
        children: el('div', { class: 'stack tight' }, [
          el('video', { class: 'asset-preview', src: root.Api.projectFileUrl(folder, qc.master || 'final/youtube_master.mp4'), attrs: { controls: 'controls', preload: 'metadata' } }),
          el('div', { class: 'row' }, [
            downloadLink(ctx, qc.master || 'final/youtube_master.mp4', 'Download the master'),
            downloadLink(ctx, 'compose/captions.srt', 'Download the captions')
          ])
        ])
      }));
    }

    var checks = el('div', { class: 'stack tight' });
    (qc.checks || []).forEach(function (item) { checks.append(checkRow(item)); });
    wrap.append(C.panel('Quality control', { subtitle: 'Measured with ffprobe and ffmpeg against the written master.', children: checks }));

    if (log && (log.warnings || []).length) {
      var warnings = el('div', { class: 'stack tight' });
      log.warnings.forEach(function (warning) { warnings.append(el('p', { class: 'metric-note', text: warning })); });
      wrap.append(C.panel('Warnings from composition', { children: warnings }));
    }
    if (log && (log.commands || []).length) {
      var commands = el('details');
      commands.append(el('summary', { text: 'Every command the composer ran (' + log.commands.length + ')' }));
      commands.append(el('pre', { text: log.commands.map(function (entry) { return entry.step + ': ' + entry.command; }).join('\n') }));
      wrap.append(commands);
    }
    return wrap;
  }

  /* --- the final check --- */
  function finalWorkspace(ctx, saved) {
    var check = parse(fileFrom(saved, /final_check\.json$/));
    if (!check) return null;
    var metadata = parse(fileFrom(saved, /youtube_metadata\.json$/));
    var folder = ctx.store.snapshot().folder;
    var wrap = el('div', { class: 'stack' });
    var computed = (check.checks || []).filter(function (item) { return item.mode === 'computed'; });
    var manual = (check.checks || []).filter(function (item) { return item.mode === 'manual'; });

    wrap.append(C.metrics([
      { label: 'Measured checks', value: String(computed.length), numeric: true, note: computed.filter(function (i) { return i.ok; }).length + ' passing' },
      { label: 'Your confirmations', value: String(manual.length), numeric: true, note: 'asserted at approval' },
      { label: 'Duration', value: (check.master && check.master.duration_seconds ? check.master.duration_seconds.toFixed(1) : '0') + 's', numeric: true, note: check.target_duration_seconds ? 'target ' + check.target_duration_seconds + 's' : '' },
      { label: 'Blocking issues', value: String((check.blocking_issues || []).length), numeric: true }
    ]));

    wrap.append(C.banner(check.can_approve ? 'ok' : 'error',
      check.can_approve ? 'Everything measurable checks out' : 'Something measurable is wrong',
      check.can_approve
        ? 'The items below marked "yours to confirm" are the ones no check can decide. They are asserted when you approve.'
        : (check.blocking_issues || []).join(' ')));

    var media = el('div', { class: 'stack tight' }, [
      el('video', { class: 'asset-preview', src: root.Api.projectFileUrl(folder, (check.master && check.master.path) || 'final/youtube_master.mp4'), attrs: { controls: 'controls', preload: 'metadata' } }),
      el('div', { class: 'row' }, [
        downloadLink(ctx, (check.master && check.master.path) || 'final/youtube_master.mp4', 'Download the video'),
        downloadLink(ctx, 'final/youtube_thumbnail.jpg', 'Download the thumbnail'),
        downloadLink(ctx, 'compose/captions.srt', 'Download the captions')
      ])
    ]);
    if (check.master && check.master.path) {
      media.append(el('img', { class: 'asset-preview', src: root.Api.projectFileUrl(folder, 'final/youtube_thumbnail.jpg'), attrs: { alt: 'Thumbnail extracted from the video', loading: 'lazy' } }));
    }
    wrap.append(C.panel('Watch it before you approve it', { subtitle: 'The thumbnail is a frame from the video, not a separate asset.', children: media }));

    var measuredList = el('div', { class: 'stack tight' });
    computed.forEach(function (item) { measuredList.append(checkRow(item)); });
    wrap.append(C.panel('Measured against the file', { children: measuredList }));

    /* The manual items are the operator's own assertions, so they are real checkboxes and the approval
       is refused until every one of them is ticked. */
    var manualList = el('div', { class: 'stack tight' });
    manual.forEach(function (item) {
      var control = C.checkbox(item.label, { id: 'confirm-' + item.id });
      control.input.dataset.confirmId = item.id;
      manualList.append(el('div', { class: 'stack tight' }, [control.node, item.detail ? el('p', { class: 'metric-note', text: item.detail }) : null]));
    });
    wrap.append(C.panel('Yours to confirm', {
      subtitle: 'No automated check can decide these. They are recorded against the exact video you approved.',
      children: manualList
    }));

    if (metadata) {
      var rows = el('div', { class: 'stack tight' }, [
        el('p', { class: 'metric-note', text: 'Title: ' + metadata.title }),
        el('p', { class: 'metric-note', text: metadata.description.split('\n')[0] }),
        el('p', { class: 'metric-note', text: 'Tags: ' + (metadata.tags || []).join(', ') }),
        el('p', { class: 'metric-note', text: (metadata.chapters || []).length + ' chapter(s) from the timeline' }),
        el('p', { class: 'metric-note', text: metadata.note || '' })
      ]);
      wrap.append(C.panel('Metadata package', { subtitle: 'final/youtube_metadata.json', children: rows }));
    }
    return wrap;
  }

  /* --- the exports --- */
  function exportsWorkspace(ctx, saved) {
    var manifest = parse(fileFrom(saved, /export_manifest\.json$/));
    if (!manifest) return null;
    var folder = ctx.store.snapshot().folder;
    var wrap = el('div', { class: 'stack' });
    var live = (manifest.platforms || []).filter(function (item) { return item.status === 'exported'; });
    var skipped = (manifest.platforms || []).filter(function (item) { return item.status !== 'exported'; });
    var total = live.reduce(function (sum, item) { return sum + (item.bytes || 0); }, 0);

    wrap.append(C.metrics([
      { label: 'Platforms exported', value: String(live.length), numeric: true },
      { label: 'Burned captions', value: String(live.filter(function (item) { return item.captions_burned; }).length), numeric: true, note: 'the rest use a sidecar' },
      { label: 'Total size', value: fileSize(total) },
      { label: 'Master', value: (manifest.master_seconds || 0).toFixed(1) + 's', numeric: true }
    ]));

    wrap.append(C.banner('info', 'Every file here is ready to upload',
      'Vertical versions keep the whole frame: the 16:9 picture is centred over a blurred enlargement of itself, so nothing is cropped away. Each platform has its own duration limit and its own captions.'));

    /* An attribution obligation lands on the published description, so if the licences require one it
       belongs on screen next to the upload buttons, not buried in a JSON file. */
    var credits = manifest.credits || [];
    if (credits.length) {
      wrap.append(C.panel('Credits you must publish', {
        subtitle: 'required by the licences of material in this video',
        children: [
          el('ul', { class: 'list' }, credits.map(function (line) { return el('li', { text: line }); })),
          el('p', { class: 'metric-note', text: manifest.credit_note })
        ]
      }));
    } else if (manifest.credit_note) {
      wrap.append(el('p', { class: 'metric-note', text: manifest.credit_note }));
    }

    live.forEach(function (item) {
      var rows = el('div', { class: 'stack tight' }, [
        el('video', { class: 'asset-preview', src: root.Api.projectFileUrl(folder, item.video), attrs: { controls: 'controls', preload: 'metadata' } }),
        el('p', { class: 'metric-note', text: item.width + 'x' + item.height + ' (' + item.aspect_ratio + '), ' + item.duration_seconds.toFixed(1) + 's of a ' + item.max_seconds + 's limit, ' + fileSize(item.bytes) }),
        item.credits_truncated ? C.banner('warn', 'The credits do not fit this platform',
          'This platform\'s description limit cut into the required credits. Publish the full credits in the first comment, or shorten the rest of the description.') : null,
        item.title ? el('p', { class: 'metric-note', text: 'Title: ' + item.title }) : null,
        (item.tags || []).length ? el('p', { class: 'metric-note', text: 'Tags: ' + item.tags.join(', ') }) : null,
        el('p', { class: 'metric-note', text: item.captions_burned ? 'Captions burned in, and a sidecar file as well.' : 'Captions as a sidecar file.' }),
        el('p', { class: 'metric-note', text: 'Short built from ' + item.short_source + '.' }),
        el('p', { class: 'metric-note', text: item.short_note }),
        el('div', { class: 'row' }, [
          downloadLink(ctx, item.video, 'Download the video'),
          downloadLink(ctx, item.captions, 'Captions (.srt)'),
          downloadLink(ctx, item.metadata, 'Metadata (.json)')
        ])
      ]);
      wrap.append(C.panel(item.label, { subtitle: item.platform, children: rows }));
    });

    skipped.forEach(function (item) {
      wrap.append(C.banner('warn', item.label + ' was skipped', item.reason || 'No scenes fitted its limit.'));
    });
    return wrap;
  }

  root.Delivery = { composeWorkspace: composeWorkspace, finalWorkspace: finalWorkspace, exportsWorkspace: exportsWorkspace, gateDecision: gateDecision };
})(window);
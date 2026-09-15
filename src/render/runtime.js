/* Browser runtime shared by every scene template. Read as text by src/lib/frameRenderer.js and
   inlined into the rendered page, so nothing here is a CommonJS module.

   Templates define window.build(scene) and window.renderFrame(n). The renderer waits for
   window.__ready, reads window.frameCount, then calls renderFrame(n) for n = 0..frameCount-1 and
   screenshots each one. Frames are driven by the index, never by wall-clock time, so the output
   does not depend on how fast this machine renders. */
(function () {
  'use strict';
  var scene = window.__SCENE__ || {};
  var style = scene.style || {};
  var root = document.documentElement;

  root.style.setProperty('--bg', style.bg || '#0b0e14');
  root.style.setProperty('--fg', style.fg || '#f4f7fb');
  root.style.setProperty('--accent', style.accent || '#4f9dff');
  root.style.setProperty('--accent2', style.accent2 || '#ff9a3c');
  root.style.setProperty('--muted', style.muted || '#93a1b5');

  var fps = Number(scene.fps) > 0 ? Number(scene.fps) : 24;
  var seconds = Number(scene.seconds) > 0 ? Number(scene.seconds) : 4;
  window.frameCount = Math.max(1, Math.round(seconds * fps));

  function clamp(value) { return value < 0 ? 0 : (value > 1 ? 1 : value); }

  var R = {
    /* Progress of a reveal that starts at `from` and lasts `length` frames. */
    span: function (n, from, length) { return clamp((n - from) / Math.max(1, length)); },
    ease: function (t) { var p = clamp(t); return 1 - Math.pow(1 - p, 3); },
    /* Fade and slide. distance 0 gives a pure fade. */
    reveal: function (el, progress, options) {
      if (!el) return;
      var opts = options || {};
      var eased = R.ease(clamp(progress));
      var distance = opts.distance === undefined ? 18 : opts.distance;
      el.style.opacity = String(eased);
      el.style.transform = distance ? 'translateY(' + ((1 - eased) * distance).toFixed(2) + 'px)' : 'none';
    },
    el: function (tag, className, value) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = value === undefined || value === null ? '' : String(value);
      return node;
    },
    /* Never NaN, never Infinity: a malformed payload must not silently produce a broken frame. */
    num: function (value, fallback) { var n = Number(value); return Number.isFinite(n) ? n : fallback; }
  };
  window.R = R;

  /* A template declares an empty eyebrow or footnote by leaving it blank, and an empty element
     still contributes its margin, which pushes the real content off centre. Hiding them after the
     build makes a blank slot cost nothing. */
  function pruneEmpty() {
    var stage = document.getElementById('stage');
    if (!stage) return;
    Array.prototype.forEach.call(stage.children, function (child) {
      if (child.id === 'fit') return;
      var text = String(child.textContent || '').replace(/\s+/g, ' ').trim();
      var media = child.querySelector ? child.querySelector('img, svg, canvas') : null;
      if (!text && !media) child.style.display = 'none';
    });
  }

  /* Shrinks the text block until its content fits the height the template allows.

     Measured with the cap lifted, because comparing scrollHeight against clientHeight on a clipped
     element reports a one-pixel difference that never goes away, and chasing it shrank an ordinary
     headline to a third of its size. The unclipped height against the cap is the real question. */
  function fit() {
    var el = document.getElementById('fit');
    if (!el) { window.__fitReport = {ok: true, items: [], fontSize: null}; return; }

    var computed = window.getComputedStyle(el);
    var cap = parseFloat(computed.maxHeight);
    var base = parseFloat(computed.fontSize);
    if (!Number.isFinite(base) || base <= 0) base = window.innerWidth * 0.085;
    if (!Number.isFinite(cap) || cap <= 0) {
      window.__fitReport = {ok: true, items: [], fontSize: Math.round(base)};
      return;
    }

    var floor = Math.max(10, base * 0.34);
    var size = base;
    el.style.maxHeight = 'none';
    el.style.fontSize = size + 'px';
    var guard = 0;
    while (el.scrollHeight > cap + 1 && size > floor && guard < 60) {
      size = Math.max(floor, size * 0.93);
      el.style.fontSize = size + 'px';
      guard++;
    }
    var natural = el.scrollHeight;
    el.style.maxHeight = '';
    var ok = natural <= cap + 1;
    window.__fitReport = {
      ok: ok,
      items: ok ? [] : [String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)],
      fontSize: Math.round(size),
      cap: Math.round(cap)
    };
  }

  function boot() {
    try {
      if (typeof window.build === 'function') window.build(scene);
      pruneEmpty();
      fit();
      window.__error = null;
    } catch (error) {
      window.__error = String((error && error.message) || error);
    }
    window.__ready = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
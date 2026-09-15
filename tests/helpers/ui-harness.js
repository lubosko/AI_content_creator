'use strict';
/* Loads the real UI modules into a fake DOM so views can be driven end to end in Node. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createDocument} = require('./fake-dom');

const UI_DIR = path.join(__dirname, '..', '..', 'src', 'ui');
const SHELL_IDS = [
  'railStages', 'railSubtitle', 'railNote', 'viewEyebrow', 'viewTitle', 'viewSub',
  'viewActions', 'viewBody', 'inspector', 'inspectorBody', 'inspectorToggle',
  'workspace', 'toasts', 'goPicker', 'goSettings', 'goLibrary', 'goPipeline'
];

const ORDER = [
  'stages.js', 'dom.js', 'components.js', 'api.js', 'store.js', 'router.js',
  'views/project.js', 'views/brief.js', 'views/material.js', 'views/library.js',
  'views/stage.js', 'views/delivery.js', 'views/pipeline.js', 'views/settings.js', 'app.js'
];

function read(file) { return fs.readFileSync(path.join(UI_DIR, file), 'utf8'); }

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
    removeItem: key => { map.delete(String(key)); },
    clear: () => map.clear(),
    get length() { return map.size; }
  };
}

/* Boots the UI against a real server base URL. Returns handles for assertions. */
function boot({base, storage = memoryStorage(), fetchImpl} = {}) {
  const document = createDocument();
  document.buildShell(SHELL_IDS);
  const events = {};
  const location = { hash: '#/', href: 'http://localhost/' + '#/' };
  const window = {
    document,
    localStorage: storage,
    console: { error: () => {}, log: () => {}, warn: () => {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id),
    fetch: async (url, options) => {
      const target = /^https?:/.test(url) ? url : base + url;
      return fetchImpl ? fetchImpl(target, options) : fetch(target, options);
    },
    location,
    history: {
      replaceState: (state, title, url) => { if (typeof url === 'string') location.hash = url.replace(/^[^#]*/, ''); }
    },
    addEventListener: (type, handler) => { (events[type] = events[type] || []).push(handler); },
    removeEventListener: (type, handler) => { if (events[type]) events[type] = events[type].filter(item => item !== handler); },
    dispatch: (type, event) => { (events[type] || []).slice().forEach(handler => handler(event || {})); }
  };
  // window.location.hash writes must behave like a browser navigation.
  Object.defineProperty(location, 'hash', {
    get() { return this._hash === undefined ? '#/' : this._hash; },
    set(value) {
      const next = value.startsWith('#') ? value : '#' + value;
      if (next === this._hash) return;
      this._hash = next;
      window.dispatch('hashchange', {});
    }
  });
  location.hash = '#/';

  const context = vm.createContext({
    window, document, localStorage: storage, console: window.console,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
    setInterval: window.setInterval, clearInterval: window.clearInterval,
    fetch: window.fetch, URL, URLSearchParams, Blob, FormData, Headers, AbortSignal,
    TextEncoder, TextDecoder, Promise, JSON, Math, Date, Number, String, Object, Array,
    Error, RegExp, Map, Set, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent
  });
  context.globalThis = context;
  context.self = window;

  for (const file of ORDER) {
    const code = read(file);
    try {
      vm.runInContext(code, context, {filename: 'src/ui/' + file});
    } catch (error) {
      error.message = 'Loading ' + file + ' failed: ' + error.message;
      throw error;
    }
  }

  const windowRef = vm.runInContext('window', context);
  return {
    window: windowRef, document, base, location,
    navigate(hash) { location.hash = hash; },
    /* Waits for a condition against the live DOM, or times out with a useful message. */
    async settle(condition, options = {}) {
      const timeout = options.timeout || 4000;
      const started = Date.now();
      for (;;) {
        let ok = false;
        try { ok = condition ? condition() : true; } catch (error) { ok = false; }
        if (ok) return true;
        if (Date.now() - started > timeout) {
          throw new Error('Timed out waiting for: ' + (options.description || 'condition') + '\n--- view text ---\n' + text(document.getElementById('viewBody')).slice(0, 2000));
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    text(selector) { const node = typeof selector === 'string' ? document.querySelector(selector) : selector; return text(node); },
    find(selector) { return document.querySelector(selector); },
    findAll(selector) { return document.querySelectorAll(selector); },
    byId(id) { return document.getElementById(id); }
  };
}

function text(node) {
  if (!node) return '';
  if (node.textValue !== undefined && node.childNodes) return node.textValue;
  return String(node.textContent || '');
}

module.exports = {boot, text, UI_DIR, ORDER, SHELL_IDS, read, memoryStorage};
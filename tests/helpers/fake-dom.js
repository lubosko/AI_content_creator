'use strict';
/* Minimal DOM implementation for testing the UI in Node.
   This is a test double, not a browser: it covers the element, event and attribute surface the
   UI actually uses, so the real view code can be driven end to end without a browser dependency.
   It deliberately does not implement layout, so visual checks stay manual. */

function createDocument() {
  var doc = {};

  function Element(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this._dataset = {};
    var self = this;
    // In a browser, writing dataset.x reflects to the data-x attribute.
    Object.defineProperty(this, 'dataset', {
      get: function () {
        return new Proxy(self._dataset, {
          set: function (target, key, value) {
            target[key] = String(value);
            var name = 'data-' + String(key).replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
            self.attributes[name] = String(value);
            return true;
          }
        });
      }
    });
    this.listeners = {};
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.style = {};
    this.files = null;
    this._textContent = '';
  }

  /* Elements report aggregated text; text nodes report their own value. Mirrors the real DOM
     closely enough that assertions can read textContent at any depth. */
  Object.defineProperty(Element.prototype, 'textContent', {
    get: function () {
      if (this._textContent) return this._textContent;
      return this.childNodes.map(function (node) { return node.textContent !== undefined ? node.textContent : ''; }).join('');
    },
    set: function (value) { this._textContent = value === null || value === undefined ? '' : String(value); }
  });

  Object.defineProperty(Element.prototype, 'classList', {
    get: function () {
      if (!this._classList) this._classList = classListFor(this);
      return this._classList;
    }
  });

  Object.defineProperty(Element.prototype, 'children', {
    get: function () { return this.childNodes.filter(function (node) { return node instanceof Element; }); }
  });

  Object.defineProperty(Element.prototype, 'firstChild', {
    get: function () { return this.childNodes.length ? this.childNodes[0] : null; }
  });

  Object.defineProperty(Element.prototype, 'textValue', {
    get: function () {
      if (!this.childNodes.length) return this.textContent;
      return this.childNodes.map(function (node) { return node.textValue !== undefined ? node.textValue : ''; }).join('');
    }
  });

  Element.prototype.append = function () {
    for (var i = 0; i < arguments.length; i++) {
      var node = arguments[i];
      if (node === null || node === undefined) continue;
      if (typeof node === 'string') node = doc.createTextNode(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  };
  Element.prototype.appendChild = function (node) { this.append(node); return node; };
  Element.prototype.removeChild = function (node) {
    var index = this.childNodes.indexOf(node);
    if (index >= 0) { this.childNodes.splice(index, 1); node.parentNode = null; }
    return node;
  };
  Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
  Element.prototype.insertBefore = function (node, reference) {
    var index = reference ? this.childNodes.indexOf(reference) : -1;
    if (index < 0) this.append(node); else { node.parentNode = this; this.childNodes.splice(index, 0, node); }
    return node;
  };
  Element.prototype.replaceChildren = function () {
    this.childNodes = [];
    this.append.apply(this, arguments);
  };
  Element.prototype.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'type') this.type = String(value);
    if (name === 'value') this.value = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
    if (name.indexOf('data-') === 0) {
      var key = name.slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
      this.dataset[key] = String(value);
    }
  };
  Element.prototype.getAttribute = function (name) {
    if (name === 'class') return this.className || null;
    if (name === 'id') return this.id || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  };
  Element.prototype.removeAttribute = function (name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
    if (name === 'disabled') this.disabled = false;
  };
  Element.prototype.hasAttribute = function (name) { return this.getAttribute(name) !== null; };
  Element.prototype.addEventListener = function (type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  };
  Element.prototype.removeEventListener = function (type, handler) {
    if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter(function (item) { return item !== handler; });
  };
  Element.prototype.dispatch = function (type, event) {
    var handlers = (this.listeners[type] || []).slice();
    var payload = event || {};
    payload.type = type;
    payload.target = payload.target || this;
    for (var i = 0; i < handlers.length; i++) handlers[i](payload);
    return payload;
  };
  Element.prototype.click = function () { return this.dispatch('click', {}); };
  Element.prototype.change = function () { return this.dispatch('change', {}); };
  Element.prototype.focus = function () { doc.activeElement = this; };
  Element.prototype.closest = function (selector) {
    var node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  };
  Element.prototype.matches = function (selector) { return matchesSelector(this, selector); };
  Element.prototype.querySelector = function (selector) { return this.querySelectorAll(selector)[0] || null; };
  Element.prototype.querySelectorAll = function (selector) {
    var out = [];
    walk(this, function (node) { if (matchesSelector(node, selector)) out.push(node); });
    return out;
  };
  Element.prototype.contains = function (node) {
    var current = node;
    while (current) { if (current === this) return true; current = current.parentNode; }
    return false;
  };

  function hasClass(node, name) { return (' ' + node.className + ' ').indexOf(' ' + name + ' ') >= 0; }

  function matchesSimple(node, part) {
    var classAttr = part.match(/^\.([a-zA-Z0-9_-]+)\[([a-zA-Z-]+)(?:='([^']*)')?\]$/);
    if (classAttr) {
      if (!hasClass(node, classAttr[1])) return false;
      var value = node.getAttribute(classAttr[2]);
      if (value === null) return false;
      return classAttr[3] === undefined ? true : value === classAttr[3];
    }
    var tagClass = part.match(/^([a-zA-Z0-9]+)\.([a-zA-Z0-9_-]+)$/);
    if (tagClass) return node.localName === tagClass[1].toLowerCase() && hasClass(node, tagClass[2]);
    if (part.charAt(0) === '.') return hasClass(node, part.slice(1));
    if (part.charAt(0) === '#') return node.id === part.slice(1);
    var tagAttr = part.match(/^([a-zA-Z0-9]+)\[([a-zA-Z-]+)(?:='([^']*)')?\]$/);
    if (tagAttr) {
      if (node.localName !== tagAttr[1].toLowerCase()) return false;
      var tagValue = node.getAttribute(tagAttr[2]);
      if (tagValue === null) return false;
      return tagAttr[3] === undefined ? true : tagValue === tagAttr[3];
    }
    var attr = part.match(/^\[([a-zA-Z-]+)(?:='([^']*)')?\]$/);
    if (attr) {
      var attrValue = node.getAttribute(attr[1]);
      if (attrValue === null) return false;
      return attr[2] === undefined ? true : attrValue === attr[2];
    }
    return node.localName === part.toLowerCase();
  }

  function matchesSelector(node, selector) {
    if (!(node instanceof Element)) return false;
    var parts = selector.trim().split(/\s+/);
    // Supports descendant groups of simple selectors, which is all the UI needs.
    for (var i = 0; i < parts.length; i++) if (!matchesSimple(node, parts[i])) return false;
    return true;
  }

  function classListFor(node) {
    return {
      add: function () { for (var i = 0; i < arguments.length; i++) if (!hasClass(node, arguments[i])) node.className = (node.className + ' ' + arguments[i]).trim(); },
      remove: function () { for (var i = 0; i < arguments.length; i++) node.className = (' ' + node.className + ' ').replace(' ' + arguments[i] + ' ', ' ').trim(); },
      contains: function (name) { return hasClass(node, name); },
      toggle: function (name, force) {
        var on = force === undefined ? !hasClass(node, name) : !!force;
        if (on) this.add(name); else this.remove(name);
        return on;
      }
    };
  }

  function walk(node, visit) {
    if (!node || !node.childNodes) return;
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      visit(child);
      walk(child, visit);
    }
  }

  function TextNode(text) {
    this.nodeType = 3;
    this.nodeValue = String(text);
    this.textValue = String(text);
    this.parentNode = null;
    this.childNodes = [];
  }
  Object.defineProperty(TextNode.prototype, 'textContent', {
    get: function () { return this.nodeValue; },
    set: function (value) { this.nodeValue = String(value); this.textValue = String(value); }
  });
  TextNode.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };

  doc.createElement = function (tag) { return new Element(tag); };
  doc.createElementNS = function (ns, tag) { return new Element(tag); };
  doc.createTextNode = function (text) { return new TextNode(text); };
  doc.createDocumentFragment = function () { return new Element('#fragment'); };
  doc.readyState = 'complete';
  doc.activeElement = null;
  doc.listeners = {};
  doc.addEventListener = Element.prototype.addEventListener;
  doc.removeEventListener = Element.prototype.removeEventListener;
  doc.dispatch = Element.prototype.dispatch;
  doc.body = new Element('body');
  doc.documentElement = new Element('html');
  doc.querySelector = function (selector) { return Element.prototype.querySelectorAll.call(doc.body, selector)[0] || null; };
  doc.querySelectorAll = function (selector) { return Element.prototype.querySelectorAll.call(doc.body, selector); };
  doc.walk = walk;

  doc.getElementById = function (id) {
    var found = null;
    walk(doc.body, function (node) { if (!found && node.id === id) found = node; });
    return found;
  };

  doc.findAll = function (selector) { return doc.querySelectorAll(selector); };

  /* Builds the same element ids the real shell provides. classList comes from the Element
     prototype, so app.js can toggle shell classes exactly as it does in a browser. */
  doc.buildShell = function (ids) {
    var shell = new Element('div');
    shell.className = 'shell';
    doc.body.append(shell);
    ids.forEach(function (id) {
      var node = new Element('div');
      node.id = id;
      node.setAttribute('id', id);
      shell.append(node);
    });
    return shell;
  };

  return doc;
}

module.exports = { createDocument: createDocument };
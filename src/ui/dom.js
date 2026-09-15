'use strict';
/* Small element builder. All UI markup is created here or in components.js, so project content
   is only ever assigned through textContent and never becomes executable HTML. */
(function (root) {
  var SVG = 'http://www.w3.org/2000/svg';

  function el(tag, options, children) {
    var node = tag === 'svg' ? document.createElementNS(SVG, 'svg') : document.createElement(tag);
    var opts = options || {};
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
    if (opts.id) node.id = opts.id;
    if (opts.type) node.type = opts.type;
    if (opts.value !== undefined) node.value = opts.value;
    if (opts.href) node.href = opts.href;
    if (opts.src) node.src = opts.src;
    if (opts.htmlFor) node.htmlFor = opts.htmlFor;
    if (opts.hidden) node.hidden = true;
    if (opts.disabled) node.disabled = true;
    if (opts.checked) node.checked = true;
    if (opts.attrs) for (var key in opts.attrs) { if (opts.attrs[key] !== undefined && opts.attrs[key] !== null) node.setAttribute(key, String(opts.attrs[key])); }
    if (opts.props) for (var prop in opts.props) node[prop] = opts.props[prop];
    if (opts.on) for (var event in opts.on) node.addEventListener(event, opts.on[event]);
    if (opts.dataset) for (var data in opts.dataset) node.dataset[data] = opts.dataset[data];
    append(node, children);
    return node;
  }

  function append(parent, children) {
    if (children === undefined || children === null || children === false) return parent;
    if (Array.isArray(children)) { for (var i = 0; i < children.length; i++) append(parent, children[i]); return parent; }
    // Duck-typed rather than `instanceof Node`, so the modules also run under the Node test harness.
    var isNode = children && typeof children === 'object' && typeof children.appendChild === 'function';
    parent.append(isNode ? children : document.createTextNode(String(children)));
    return parent;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function set(node, children) { clear(node); append(node, children); return node; }
  function frag(children) { return append(document.createDocumentFragment(), children); }

  /* Button with a busy state that restores its own label, so callers cannot forget to. */
  function button(label, options) {
    var opts = options || {};
    var node = el('button', {
      class: 'btn' + (opts.variant ? ' ' + opts.variant : '') + (opts.size ? ' ' + opts.size : '') + (opts.block ? ' block' : ''),
      type: opts.type || 'button',
      text: label,
      disabled: opts.disabled,
      attrs: { 'aria-label': opts.ariaLabel || null },
      dataset: opts.dataset,
      on: opts.on ? { click: opts.on } : null
    });
    node.setBusy = function (busy, busyLabel) {
      if (busy) {
        node.dataset.idleLabel = node.dataset.idleLabel || node.textContent;
        node.disabled = true;
        node.textContent = busyLabel || 'Working';
        node.setAttribute('aria-busy', 'true');
      } else {
        node.disabled = !!opts.disabled;
        if (node.dataset.idleLabel) node.textContent = node.dataset.idleLabel;
        node.removeAttribute('aria-busy');
      }
      return node;
    };
    return node;
  }

  root.Dom = { el: el, append: append, clear: clear, set: set, frag: frag, button: button };
})(window);
'use strict';
/* The Chrome DevTools Protocol client now lives in src/lib/browser.js, because the scene renderer
   uses it too. Re-exported here so every existing test call site keeps working unchanged. */

module.exports = require('../../src/lib/browser');
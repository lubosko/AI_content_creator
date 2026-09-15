'use strict';
/* Minimal Chrome DevTools Protocol client: no npm dependencies.
   Uses the browser already installed on this machine and Node's built-in WebSocket, so the
   project keeps a dependency-free package.json while still getting a real browser.

   This lives in src because it has two callers: the browser test suite, and the scene renderer
   (src/lib/frameRenderer.js) which steps a template page frame by frame and screenshots it.
   tests/helpers/browser.js re-exports this module so test call sites are unchanged. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findBrowser() {
  for (const candidate of CANDIDATES) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (error) { /* keep looking */ }
  }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForEndpoint(port, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) return await response.json();
    } catch (error) { /* not listening yet */ }
    if (Date.now() - started > timeoutMs) throw new Error('The browser did not expose a debugging endpoint on port ' + port + '.');
    await sleep(200);
  }
}

async function pickPort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/* Boots a headless browser and returns a page session. Callers must always close(). */
async function launch(options = {}) {
  const executable = options.executable || findBrowser();
  if (!executable) throw new Error('No Chrome or Edge installation found. Set CHROME_PATH to a Chromium-based browser to run browser tests.');

  const port = await pickPort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  const width = options.width || 1440;
  const height = options.height || 900;
  // stdio is ignored on purpose: the sandbox blocks capturing a child process through pipes.
  const child = spawn(executable, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-sandbox',
    '--window-size=' + width + ',' + height,
    'about:blank'
  ], {stdio: 'ignore', windowsHide: true});

  const version = await waitForEndpoint(port, options.timeoutMs || 20000);
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', () => reject(new Error('Could not connect to the browser debugging socket.')), {once: true});
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  const session = {
    protocol: version.Browser,
    consoleErrors,
    pageErrors,
    socket,
    async send(method, params, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject, method});
        socket.send(JSON.stringify(sessionId ? {id, method, params, sessionId} : {id, method, params}));
      });
    },
    close
  };

  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch (error) { return; }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(entry.method + ' failed: ' + (message.error.message || 'unknown error')));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map(arg => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type)).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {};
      const description = (details.exception && details.exception.description) || details.text || 'unknown error';
      pageErrors.push(String(description).split('\n')[0]);
    }
  });

  socket.addEventListener('error', () => {
    for (const entry of pending.values()) entry.reject(new Error('The browser connection was lost during ' + entry.method + '.'));
    pending.clear();
  });

  // Attach to the first page target and enable the domains the test needs.
  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!target) await sleep(150);
  }
  if (!target) { close(); throw new Error('The browser did not expose a page target.'); }

  const attached = await session.send('Target.attachToTarget', {targetId: target.id, flatten: true});
  const sessionId = attached.sessionId;
  session.sessionId = sessionId;
  await session.send('Page.enable', {}, sessionId);
  await session.send('Runtime.enable', {}, sessionId);

  async function close() {
    try { socket.close(); } catch (error) { /* already closed */ }
    try { child.kill(); } catch (error) { /* already gone */ }
    await sleep(250);
    try { fs.rmSync(userDataDir, {recursive: true, force: true}); } catch (error) { /* leave it to the OS */ }
  }

  session.navigate = async function (url) {
    const loaded = new Promise(resolve => {
      const onMessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch (error) { return; }
        if (message.method === 'Page.loadEventFired') { socket.removeEventListener('message', onMessage); resolve(); }
      };
      socket.addEventListener('message', onMessage);
      setTimeout(() => { socket.removeEventListener('message', onMessage); resolve(); }, 15000);
    });
    await session.send('Page.navigate', {url}, sessionId);
    await loaded;
  };

  session.evaluate = async function (expression) {
    const result = await session.send('Runtime.evaluate', {
      expression: '(async () => { ' + expression + ' })()',
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      const description = (result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text;
      throw new Error('Page evaluation failed: ' + String(description).split('\n')[0]);
    }
    return result.result ? result.result.value : undefined;
  };

  /* Polls a page expression until it is truthy. Returns the last value, or throws with context. */
  session.waitFor = async function (expression, description, timeoutMs = 8000) {
    const started = Date.now();
    for (;;) {
      const value = await session.evaluate('return (' + expression + ');');
      if (value) return value;
      if (Date.now() - started > timeoutMs) {
        const snapshot = await session.evaluate('return document.body ? document.body.innerText.slice(0, 400) : "(no body)";');
        throw new Error('Timed out waiting for ' + description + '.\n--- page text ---\n' + snapshot);
      }
      await sleep(100);
    }
  };

  /* PNG by default, as the tests want. The scene renderer asks for JPEG because a single scene is
     hundreds of frames and JPEG is roughly a fifth the bytes for flat graphics. */
  session.screenshot = async function (filePath, options) {
    const opts = options || {};
    const params = {format: opts.format || 'png', captureBeyondViewport: false};
    if (params.format === 'jpeg') params.quality = opts.quality === undefined ? 92 : opts.quality;
    const result = await session.send('Page.captureScreenshot', params, sessionId);
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  };

  return session;
}

module.exports = {launch, findBrowser, CANDIDATES};
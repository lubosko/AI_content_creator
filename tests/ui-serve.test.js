'use strict';
/* Serves the new UI over real HTTP: every module reachable with the right content type, the shell
   at the root, and no way to read files outside src/ui. This is the contract the browser depends on. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('../src/server');
const {ORDER} = require('./helpers/ui-harness');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-ui-serve-'));
  const server = createServer({
    projectsRoot: path.join(root, 'projects'),
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {},
    vault: {seal: value => 's:' + value, open: value => String(value).replace(/^s:/, '')}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    const shell = await fetch(base + '/');
    assert.equal(shell.status, 200, 'The root route must serve the UI shell');
    assert.match(shell.headers.get('content-type'), /text\/html/);
    const html = await shell.text();
    assert.ok(html.indexOf('/ui/app.js') >= 0, 'The root route must serve the new shell, not an old page');
    assert.ok(html.indexOf('inspector') >= 0);

    const expected = {'.html': /text\/html/, '.css': /text\/css/, '.js': /javascript/};
    for (const file of ORDER) {
      const response = await fetch(base + '/ui/' + file);
      assert.equal(response.status, 200, '/ui/' + file + ' must be served');
      const extension = path.extname(file);
      if (expected[extension]) assert.match(response.headers.get('content-type'), expected[extension], file + ' must be served with the right content type');
      assert.ok((await response.text()).length > 0, '/ui/' + file + ' must not be empty');
    }
    const css = await fetch(base + '/ui/styles.css');
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'ui', 'styles.css')), true);

    // Files outside src/ui must be unreachable, encoded or not.
    for (const attempt of ['/ui/../server.js', '/ui/..%2fserver.js', '/ui/../../package.json', '/ui/%2e%2e%2fserver.js']) {
      const response = await fetch(base + attempt);
      assert.equal(response.status, 404, attempt + ' must not be readable');
      const text = await response.text();
      assert.ok(text.indexOf('createServer') < 0, attempt + ' must not leak source');
    }
    assert.equal((await fetch(base + '/ui/does-not-exist.js')).status, 404);

    console.log('All UI serving tests passed: shell at root, every module served, traversal blocked.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
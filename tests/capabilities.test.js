'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {mediaCapabilities, detectMediaTools} = require('../src/config/capabilities');
function run() {
  // Real machine state: the composer cannot work without both binaries, and the report must say so.
  const live = mediaCapabilities();
  assert.equal(typeof live.ready, 'boolean');
  assert.equal(live.tools.length, 2);
  assert.deepEqual(live.tools.map(tool => tool.name), ['ffmpeg', 'ffprobe']);
  assert.equal(live.ready, live.missing.length === 0, 'ready must agree with the missing list');
  assert.ok(live.summary.length > 0);
  for (const tool of live.tools) {
    if (tool.available) {
      assert.ok(tool.path, 'An available tool must report its path');
      assert.match(tool.version, /version/i, 'An available tool must report a version');
      assert.equal(tool.reason, null);
    } else {
      assert.equal(tool.version, null);
      assert.match(tool.reason, /PATH|Install|run/i, 'A missing tool must explain itself');
    }
  }
  // An empty PATH must report both tools missing instead of throwing.
  const bare = mediaCapabilities({env: {PATH: ''}, platform: 'linux'});
  assert.equal(bare.ready, false);
  assert.deepEqual(bare.missing, ['ffmpeg', 'ffprobe']);
  assert.match(bare.summary, /unavailable/i);
  // A directory holding a non-executable decoy must be reported as unrunnable, not as ready.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-capabilities-'));
  fs.writeFileSync(path.join(root, 'ffmpeg'), 'not a binary');
  fs.writeFileSync(path.join(root, 'ffprobe'), 'not a binary');
  const decoy = mediaCapabilities({env: {PATH: root}, platform: 'linux', execFileSync: () => { throw new Error('ENOEXEC'); }});
  assert.equal(decoy.ready, false);
  assert.deepEqual(decoy.missing, ['ffmpeg', 'ffprobe']);
  assert.match(decoy.tools[0].reason, /could not be run/i);
  // A working stub on PATH must be reported as available with its encoders parsed.
  const working = detectMediaTools({env: {PATH: root}, platform: 'linux', execFileSync: () => 'ffmpeg version 9.0.1-full_build\nconfiguration: --enable-libx264 --enable-libass --enable-libopus\n'})[0];
  assert.equal(working.available, true);
  assert.equal(working.version, 'ffmpeg version 9.0.1-full_build');
  assert.deepEqual(working.encoders, ['libx264', 'libass', 'libopus']);
  // WinGet Links must be found even when the process PATH was captured before the install.
  const winDir = path.join(root, 'Microsoft', 'WinGet', 'Links');
  fs.mkdirSync(winDir, {recursive: true});
  fs.writeFileSync(path.join(winDir, 'ffmpeg.exe'), 'stub');
  const shimmed = detectMediaTools({env: {PATH: '', LOCALAPPDATA: root}, platform: 'win32', execFileSync: () => 'ffmpeg version 9.0.1'})[0];
  assert.equal(shimmed.available, true, 'A fresh WinGet install must be found without restarting the server');
  fs.rmSync(root, {recursive: true, force: true});
  console.log('All capability tests passed: detection, missing tools, unrunnable binaries, encoder parsing, and WinGet shims.');
}
run();
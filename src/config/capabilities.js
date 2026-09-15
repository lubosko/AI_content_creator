'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const BINARIES = ['ffmpeg','ffprobe'];
// WinGet adds its Links shim directory to the persistent user PATH, which long-running shells and
// already-started servers do not see. Look there explicitly so an install is picked up without a restart.
function wellKnownDirs(env, platform) {
  if (platform !== 'win32') return [];
  const local = env.LOCALAPPDATA;
  const programData = env.ProgramData;
  return [
    local ? path.join(local, 'Microsoft', 'WinGet', 'Links') : null,
    local ? path.join(local, 'Microsoft', 'WindowsApps') : null,
    programData ? path.join(programData, 'chocolatey', 'bin') : null,
    'C:\\ffmpeg\\bin'
  ].filter(Boolean);
}
function probe(name, {env = process.env, platform = process.platform} = {}) {
  const dirs = [...String(env.PATH || '').split(path.delimiter).filter(Boolean), ...wellKnownDirs(env, platform)];
  const extensions = platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}
function detectMediaTools(options = {}) {
  const run = options.execFileSync || execFileSync;
  return BINARIES.map(name => {
    const file = probe(name, options);
    if (!file) return {name, available:false, path:null, version:null, encoders:[], reason:'Not found on PATH. Install FFmpeg before rendering video.'};
    try {
      const output = String(run(file, ['-version'], {encoding:'utf8', timeout:10000, windowsHide:true, stdio:['ignore','pipe','ignore']}));
      const match = output.match(/^([^\r\n]*?version\s+\S+)/i);
      const encoders = (output.match(/--enable-(libx264|libx265|libvpx-vp9|libopus|libmp3lame|libfreetype|libass)/gi) || []).map(flag => flag.replace(/^--enable-/i,''));
      return {name, available:true, path:file, version:match ? match[1].trim() : null, encoders, reason:null};
    } catch {
      return {name, available:false, path:file, version:null, encoders:[], reason:'Found on PATH but could not be run. Check that the file is a working executable.'};
    }
  });
}
function mediaCapabilities(options = {}) {
  const tools = detectMediaTools(options);
  const missing = tools.filter(tool => !tool.available).map(tool => tool.name);
  return {
    ready: missing.length === 0,
    tools,
    missing,
    summary: missing.length ? 'Video rendering unavailable: ' + missing.join(' and ') + ' not found. Install FFmpeg to enable composition.' : 'FFmpeg detected. Video composition is available.'
  };
}
module.exports = {detectMediaTools, mediaCapabilities};
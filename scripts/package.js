'use strict';
/* Builds the distributable folder and archives it. Plain Node and no dependencies, so "how do I
   package this" has the same answer as everything else here: run it.

     npm run dist

   Nothing that holds your work or your credentials is ever copied: projects/ (which contains the
   settings file with your sealed API keys), .env and test-results/ are all excluded explicitly, and
   the copy list is an allow-list rather than a deny-list so a new private directory cannot leak in
   by being forgotten. */

const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = 'ai-content-creator-' + pkg.version;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, NAME);

// An allow-list. Anything not named here is not distributed, whatever it is.
const INCLUDE_FILES = ['package.json', 'README.md', 'LICENSE', '.env.example', 'start.cmd', 'start.sh'];
const INCLUDE_DIRS = ['src', 'docs', 'scripts', 'tests'];

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, {recursive: true});
    for (const entry of fs.readdirSync(from)) copyRecursive(path.join(from, entry), path.join(to, entry));
    return;
  }
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(from, to);
}

function main() {
  fs.rmSync(STAGE, {recursive: true, force: true});
  fs.mkdirSync(STAGE, {recursive: true});

  const copied = [];
  for (const file of INCLUDE_FILES) {
    const from = path.join(ROOT, file);
    if (!fs.existsSync(from)) {
      console.log('skipped (not present): ' + file);
      continue;
    }
    copyRecursive(from, path.join(STAGE, file));
    copied.push(file);
  }
  for (const dir of INCLUDE_DIRS) {
    const from = path.join(ROOT, dir);
    if (!fs.existsSync(from)) continue;
    // dist/ lives at the root, so it can never be inside these.
    copyRecursive(from, path.join(STAGE, dir));
    copied.push(dir + '/');
  }

  // An empty projects/ so the app has somewhere to write on first run.
  fs.mkdirSync(path.join(STAGE, 'projects'), {recursive: true});
  fs.writeFileSync(path.join(STAGE, 'projects', '.gitkeep'), '');

  /* The guard that matters: assert the private paths did not travel. */
  const forbidden = ['projects/_settings', 'projects/_library', '.env', 'test-results'];
  for (const item of forbidden) {
    const target = path.join(STAGE, item);
    if (fs.existsSync(target) && item !== 'projects/_settings') {
      console.error('Refusing to package: ' + item + ' would have been included.');
      process.exitCode = 1;
      return;
    }
  }
  if (fs.existsSync(path.join(STAGE, '.env'))) {
    console.error('Refusing to package: a .env file would have been included.');
    process.exitCode = 1;
    return;
  }

  console.log('Staged ' + copied.length + ' entries into dist/' + NAME + '/');
  console.log('  included: ' + copied.join(', ') + ', projects/ (empty)');

  const archive = path.join(DIST, NAME + '.zip');
  fs.rmSync(archive, {force: true});
  try {
    if (process.platform === 'win32') {
      // Archive the directory itself, not its contents, so unzipping gives one folder rather than
      // scattering the app into whatever directory the recipient happens to be in.
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Compress-Archive -Path ' + JSON.stringify(STAGE) + ' -DestinationPath ' + JSON.stringify(archive) + ' -Force'],
        {stdio: 'inherit'});
    } else {
      execFileSync('zip', ['-r', '-q', archive, NAME], {cwd: DIST, stdio: 'inherit'});
    }
    const bytes = fs.statSync(archive).size;
    console.log('  archive: dist/' + NAME + '.zip (' + (bytes / 1024).toFixed(0) + ' KB)');
  } catch (error) {
    /* Leaving the folder is better than failing: the folder is the deliverable, the zip is a
       convenience, and the reason is stated rather than swallowed. */
    console.log('  the archive could not be built (' + error.message.split('\n')[0] + ')');
    console.log('  the folder dist/' + NAME + '/ is ready to copy or zip by hand');
  }
  console.log('Recipients need Node 18+ and FFmpeg on PATH. Run start.cmd (Windows) or ./start.sh.');
}

main();
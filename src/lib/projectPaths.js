'use strict';
/* Resolving a project folder to its directory on disk.

   This module used to hold the deterministic template generators for the script, storyboard and
   render plan. Those are gone: every stage is either provider-backed or renders for real, so the only
   thing left here is the path check that the server and the intake workflow both rely on. */

const fs = require('node:fs');
const path = require('node:path');

function validateFolderName(folderName) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(String(folderName || ''))) {
    throw new Error('Invalid project folder.');
  }
}

/* Resolves a folder inside the projects root and refuses anything that escapes it or that is not a
   project at all. */
function resolveProjectDirectory(projectsRoot, folderName) {
  validateFolderName(folderName);
  const root = path.resolve(projectsRoot);
  const projectDirectory = path.resolve(root, folderName);
  if (!projectDirectory.startsWith(`${root}${path.sep}`)) {
    throw new Error('Invalid project folder.');
  }
  if (!fs.existsSync(path.join(projectDirectory, 'project.json'))) {
    throw new Error('Project not found.');
  }
  return projectDirectory;
}

module.exports = { resolveProjectDirectory, validateFolderName };
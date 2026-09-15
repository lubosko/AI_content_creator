'use strict';
/* One engine for every provider-backed creative stage.
   It used to be a single research function; the shape it already had is the right one, so it is
   generalized here: capture inputs, call the provider, refuse to save if the project changed
   underneath, archive the previous artifacts, write atomically, and roll back on failure. */

const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const intake = require('./intakeWorkflow');

/* Every output path must stay inside the project directory. Stage output comes from our own code,
   but a guard here means a future stage cannot escape the project by accident. */
function safeOutputPath(directory, relative) {
  const base = path.resolve(directory);
  const target = path.resolve(base, String(relative));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw Object.assign(new Error('Refusing to write outside the project directory: ' + relative), {status: 500});
  }
  return target;
}

/* Writes every output, restoring the previous bytes if any write or preparation fails. */
function writeAtomically(ctx, outputs, backupDir) {
  const prior = new Map();
  for (const relative of [...Object.keys(outputs), 'project.json']) {
    const file = safeOutputPath(ctx.directory, relative);
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    prior.set(relative, bytes);
    if (bytes) {
      fs.mkdirSync(backupDir, {recursive: true});
      fs.writeFileSync(path.join(backupDir, path.basename(relative)), bytes);
    }
  }
  try {
    for (const [relative, text] of Object.entries(outputs)) {
      const file = safeOutputPath(ctx.directory, relative);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, String(text).replace(/\s+$/, '') + '\n');
    }
  } catch (error) {
    for (const [relative, bytes] of prior) {
      const file = safeOutputPath(ctx.directory, relative);
      if (bytes) fs.writeFileSync(file, bytes);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    throw error;
  }
}

/* Runs one stage.
   options:
     stage        stage key in project.workflow.stages, for example 'strategy'
     label        how the stage is announced in messages, for example 'Strategy'
     projectsRoot, folder
     call         async (context) => {outputs, project fields} — performs the provider work
     apply        (ctx, result) => void — records result fields on the project before persisting
     status       project status to set on success, for example 'strategy_ready'
     invalidates  stages that must become needs_update because their inputs changed */
async function runStage(options) {
  const before = intake.context(options.projectsRoot, options.folder);
  intake.requireIntake(before);
  const revision = before.project.workflow.revision;
  const label = options.label || options.stage;

  const result = await options.call(before);

  // The project must not have changed while the provider was working.
  const ctx = intake.context(options.projectsRoot, options.folder);
  if (ctx.project.workflow.revision !== revision) {
    intake.fail(label + ' inputs changed while it was running. The result was not saved. Reload and retry.', 409);
  }

  const backupDir = path.join(ctx.directory, options.stage, 'history', Date.now() + '-' + randomUUID());
  writeAtomically(ctx, result.outputs, backupDir);

  /* Project changes belong to the freshly read context, because the one `call` saw was discarded.
     A stage may hand back its own `apply` instead of the caller having to wire one, which keeps the
     change next to the code that computed it. */
  const apply = options.apply || (result && typeof result.apply === 'function' ? result.apply : null);
  if (apply) apply(ctx, result);
  ctx.project.workflow.stages[options.stage].revision++;
  ctx.project.workflow.stages[options.stage].state = 'needs_review';
  for (const name of options.invalidates || []) {
    const record = ctx.project.workflow.stages[name];
    if (record) record.state = record.revision ? 'needs_update' : 'locked';
  }
  for (const key of Object.keys(ctx.project.approvals || {})) ctx.project.approvals[key] = 'not_ready';
  ctx.project.approval_state = 'pending';
  /* Applied last, so a stage that decides its own status keeps it. A composer that found blocking
     QC issues must be able to say so. */
  if (options.status) ctx.project.status = options.status;
  intake.persist(ctx);

  return {project: ctx.project, artifact: Object.assign({path: result.artifactPath || null, stage: options.stage}, result.artifact || {})};
}

module.exports = {runStage, writeAtomically, safeOutputPath};
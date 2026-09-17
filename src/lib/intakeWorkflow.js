"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { migrateProject } = require('./projectGenerator');
const { resolveProjectDirectory } = require('./projectPaths');
const licensing = require('./licensing');
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function save(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
function context(root, folder) {
  const directory = resolveProjectDirectory(root, folder);
  const file = path.join(directory, 'project.json');
  const project = migrateProject(JSON.parse(fs.readFileSync(file, 'utf8')));
  const brief = JSON.parse(fs.readFileSync(path.join(directory, 'prompt/refined_brief.json'), 'utf8'));
  return { directory, file, project, brief };
}
function persist(ctx) {
  ctx.project.updated_at = new Date().toISOString();
  ctx.project.workflow.revision++;
  save(ctx.file, ctx.project);
}
function checkRevision(ctx, body) {
  if (body.revision !== ctx.project.workflow.revision) fail('This project changed. Reload it before saving.', 409);
}
function invalidate(ctx) {
  for (const stage of Object.values(ctx.project.workflow.stages)) stage.state = stage.revision ? 'needs_update' : 'locked';
  ctx.project.approval_state = 'not_ready';
  for (const key of Object.keys(ctx.project.approvals || {})) ctx.project.approvals[key] = 'not_ready';
}
function approve(ctx, stage) {
  const record = ctx.project.workflow[stage];
  record.state = 'approved';
  ctx.project.workflow.approvals.push({ stage, revision: record.revision, decision: 'approved', timestamp: new Date().toISOString() });
}

/* Creative stages require an explicit human decision. An approval is recorded against the exact
   revision it reviewed, so a later regeneration cannot inherit an old approval. The last two gates
   are the video and its platform adaptations, using the schema's own approval keys. */
const APPROVABLE_STAGES = ['research', 'strategy', 'script', 'storyboard', 'master_video', 'platform_adaptations'];
const DECISIONS = ['approved', 'changes_requested'];

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

/* A cheap fingerprint of the composed video, so an approval cannot be carried over to a master that
   has since been rendered again. */
function masterSubject(project) {
  const master = (project && project.master_video) || null;
  if (!master || !master.path) return null;
  const stage = ((project.workflow || {}).stages || {}).compose || {};
  return ['compose', stage.revision || 0, master.size_bytes || 0, master.duration_seconds || 0].join(':');
}

function exportsSubject(ctx) {
  const manifest = readJsonIfPresent(path.join(ctx.directory, 'adaptations/export_manifest.json'));
  return manifest ? manifest.generated_at || null : null;
}

/* QC's own report decides whether the video may be approved, and the checklist's manual items have to
   be confirmed in the request: those are the things this app cannot verify for the operator. */
function requireMasterApprovable(ctx, body) {
  const qc = readJsonIfPresent(path.join(ctx.directory, 'qc/qc_report.json'));
  // `measured` is written only by the composer's inspection, so its absence means nothing has been
  // composed — which is also how a project created before the composer existed is recognised.
  if (!qc || qc.status === 'not_started' || !qc.measured) {
    fail('No video has been composed yet, so there is nothing to approve. Render the video first.', 409);
  }
  if (Array.isArray(qc.blocking_issues) && qc.blocking_issues.length) {
    fail('QC found ' + qc.blocking_issues.length + ' blocking issue(s), so the video cannot be approved: ' + qc.blocking_issues[0], 409);
  }
  if (qc.can_approve_master === false) fail('QC did not pass, so the video cannot be approved.', 409);

  const subject = masterSubject(ctx.project);
  if (!subject) fail('No composed video is recorded on this project. Compose the video first.', 409);
  if (body.subject !== undefined && body.subject !== subject) {
    /* Reloading cannot help here, and telling the operator to had them reload for nothing: the
       approval is pinned to the video the check inspected, so a re-render means the check has to be
       run again against the current cut. */
    fail('The video was rendered again after that check ran, so the check belongs to the previous cut. Run the final check again against the current video, then approve it.', 409);
  }
  const check = readJsonIfPresent(path.join(ctx.directory, 'final/final_check.json'));
  if (!check) fail('Run the final check before approving the video.', 409);
  const manual = (check.checks || []).filter(item => item.mode === 'manual').map(item => item.id);
  const confirmed = Array.isArray(body.confirmed) ? body.confirmed.map(String) : [];
  const missing = manual.filter(id => !confirmed.includes(id));
  if (missing.length) {
    fail('Confirm the ' + missing.length + ' item(s) you are asserting before approving: ' + missing.join(', ') + '.', 409);
  }
}

function requireExportsApprovable(ctx, body) {
  const manifest = readJsonIfPresent(path.join(ctx.directory, 'adaptations/export_manifest.json'));
  if (!manifest) fail('There are no platform exports to approve. Generate them first.', 409);
  const exported = (manifest.platforms || []).filter(item => item.status === 'exported');
  if (!exported.length) fail('No platform export was produced, so there is nothing to approve.', 409);
  if (body.subject !== undefined && body.subject !== exportsSubject(ctx)) {
    fail('The exports changed since you reviewed them. Reload and check the current files before approving.', 409);
  }
}

function decideStage(ctx, stage, body) {
  if (!APPROVABLE_STAGES.includes(stage)) fail('That stage cannot be approved.', 400);
  // The video and its exports are approved through the stage records that produced them.
  const record = (ctx.project.workflow.stages || {})[stage] ||
    (stage === 'master_video' ? (ctx.project.workflow.stages || {}).compose : null) ||
    (stage === 'platform_adaptations' ? (ctx.project.workflow.stages || {}).exports : null);
  if (!record) fail('Unknown stage.', 400);
  if (!record.revision) fail('There is nothing to review for this stage yet.', 409);
  if (!DECISIONS.includes(body.decision)) fail('Choose approved or changes_requested.', 400);
  if (body.feedback !== undefined && (typeof body.feedback !== 'string' || body.feedback.length > 4000)) fail('Feedback must be text under 4000 characters.', 400);
  // The stage must not have changed since the reviewer looked at it.
  if (body.revision !== ctx.project.workflow.revision) fail('This project changed. Reload it before deciding.', 409);
  if (body.stage_revision !== undefined && body.stage_revision !== record.revision) {
    fail('That result was replaced. Reload and review the current version before approving.', 409);
  }

  const approved = body.decision === 'approved';
  // The video gates are only enforced when approving: asking for changes is always allowed.
  if (approved && stage === 'master_video') requireMasterApprovable(ctx, body);
  if (approved && stage === 'platform_adaptations') requireExportsApprovable(ctx, body);

  record.state = approved ? 'approved' : 'needs_review';
  // The decision log lives at workflow.approvals; project.approvals is the gate-state map.
  ctx.project.workflow.approvals.push({
    stage,
    revision: record.revision,
    decision: body.decision,
    // What this approval was actually about, so it is clear what was reviewed.
    subject: stage === 'master_video' ? masterSubject(ctx.project) : (stage === 'platform_adaptations' ? exportsSubject(ctx) : null),
    confirmed: Array.isArray(body.confirmed) ? body.confirmed.map(String) : [],
    feedback: (body.feedback || '').trim() || null,
    timestamp: new Date().toISOString()
  });
  if (approved) {
    // Approving a stage unlocks the next one; requesting changes leaves it needing review.
    const order = ['research', 'strategy', 'script'];
    const index = order.indexOf(stage);
    if (index >= 0 && index + 1 < order.length) {
      const next = ctx.project.workflow.stages[order[index + 1]];
      if (next && !next.revision) next.state = 'ready';
    }
  }
  ctx.project.approval_state = approved ? 'approved' : 'changes_requested';
  persist(ctx);
  return ctx.project;
}

function beginStage(ctx, stage) {
  const record = (ctx.project.workflow.stages || {})[stage];
  if (!record) fail('Unknown stage.', 400);
  record.state = 'running';
  persist(ctx);
  return record;
}
function confirmBrief(ctx, body) {
  checkRevision(ctx, body);
  const brief = { ...ctx.brief };
  for (const key of ['topic', 'audience', 'angle', 'purpose', 'language', 'tone']) {
    if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 3000) fail('Please complete ' + key + '.');
    brief[key] = body[key].trim();
  }
  const allowed = ['youtube', 'youtube_shorts', 'tiktok', 'instagram', 'facebook'];
  if (!Array.isArray(body.target_platforms) || !body.target_platforms.length || !body.target_platforms.every(p => allowed.includes(p))) fail('Choose at least one supported platform.');
  if (!Number.isInteger(body.target_duration_seconds) || body.target_duration_seconds < 1 || body.target_duration_seconds > 14400) fail('Duration must be between 1 and 14400 seconds.');
  brief.target_platforms = [...new Set(body.target_platforms)];
  brief.primary_platform = brief.target_platforms[0];
  brief.target_duration_seconds = body.target_duration_seconds;
  const history = path.join(ctx.directory, 'prompt/brief_history');
  fs.mkdirSync(history, { recursive: true });
  save(path.join(history, ctx.project.workflow.brief.revision + '.json'), ctx.brief);
  save(path.join(ctx.directory, 'prompt/refined_brief.json'), brief);
  for (const key of ['topic','audience','language','tone','target_platforms','primary_platform','target_duration_seconds']) ctx.project[key] = brief[key];
  ctx.project.workflow.brief.revision++;
  approve(ctx, 'brief');
  ctx.project.workflow.materials.state = 'needs_review';
  invalidate(ctx);
  ctx.project.status = 'brief_ready';
  ctx.brief = brief;
  persist(ctx);
}
function selectMaterial(ctx, body, asset) {
  checkRevision(ctx, body);
  if (ctx.project.workflow.brief.state !== 'approved') fail('Confirm the brief before selecting material.', 409);
  if (!['use', 'maybe', 'skip', 'remove'].includes(body.decision)) fail('Invalid material decision.');
  const materials = ctx.project.workflow.materials;
  materials.selections = materials.selections.filter(item => item.asset_id !== asset.id);
  if (body.decision !== 'remove') materials.selections.push({ asset_id: asset.id, revision: 1, decision: body.decision });
  materials.revision++;
  materials.state = 'needs_review';
  materials.without_material = false;
  invalidate(ctx);
  persist(ctx);
}
function confirmMaterials(ctx, body, getAsset) {
  checkRevision(ctx, body);
  const w = ctx.project.workflow;
  if (w.brief.state !== 'approved') fail('Confirm the brief first.', 409);
  const used = w.materials.selections.filter(item => item.decision === 'use');
  if (w.materials.selections.some(item => item.decision === 'maybe')) fail('Decide Use or Skip for every Maybe item.');
  if (!used.length && body.without_material !== true) fail('Select material to Use or choose Continue without material.');
  if (used.length && body.without_material === true) fail('Mark selected material Skip before continuing without it.');
  // Everything marked Use that can reach the video needs its rights settled here, rather than
  // discovered after a render exists. Knowledge references are not gated: they inform research and
  // the script, they are not published.
  const blocked = used.map(item => getAsset(item.asset_id)).filter(Boolean).filter(licensing.publishable).map(asset => {
    const assessment = licensing.assessRights(asset.rights);
    return assessment.state === 'blocked' ? {name: asset.name || asset.id, reasons: assessment.reasons} : null;
  }).filter(Boolean);
  if (blocked.length) {
    fail('Rights are not confirmed for ' + blocked.length + ' selected item(s): ' + licensing.blockedSentence(blocked) + ' Record the basis for using each one, then confirm again.', 409);
  }
  w.materials.without_material = !used.length;
  approve(ctx, 'materials');
  w.stages.research.state = w.stages.research.revision ? 'needs_update' : 'ready';
  persist(ctx);
}
function requireIntake(ctx) {
  if (ctx.project.workflow.brief.state !== 'approved' || ctx.project.workflow.materials.state !== 'approved') fail('Confirm your brief and material selection before generation.', 409);
}
module.exports = { context, persist, save, fail, confirmBrief, selectMaterial, confirmMaterials, requireIntake, decideStage, beginStage, approve, APPROVABLE_STAGES, masterSubject, exportsSubject };

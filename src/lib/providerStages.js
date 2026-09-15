'use strict';
/* Wires the creative stages to a project: reads the approved inputs, calls the provider, and runs
   the stage through the shared engine so history, revisions and rollback behave the same way. */

const fs = require('node:fs');
const path = require('node:path');
const {runStage} = require('./stageRunner');
const stages = require('./stages');
const licensing = require('./licensing');
const sceneAssets = require('./sceneAssets');
const intake = require('./intakeWorkflow');
const {execFileSync} = require('node:child_process');
const composer = require('./composer');
const qcModule = require('./qc');
const exportsModule = require('./exports');
const {detectMediaTools} = require('../config/capabilities');

function readIfPresent(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

/* A provider is required. There is no offline fallback: a creative stage that cannot reach a
   provider must fail visibly rather than quietly substitute a template. */
function requireProvider(provider, stageLabel) {
  if (!provider) throw Object.assign(new Error(stageLabel + ' needs a language model provider. Add a provider key in Settings and retry.'), {status: 409});
  if (typeof provider.chat !== 'function') throw Object.assign(new Error('The configured provider does not support ' + stageLabel + '.'), {status: 409});
  return provider;
}

/* Own material is optional, but whatever is sent must have been analyzed. */
function materialContext(library, ctx) {
  const selections = (ctx.project.workflow.materials || {}).selections || [];
  if (!selections.length) return {included: [], excluded: [], note: 'No own material was selected for this project.'};
  return library.researchContext(selections);
}

/* The assets the director may choose from: everything marked Use whose rights are cleared and whose
   original still exists on disk. Material with an unrecorded licence is withheld and reported, so a
   scene can never quietly rest on footage the operator has no right to publish. */
function selectedAssets(library, ctx) {
  const selections = (ctx.project.workflow.materials || {}).selections || [];
  const assets = [];
  const unavailable = [];
  const blocked = [];
  for (const selection of selections.filter(item => item.decision === 'use')) {
    let asset;
    try { asset = library.get(selection.asset_id); }
    catch (error) { unavailable.push({id: selection.asset_id, reason: error.message}); continue; }
    if (asset.missing) { unavailable.push({id: asset.id, name: asset.name, reason: 'The saved original is missing.'}); continue; }
    const assessment = licensing.assessRights(asset.rights);
    if (assessment.state === 'blocked') {
      blocked.push({id: asset.id, name: asset.name, reasons: assessment.reasons, basis: assessment.basis});
      continue;
    }
    assets.push(asset);
  }
  return {assets, unavailable, blocked};
}

/* Rights for one library asset, resolved defensively: an asset that cannot be read is treated as
   unclear rather than as permission. Returns the stored record, not a verdict, so every scene in the
   manifest carries provenance in the same shape however the media was obtained. */
function rightsLookup(library) {
  return (assetId) => {
    try { return licensing.normalise(library.get(assetId, false).rights); }
    catch (error) { return {basis: 'unknown', note: error.message}; }
  };
}

/* The library record behind a scene's own media, so the composer is told what kind of file it is
   without having to resolve the library itself. */
function assetLookup(library) {
  return (assetId) => {
    try { return library.get(assetId, false); }
    catch (error) { return null; }
  };
}

async function generateResearch({projectsRoot, folder, provider, library, settings}) {
  const webSearch = !!(settings && settings.web_search);
  const includeMaterials = !!(settings && settings.include_materials);
  return runStage({
    stage: 'research', label: 'Research', projectsRoot, folder,
    status: 'research_ready',
    invalidates: ['strategy', 'script', 'storyboard', 'assets', 'compose', 'final'],
    call: async (ctx) => {
      const materials = includeMaterials ? materialContext(library, ctx) : {included: [], excluded: [], note: 'Own material was not sent.'};
      return stages.research({brief: ctx.brief, materials, provider: requireProvider(provider, 'Research'), webSearch});
    }
  });
}

async function generateStrategy({projectsRoot, folder, provider, library}) {
  return runStage({
    stage: 'strategy', label: 'Strategy', projectsRoot, folder,
    status: 'strategy_ready',
    invalidates: ['script', 'storyboard', 'assets', 'compose', 'final'],
    call: async (ctx) => {
      const researchText = readIfPresent(path.join(ctx.directory, 'research/research_notes.md'));
      if (!researchText.trim()) {
        throw Object.assign(new Error('Strategy needs approved research first. Generate and approve research, then retry.'), {status: 409});
      }
      return stages.strategy({
        brief: ctx.brief,
        research: researchText,
        materials: materialContext(library, ctx),
        provider: requireProvider(provider, 'Strategy')
      });
    }
  });
}

async function generateScript({projectsRoot, folder, provider, library}) {
  return runStage({
    stage: 'script', label: 'Script', projectsRoot, folder,
    status: 'script_ready',
    invalidates: ['storyboard', 'assets', 'compose', 'final'],
    call: async (ctx) => {
      const researchText = readIfPresent(path.join(ctx.directory, 'research/research_notes.md'));
      const strategyRecord = readJsonIfPresent(path.join(ctx.directory, 'strategy/retention_plan.json'));
      const strategyMarkdown = readIfPresent(path.join(ctx.directory, 'strategy/content_strategy.md'));
      if (!strategyMarkdown.trim()) {
        throw Object.assign(new Error('The script needs an approved strategy first. Generate and approve the strategy, then retry.'), {status: 409});
      }
      return stages.script({
        brief: ctx.brief,
        research: researchText,
        strategy: {
          markdown: strategyMarkdown.slice(0, 8000),
          hooks: (strategyRecord && strategyRecord.hooks) || [],
          retention_moments: (strategyRecord && strategyRecord.retention_moments) || [],
          story_promise: (ctx.project.strategy_result || {}).story_promise || null
        },
        materials: materialContext(library, ctx),
        provider: requireProvider(provider, 'Script')
      });
    }
  });
}

/* The storyboard selects from the project's own media, so it needs the script and the library. */
async function generateStoryboard({projectsRoot, folder, provider, library}) {
  return runStage({
    stage: 'storyboard', label: 'Storyboard', projectsRoot, folder,
    status: 'storyboard_ready',
    invalidates: ['assets', 'compose', 'final'],
    call: async (ctx) => {
      const script = readJsonIfPresent(path.join(ctx.directory, 'script/script.json'));
      if (!script || !Array.isArray(script.sections) || !script.sections.length) {
        throw Object.assign(new Error('The storyboard needs an approved script first. Generate and approve the script, then retry.'), {status: 409});
      }
      const selection = selectedAssets(library, ctx);
      return stages.storyboard({
        brief: ctx.brief,
        script,
        assets: selection.assets,
        blockedAssets: selection.blocked,
        provider: requireProvider(provider, 'Storyboard'),
        sceneProvider: (ctx.project.video_generation_providers || {}).scene_asset_provider || null
      });
    }
  });
}

/* Asset production fills the storyboard's gap: narration audio, drawn graphics, and footage for
   scenes that selected nothing. It degrades honestly: a missing provider produces a warning, not a
   silent gap. */
async function generateAssets({projectsRoot, folder, library, speech, stock, renderGraphic, graphicFps}) {
  return runStage({
    stage: 'assets', label: 'Asset production', projectsRoot, folder,
    status: 'assets_ready',
    invalidates: ['compose', 'final'],
    call: async (ctx) => {
      const script = readJsonIfPresent(path.join(ctx.directory, 'script/script.json'));
      const board = readJsonIfPresent(path.join(ctx.directory, 'storyboard/storyboard.json'));
      if (!board || !Array.isArray(board.scenes) || !board.scenes.length) {
        throw Object.assign(new Error('Asset production needs an approved storyboard first. Generate and approve the storyboard, then retry.'), {status: 409});
      }
      // What a previous run drew, so an unchanged scene is reused instead of redrawn.
      const priorRenders = readJsonIfPresent(path.join(ctx.directory, 'generated/graphics/render_manifest.json'));
      return stages.production({
        script,
        storyboard: board,
        audioDir: path.join(ctx.directory, 'generated/audio'),
        videoDir: path.join(ctx.directory, 'generated/video'),
        projectDirectory: ctx.directory,
        rightsOf: rightsLookup(library),
        assetOf: assetLookup(library),
        previousRenders: (priorRenders && Array.isArray(priorRenders.renders)) ? priorRenders.renders : [],
        renderGraphic,
        graphicFps,
        speech,
        stock
      });
    }
  });
}

/* ---------- editing the storyboard plan ---------- */

function failWith(message, status) { throw Object.assign(new Error(message), {status}); }

/* The storyboard is rewritten through the stage engine, so an edit is archived, bumps the revision,
   invalidates what depended on it and resets its approval. Only the four files the storyboard owns
   are written, so provider_result.json — what the model actually returned — is never touched. */
function storyboardOutputs({library, scenes, board, sceneProvider}) {
  const assetsById = new Map();
  for (const scene of scenes) {
    if (!scene.asset_id || assetsById.has(scene.asset_id)) continue;
    try {
      const asset = library.get(scene.asset_id, false);
      assetsById.set(scene.asset_id, {id: asset.id, name: asset.name, category: asset.category, kind: asset.kind, mime: asset.mime});
    } catch (error) {
      assetsById.set(scene.asset_id, {id: scene.asset_id, name: 'Asset ' + scene.asset_id + ' (missing)'});
    }
  }
  const total = scenes.reduce((sum, scene) => sum + (Number(scene.seconds) || 0), 0);
  const pack = sceneAssets.buildPromptPack({scenes, provider: sceneProvider});
  const prompts = sceneAssets.buildScenePrompts(scenes, sceneProvider);
  return {
    outputs: {
      'storyboard/storyboard.json': JSON.stringify(Object.assign({}, board, {
        scenes,
        total_duration_seconds: board.total_duration_seconds || total,
        missing_assets: sceneAssets.buildMissingAssets(scenes, sceneProvider),
        selected_asset_ids: [...new Set(scenes.map(scene => scene.asset_id).filter(Boolean))]
      }), null, 2),
      'storyboard/storyboard.md': stages.storyboardMarkdown({scenes, total: board.total_duration_seconds || total}, assetsById),
      'storyboard/scene_prompts.json': JSON.stringify({provider: pack.provider, aspect_ratio: pack.aspect_ratio, profiles: pack.profiles, summary: pack.summary, prompts}, null, 2),
      'storyboard/scene_prompts.md': sceneAssets.promptPackMarkdown(pack)
    },
    missing: sceneAssets.buildMissingAssets(scenes, sceneProvider).length
  };
}

function readStoryboard(ctx) {
  const board = readJsonIfPresent(path.join(ctx.directory, 'storyboard/storyboard.json'));
  if (!board || !Array.isArray(board.scenes) || !board.scenes.length) {
    failWith('Generate the storyboard first, then fill its scenes.', 409);
  }
  return board;
}

function sceneProviderFor(ctx) {
  return (ctx.project.video_generation_providers || {}).scene_asset_provider || 'manual';
}

function sceneEditor(projectsRoot, folder, label, work) {
  return runStage({
    stage: 'storyboard', label, projectsRoot, folder,
    status: 'storyboard_ready',
    invalidates: ['assets', 'compose', 'final'],
    call: async (ctx) => {
      const board = readStoryboard(ctx);
      const scenes = board.scenes.map(scene => Object.assign({}, scene));
      const sceneProvider = sceneProviderFor(ctx);
      const result = await work({ctx, board, scenes, sceneProvider});
      const built = storyboardOutputs({library: work.library, scenes, board, sceneProvider});
      return {
        outputs: built.outputs,
        artifactPath: 'storyboard/storyboard.json',
        artifact: Object.assign({scene_id: result && result.scene_id, remaining_missing: built.missing}, result && result.artifact),
        apply: result && result.apply
      };
    },
    /* The engine re-reads the project after `call`, so anything a stage wants to change in
       project.json has to happen here against that fresh copy, not against the one `call` saw. */
    apply: (ctx, result) => { if (result && typeof result.apply === 'function') result.apply(ctx); }
  });
}

/* Assigns a local template to a scene, or clears it with template: null. Incomplete data is allowed
   here on purpose, because the operator assigns first and fills the data in second; production is
   where a template that still needs data is refused, with the reason. */
async function assignGraphic({projectsRoot, folder, sceneId, template, data, library}) {
  const work = async ({ctx, board, scenes, sceneProvider}) => {
    const scene = scenes.find(item => item.id === sceneId);
    if (!scene) failWith('Unknown scene "' + sceneId + '". Reload the storyboard and try again.', 404);

    if (template === null || template === undefined || template === '') {
      if (!scene.graphic_template) failWith('This scene has no local template to clear.', 409);
      const cleared = scene.graphic_template;
      delete scene.graphic_template;
      delete scene.graphic_data;
      return {scene_id: scene.id, artifact: {graphic_cleared: cleared, needs_data: false}};
    }
    if (!sceneAssets.isGraphicTemplate(template)) {
      failWith('Unknown scene template "' + template + '". Choose one of: ' + sceneAssets.graphicTemplates().join(', ') + '.', 400);
    }
    if (scene.asset_id) {
      failWith('This scene already uses own media. Detach that first if you want it drawn locally instead.', 409);
    }
    // Derived data is only a starting point; anything supplied wins.
    const derived = sceneAssets.defaultGraphicData(template, scene);
    const supplied = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const merged = Object.assign({}, derived.data, {options: derived.options}, supplied);
    scene.graphic_template = template;
    scene.graphic_data = merged;
    const problem = sceneAssets.validateGraphicData(template, merged);
    return {scene_id: scene.id, artifact: {graphic_template: template, needs_data: !!problem, data_problem: problem || null}};
  };
  work.library = library;
  return sceneEditor(projectsRoot, folder, 'Scene graphic', work);
}

/* Attaches an externally generated library asset to a scene, or detaches with asset_id: null.
   Every refusal names the real reason, so the operator knows which step to fix. */
async function attachSceneAsset({projectsRoot, folder, sceneId, assetId, tool, note, library}) {
  const work = async ({ctx, board, scenes, sceneProvider}) => {
    const scene = scenes.find(item => item.id === sceneId);
    if (!scene) failWith('Unknown scene "' + sceneId + '". Reload the storyboard and try again.', 404);

    if (assetId === null || assetId === undefined || assetId === '') {
      if (!scene.asset_id) failWith('This scene has no attached asset to detach.', 409);
      const previous = scene.asset_id;
      delete scene.asset_id;
      delete scene.attachment;
      return {scene_id: scene.id, artifact: {detached: true, previous_asset_id: previous}};
    }

    // library.get throws 404 for an unknown asset or a missing original.
    const asset = library.get(String(assetId), true);
    if (!licensing.publishable(asset)) {
      failWith('"' + asset.name + '" is a knowledge reference, not media, so it cannot fill a scene. Import it as media first.', 409);
    }
    const assessment = licensing.assessRights(asset.rights);
    if (assessment.state === 'blocked') {
      failWith('"' + asset.name + '" cannot be used yet. ' + assessment.reasons.join(' '), 409);
    }
    const selections = ((ctx.project.workflow || {}).materials || {}).selections || [];
    /* Asking to attach this file to this scene is already an explicit decision about it, so it is
       adopted into the project's material selection. Doing it any other way would force the operator
       to select, re-confirm the whole material stage, and only then attach. */
    const adopted = !selections.some(item => item.asset_id === asset.id && item.decision === 'use');
    if (scene.graphic_template) {
      failWith('This scene is assigned the ' + scene.graphic_template + ' template. Clear that first if you want to attach media instead.', 409);
    }

    const previousAssetId = scene.asset_id || null;
    scene.asset_id = asset.id;
    scene.attachment = {
      asset_id: asset.id,
      attached_at: new Date().toISOString(),
      provider: String(tool || sceneProvider || 'manual'),
      note: (note || '').trim() || null,
      previous_asset_id: previousAssetId,
      rights_basis: assessment.basis
    };
    return {
      scene_id: scene.id,
      artifact: {attached: asset.id, asset_name: asset.name, replaced: previousAssetId, adopted_into_project: adopted, rights_state: assessment.state, rights_basis: assessment.basis},
      apply: adopted ? (applyCtx) => {
        const materials = applyCtx.project.workflow.materials;
        materials.selections = (materials.selections || []).filter(item => item.asset_id !== asset.id);
        materials.selections.push({asset_id: asset.id, revision: 1, decision: 'use'});
        materials.revision++;
        materials.state = 'approved';
        materials.without_material = false;
      } : null
    };
  };
  work.library = library;
  return sceneEditor(projectsRoot, folder, 'Scene asset', work);
}

/* Draws one scene for a look at it. Deliberately outside the stage engine: a preview must not change
   the plan, bump the revision, or reset an approval. */
async function renderPreview({projectsRoot, folder, sceneId, template, data, library, renderGraphic, fps, width, height}) {
  const ctx = intake.context(projectsRoot, folder);
  const board = readStoryboard(ctx);
  const scene = board.scenes.find(item => item.id === sceneId);
  if (!scene) failWith('Unknown scene "' + sceneId + '". Reload the storyboard and try again.', 404);

  const chosen = template || scene.graphic_template || sceneAssets.suggestTemplate(scene);
  if (!sceneAssets.isGraphicTemplate(chosen)) {
    failWith('Unknown scene template "' + chosen + '". Choose one of: ' + sceneAssets.graphicTemplates().join(', ') + '.', 400);
  }
  const derived = sceneAssets.defaultGraphicData(chosen, scene);
  const stored = scene.graphic_template === chosen && scene.graphic_data ? scene.graphic_data : {};
  const supplied = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const merged = Object.assign({}, derived.data, {options: derived.options}, stored, supplied);
  const problem = sceneAssets.validateGraphicData(chosen, merged);
  if (problem) {
    failWith(problem + ' Fill in the data for this template, then preview again.', 409);
  }

  const outputPath = path.join(ctx.directory, 'generated/preview', 'scene-' + String(sceneId).replace(/[^a-z0-9_-]+/gi, '_') + '.mp4');
  const seconds = Number(scene.seconds) || 4;
  const rendered = await (renderGraphic || (args => require('./frameRenderer').renderScene(args)))({
    template: chosen,
    outputPath,
    width: width || 640,
    height: height || 360,
    fps: fps || 12,
    seconds,
    scene: {
      template: chosen,
      text: merged.text !== undefined ? merged.text : (scene.on_screen_text || scene.title || ''),
      subtext: merged.subtext || '',
      eyebrow: merged.eyebrow || '',
      footnote: merged.footnote || '',
      options: merged.options || {},
      data: merged,
      seconds
    }
  });
  return {
    scene_id: sceneId,
    template: chosen,
    path: path.relative(ctx.directory, outputPath).split(path.sep).join('/'),
    seconds: rendered.durationSeconds,
    width: rendered.width,
    height: rendered.height,
    fps: rendered.fps,
    frames: rendered.frameCount,
    bytes: rendered.bytes,
    preview: true
  };
}

/* ---------- the composer ---------- */

function assetKind(asset) {
  const mime = String((asset && asset.mime) || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'video';
}

/* The placeholder drawn for a scene with no media: a real text card naming the gap, so the gap is
   visible in the video rather than being a silent black hole. QC blocks it either way. */
function placeholderRenderer(options = {}) {
  return (args) => require('./frameRenderer').renderScene({
    template: args.template || 'text-card',
    outputPath: args.outputPath,
    width: options.width || 1920,
    height: options.height || 1080,
    fps: options.fps || 24,
    seconds: args.seconds,
    scene: args.scene,
    ffmpegPath: options.ffmpegPath
  });
}

/* Composes the master: plan the timeline, draw each scene, join them, lay the narration underneath,
   write the captions, then inspect the file that was actually written. The QC verdict recorded here
   is what later gates approval of the master. */
async function composeProject({projectsRoot, folder, library, tools, options, onProgress, renderPlaceholder}) {
  return runStage({
    stage: 'compose', label: 'Composer', projectsRoot, folder,
    // No `status` option: the engine would apply it after `apply`, overwriting the QC verdict, and
    // the verdict is the point. The status is qc_passed or qc_failed, set below.
    invalidates: ['final'],
    call: async (ctx) => {
      const board = readJsonIfPresent(path.join(ctx.directory, 'storyboard/storyboard.json'));
      const script = readJsonIfPresent(path.join(ctx.directory, 'script/script.json'));
      const manifest = readJsonIfPresent(path.join(ctx.directory, 'generated/asset_manifest.json'));
      if (!board || !Array.isArray(board.scenes) || !board.scenes.length) {
        failWith('The composer needs an approved storyboard first. Generate and approve the storyboard, then retry.', 409);
      }
      if (!manifest) {
        failWith('The composer needs produced assets first. Run the Assets stage, then retry.', 409);
      }

      const render = await composer.compose({
        projectDirectory: ctx.directory,
        storyboard: board,
        script,
        manifest,
        tools,
        options,
        onProgress,
        renderPlaceholder,
        resolveAsset: (assetId) => {
          try {
            const asset = library.get(assetId, true);
            return {path: library.filePathFor(asset), kind: assetKind(asset)};
          } catch (error) { return null; }
        }
      });

      const qc = qcModule.inspect({render, manifest, script, storyboard: board, projectDirectory: ctx.directory});
      const masterRelative = path.relative(ctx.directory, render.master).split(path.sep).join('/');
      const qcRecord = Object.assign({}, qc, {
        generated_at: new Date().toISOString(),
        master: masterRelative,
        planned: {width: render.timeline.width, height: render.timeline.height, fps: render.timeline.fps, duration_seconds: render.timeline.duration_seconds}
      });

      return {
        outputs: {
          'compose/timeline.json': JSON.stringify(render.timeline, null, 2),
          'compose/captions.srt': fs.readFileSync(path.join(ctx.directory, 'compose/captions.srt'), 'utf8'),
          'compose/render_log.json': JSON.stringify({
            commands: render.log,
            warnings: render.warnings,
            captions: {cues: render.captions.cues.length, timing: render.captions.timing, note: render.captions.timing_note},
            note: 'Every command the composer ran, in order. The master is final/youtube_master.mp4.'
          }, null, 2),
          'qc/qc_report.json': JSON.stringify(qcRecord, null, 2),
          'qc/qc_report.md': qcModule.report(qc, render)
        },
        artifactPath: 'qc/qc_report.json',
        artifact: {
          master: masterRelative,
          duration_seconds: render.timeline.duration_seconds,
          size_bytes: qc.measured ? qc.measured.size_bytes : null,
          loudness_lufs: qc.measured ? (qc.measured.loudness_lufs || null) : null,
          scenes: render.timeline.tracks.find(track => track.id === 'visuals').clips.length,
          cues: render.captions.cues.length,
          checks: qc.checks.length,
          blocking_issues: qc.blocking_issues,
          can_approve_master: qc.can_approve_master,
          warnings: render.warnings
        },
        // A failed QC still saves its report, but it must not leave the project looking ready.
        apply: (applyCtx) => {
          applyCtx.project.master_video = {
            path: masterRelative,
            duration_seconds: render.timeline.duration_seconds,
            size_bytes: qc.measured ? qc.measured.size_bytes : null,
            can_approve: qc.can_approve_master,
            blocking_issues: qc.blocking_issues.length
          };
          applyCtx.project.status = qc.can_approve_master ? 'qc_passed' : 'qc_failed';
        }
      };
    }
  });
}

/* ---------- the final check and the platform exports ---------- */

/* Whether the composed video currently on the project has been approved, matched by fingerprint so a
   re-render invalidates an earlier approval. */
function masterApproved(ctx) {
  const subject = intake.masterSubject(ctx.project);
  if (!subject) return false;
  const approvals = (ctx.project.workflow || {}).approvals || [];
  for (let index = approvals.length - 1; index >= 0; index--) {
    const record = approvals[index];
    if (record.stage === 'master_video') return record.decision === 'approved' && record.subject === subject;
  }
  return false;
}

/* The final check: what can be verified about the written video, plus the list of things only a human
   can confirm. The operator asserts those when approving, and the approval is refused without them. */
async function runFinalCheck({projectsRoot, folder, tools, execFileSync: run = execFileSync}) {
  return runStage({
    stage: 'final', label: 'Final check', projectsRoot, folder,
    invalidates: ['exports'],
    call: async (ctx) => {
      const qc = readJsonIfPresent(path.join(ctx.directory, 'qc/qc_report.json'));
      if (!qc || qc.status === 'not_started' || !qc.measured) {
        failWith('No video has been composed yet, so there is nothing to check. Render the video first.', 409);
      }
      const master = ctx.project.master_video;
      if (!master || !master.path) failWith('The project has no composed video. Compose it first.', 409);
      const masterPath = path.join(ctx.directory, master.path);
      if (!fs.existsSync(masterPath)) failWith('The composed video is missing from the project. Compose it again.', 409);

      const timeline = readJsonIfPresent(path.join(ctx.directory, 'compose/timeline.json'));
      const board = readJsonIfPresent(path.join(ctx.directory, 'storyboard/storyboard.json'));
      const script = readJsonIfPresent(path.join(ctx.directory, 'script/script.json'));
      const brief = readJsonIfPresent(path.join(ctx.directory, 'prompt/refined_brief.json'));
      const manifest = readJsonIfPresent(path.join(ctx.directory, 'generated/asset_manifest.json'));
      const captionFile = path.join(ctx.directory, 'compose/captions.srt');
      const captions = fs.existsSync(captionFile) ? fs.readFileSync(captionFile, 'utf8') : '';
      const cueCount = (captions.match(/-->/g) || []).length;

      const ffmpeg = findFfmpeg(tools);
      const probe = (tools || detectMediaTools());
      const {probeMedia} = require('../analyze/media');
      const probed = probeMedia(masterPath, {tools: probe, execFileSync: run});
      const metadata = probed && probed.ok ? probed.metadata : null;

      // A thumbnail is a real deliverable, and its absence would otherwise be noticed at upload time.
      const thumbnail = 'final/youtube_thumbnail.jpg';
      const thumbnailPath = path.join(ctx.directory, thumbnail);
      let thumbnailError = null;
      if (ffmpeg && metadata && metadata.durationSeconds) {
        const at = Math.max(0.1, metadata.durationSeconds * 0.25);
        try {
          run(ffmpeg, ['-y', '-v', 'error', '-ss', at.toFixed(2), '-i', masterPath, '-frames:v', '1',
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
            '-q:v', '3', thumbnailPath], {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
        } catch (error) {
          // Reported by the check below rather than swallowed, so a missing thumbnail has a reason.
          thumbnailError = String((error && error.message) || error).split('\n')[0];
        }
      } else {
        thumbnailError = ffmpeg ? 'the master had no readable duration' : 'ffmpeg is not available';
      }

      const targetSeconds = Number((brief && brief.target_duration_seconds) || 0);
      const measured = metadata ? Number(metadata.durationSeconds) || 0 : 0;
      const drift = targetSeconds ? Math.abs(measured - targetSeconds) / targetSeconds : 0;

      const checks = [
        {id: 'qc_passed', mode: 'computed', label: 'QC passed against the written file',
          ok: !qc.blocking_issues || qc.blocking_issues.length === 0,
          detail: qc.blocking_issues && qc.blocking_issues.length ? qc.blocking_issues.join(' ') : 'No blocking issues.'},
        {id: 'master_playable', mode: 'computed', label: 'The video is playable',
          ok: !!metadata && metadata.hasVideo && measured > 0,
          detail: metadata ? metadata.width + 'x' + metadata.height + ', ' + measured.toFixed(2) + 's, ' + metadata.videoCodec + (metadata.hasAudio ? ' with audio' : ' with no audio') : 'The video could not be read back.'},
        {id: 'captions_present', mode: 'computed', label: 'Captions exist for the video',
          ok: cueCount > 0, detail: cueCount + ' caption cue(s).'},
        {id: 'rights_cleared', mode: 'computed', label: 'Every clip has a cleared rights basis',
          ok: !!(manifest && manifest.rights && manifest.rights.can_render),
          detail: manifest && manifest.rights ? (manifest.rights.can_render ? 'All material is cleared.' : 'Some material is not cleared.') : 'No asset manifest was found.'},
        {id: 'duration_on_target', mode: 'computed', label: 'The video is close to the brief duration',
          ok: !targetSeconds || drift <= 0.25, detail: targetSeconds ? 'target ' + targetSeconds + 's, measured ' + measured.toFixed(2) + 's' : 'The brief set no target duration.'},
        {id: 'thumbnail', mode: 'computed', label: 'A thumbnail was produced',
          ok: fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0,
          detail: fs.existsSync(thumbnailPath) ? thumbnail : thumbnail + (thumbnailError ? ' could not be extracted: ' + thumbnailError : ' was not extracted')},
        /* These are the things no check can decide. They are asserted at approval, not assumed here. */
        {id: 'watched', mode: 'manual', label: 'You have watched the video from start to finish', ok: null,
          detail: 'No automated check can tell whether the video makes sense.'},
        {id: 'facts', mode: 'manual', label: 'The facts, figures and claims are correct', ok: null,
          detail: 'The script is grounded in the research, but the numbers still need your eye.'},
        {id: 'branding', mode: 'manual', label: 'The title, tone and branding are right', ok: null,
          detail: 'The title comes from the brief and the metadata is assembled, not written for you.'},
        {id: 'captions_proofread', mode: 'manual', label: 'You have checked the captions read correctly', ok: null,
          detail: 'Caption wording comes from the script; the timing is estimated from the audio length.'},
        {id: 'rights_confirmed', mode: 'manual', label: 'You are content that every source may be used as it is', ok: null,
          detail: 'The rights gate encodes the licences it knows. It cannot verify a claim made by someone else.'}
      ];

      const blocking = checks.filter(item => item.mode === 'computed' && item.ok === false).map(item => item.label + (item.detail ? ' — ' + item.detail : ''));
      const subject = intake.masterSubject(ctx.project);
      const finalCheck = {
        generated_at: new Date().toISOString(),
        subject,
        master: {path: master.path, duration_seconds: measured, size_bytes: fs.statSync(masterPath).size, width: metadata ? metadata.width : null, height: metadata ? metadata.height : null},
        target_duration_seconds: targetSeconds || null,
        checks,
        blocking_issues: blocking,
        can_approve: blocking.length === 0,
        note: 'The computed checks were made against the written file. The manual items are yours to confirm when you approve.'
      };

      const metadataPackage = exportsModule.metadataFor({
        brief, script, storyboard: board, timeline,
        platform: exportsModule.MASTER, master: masterPath,
        captionsFile: fs.existsSync(captionFile) ? captionFile : null,
        thumbnail: fs.existsSync(thumbnailPath) ? thumbnailPath : null,
        attributions: (manifest && manifest.rights && manifest.rights.attributions) || []
      });
      const packageWithFacts = Object.assign({}, metadataPackage, {
        duration_seconds: measured || null,
        thumbnail: thumbnail,
        captions_file: 'compose/captions.srt',
        generated_at: finalCheck.generated_at
      });

      return {
        outputs: {
          'final/final_check.json': JSON.stringify(finalCheck, null, 2),
          'final/youtube_metadata.json': JSON.stringify(packageWithFacts, null, 2)
        },
        artifactPath: 'final/final_check.json',
        artifact: {
          subject,
          checks: checks.length,
          manual_to_confirm: checks.filter(item => item.mode === 'manual').length,
          blocking_issues: blocking,
          can_approve: finalCheck.can_approve,
          thumbnail,
          duration_seconds: measured
        },
        apply: (applyCtx) => {
          applyCtx.project.final_check = {can_approve: finalCheck.can_approve, blocking_issues: blocking.length, subject, at: finalCheck.generated_at};
          applyCtx.project.status = blocking.length ? 'qc_failed' : 'human_review_required';
        }
      };
    }
  });
}

function findFfmpeg(tools) {
  const found = (tools || detectMediaTools()).find(tool => tool.name === 'ffmpeg');
  return found && found.available ? found.path : null;
}

/* Every platform export, its captions and its metadata, then a manifest listing all of it. */
async function generateExports({projectsRoot, folder, tools}) {
  return runStage({
    stage: 'exports', label: 'Platform exports', projectsRoot, folder,
    call: async (ctx) => {
      const qc = readJsonIfPresent(path.join(ctx.directory, 'qc/qc_report.json'));
      if (!qc || qc.status === 'not_started' || !qc.measured) {
        failWith('No video has been composed yet, so there is nothing to export. Render the video first.', 409);
      }
      if (qc.can_approve_master === false) {
        failWith('The video has not passed QC, so exports would be built from something that is not ready.', 409);
      }
      if (!masterApproved(ctx)) {
        failWith('Approve the video before generating platform exports. Publishing an unapproved cut is the one thing this order exists to prevent.', 409);
      }
      const timeline = readJsonIfPresent(path.join(ctx.directory, 'compose/timeline.json'));
      const board = readJsonIfPresent(path.join(ctx.directory, 'storyboard/storyboard.json'));
      const script = readJsonIfPresent(path.join(ctx.directory, 'script/script.json'));
      const brief = readJsonIfPresent(path.join(ctx.directory, 'prompt/refined_brief.json'));
      const captionFile = path.join(ctx.directory, 'compose/captions.srt');
      const cues = fs.existsSync(captionFile)
        ? parseCues(fs.readFileSync(captionFile, 'utf8'))
        : [];
      const thumbnailPath = path.join(ctx.directory, 'final/youtube_thumbnail.jpg');
      /* Credits were already collected and gated; this is where they reach the text that gets pasted
         into a platform, because an attribution obligation lands on the published description. */
      const assetManifest = readJsonIfPresent(path.join(ctx.directory, 'generated/asset_manifest.json'));
      const attributions = (assetManifest && assetManifest.rights && assetManifest.rights.attributions) || [];

      const result = exportsModule.exportAll({
        projectDirectory: ctx.directory,
        timeline, storyboard: board, script, brief, cues,
        masterRelative: (ctx.project.master_video || {}).path || 'final/youtube_master.mp4',
        hasAudio: !!(qc.measured && qc.measured.has_audio),
        thumbnail: fs.existsSync(thumbnailPath) ? thumbnailPath : null,
        attributions,
        tools,
        execFileSync: undefined
      });

      // The manifests and metadata are text, so they ride the stage transaction; the videos do not.
      const outputs = {'adaptations/export_manifest.json': JSON.stringify(result.manifest, null, 2)};
      for (const item of result.results) {
        if (item.status !== 'exported') continue;
        outputs[item.metadata] = fs.readFileSync(path.join(ctx.directory, item.metadata), 'utf8');
        outputs[item.captions] = fs.readFileSync(path.join(ctx.directory, item.captions), 'utf8');
      }

      return {
        outputs,
        artifactPath: 'adaptations/export_manifest.json',
        artifact: {
          platforms: result.results.map(item => Object.assign({}, item)),
          exported: result.results.filter(item => item.status === 'exported').length,
          credits: result.manifest.credits,
          subject: result.manifest.generated_at,
          total_bytes: result.results.reduce((sum, item) => sum + (item.bytes || 0), 0)
        },
        apply: (applyCtx) => {
          applyCtx.project.platform_exports = {
            at: result.manifest.generated_at,
            exported: result.results.filter(item => item.status === 'exported').length,
            platforms: result.results.filter(item => item.status === 'exported').map(item => item.platform)
          };
          applyCtx.project.status = 'human_review_required';
        }
      };
    }
  });
}

/* Reads an SRT back into cues, so the exports can be trimmed and retimed from the written captions
   rather than from a copy of the composer's in-memory state. */
function parseCues(srt) {
  const cues = [];
  const blocks = String(srt || '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const timeLine = lines.find(line => line.includes('-->'));
    if (!timeLine) continue;
    const match = timeLine.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!match) continue;
    const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    cues.push({
      start: toSeconds(match[1], match[2], match[3], match[4]),
      end: toSeconds(match[5], match[6], match[7], match[8]),
      text: lines.filter(line => !line.includes('-->') && !/^\d+$/.test(line)).join('\n')
    });
  }
  return cues;
}

module.exports = {generateResearch, generateStrategy, generateScript, generateStoryboard, generateAssets, assignGraphic, attachSceneAsset, renderPreview, composeProject, runFinalCheck, generateExports, placeholderRenderer, parseCues, assetKind, materialContext, selectedAssets, rightsLookup, assetLookup, requireProvider, storyboardOutputs};
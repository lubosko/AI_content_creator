'use strict';
/* The creative stages. Each one turns provider output into validated artifacts, so a malformed
   model answer fails loudly instead of being written to the project as if it were real. */

const path = require('node:path');
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const {extractJson} = require('./jsonExtract');
const {researchPrompt, strategyPrompt, scriptPrompt, storyboardPrompt} = require('./stagePrompts');
const {produceNarration} = require('./narration');
const licensing = require('./licensing');
const sceneAssets = require('./sceneAssets');

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => (typeof item === 'string' ? item.trim() : item)).filter(Boolean);
}

function seconds(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function fail(message) { throw Object.assign(new Error(message), {status: 502}); }

/* ---------- research ---------- */

const RESEARCH_HEADINGS = ['Summary', 'Key findings', 'Claims to verify'];

function checkResearch(text) {
  const missing = RESEARCH_HEADINGS.filter(heading => !new RegExp('^#{1,6}\\s*' + heading, 'im').test(text));
  if (missing.length) fail('The research result is missing expected sections: ' + missing.join(', ') + '. Nothing was saved.');
}

async function research({brief, materials, provider, webSearch}) {
  const prompt = researchPrompt({brief, materials, webSearch});
  const result = await provider.chat({system: prompt.system, user: prompt.user, webSearch});
  checkResearch(result.text);
  const status = result.grounding === 'web_cited'
    ? 'Provider research with web citations; human review required'
    : 'Provider model draft; no web citations';
  const notes = '# Research\n\nStatus: ' + status + '\n\n'
    + (result.warnings.length ? '## Research limitations\n\n' + result.warnings.map(w => '- ' + w).join('\n') + '\n\n' : '')
    + result.text + '\n\n## Source references\n\n'
    + (result.sources.length ? result.sources.map(s => '[' + s.id + '] ' + s.title + ' — ' + s.url).join('\n') : 'No web citations were returned.');
  return {
    outputs: {
      'research/research_notes.md': notes,
      'research/sources.json': JSON.stringify({sources: result.sources, note: 'Provider citations, not independently verified facts.'}, null, 2),
      'research/fact_check.json': JSON.stringify({verified_claims: [], review_required: true, note: 'Review cited claims before approving research.'}, null, 2),
      'research/provider_result.json': JSON.stringify({provider: 'anthropic', model: result.model, grounding: result.grounding, created_at: new Date().toISOString(), warnings: result.warnings, usage: result.usage}, null, 2)
    },
    artifactPath: 'research/research_notes.md',
    artifact: {sources: result.sources.length, grounding: result.grounding, model: result.model},
    apply: (ctx) => {
      ctx.project.research_settings = {provider: 'anthropic', web_search: !!webSearch, include_materials: !!materials && materials.included.length > 0};
      ctx.project.research_result = {provider: 'anthropic', model: result.model, grounding: result.grounding, warnings: result.warnings, sources: result.sources.length};
    }
  };
}

/* ---------- strategy ---------- */

function parseStrategy(modelText) {
  const extracted = extractJson(modelText);
  if (!extracted.ok) fail(extracted.reason + ' Nothing was saved. Retry, or switch the model.');
  const value = extracted.value;
  const story = text(value.story_promise);
  if (!story) fail('The strategy result has no story promise. Nothing was saved.');
  const structure = (Array.isArray(value.structure) ? value.structure : []).map((section, index) => ({
    id: text(section && (section.id || section.section), 'section_' + (index + 1)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    title: text(section && (section.section || section.title), 'Section ' + (index + 1)),
    purpose: text(section && section.purpose),
    seconds: seconds(section && (section.seconds || section.duration_seconds), 0)
  })).filter(section => section.title);
  if (!structure.length) fail('The strategy result has no structure. Nothing was saved.');
  return {
    story_promise: story,
    target_audience: text(value.target_audience),
    angle: text(value.angle),
    structure,
    hooks: list(value.hooks),
    retention_moments: list(value.retention_moments),
    material_usage: Array.isArray(value.material_usage) ? value.material_usage.filter(item => item && text(item.item)) : [],
    short_form_opportunities: list(value.short_form_opportunities),
    risks: list(value.risks)
  };
}

function strategyMarkdown(strategy, brief) {
  const lines = ['# Content Strategy', '', 'Status: provider strategy; human review required', '', '## Story promise', '', strategy.story_promise, ''];
  if (strategy.target_audience) lines.push('## Target audience', '', strategy.target_audience, '');
  if (strategy.angle) lines.push('## Angle', '', strategy.angle, '');
  lines.push('## Structure', '');
  strategy.structure.forEach((section, index) => lines.push((index + 1) + '. ' + section.title + (section.seconds ? ' (' + section.seconds + 's)' : '') + (section.purpose ? ' — ' + section.purpose : '')));
  lines.push('');
  if (strategy.hooks.length) lines.push('## Hook options', '', strategy.hooks.map(hook => '- ' + hook).join('\n'), '');
  if (strategy.retention_moments.length) lines.push('## Retention moments', '', strategy.retention_moments.map(item => '- ' + item).join('\n'), '');
  if (strategy.material_usage.length) lines.push('## Intended material usage', '', strategy.material_usage.map(item => '- ' + item.item + ': ' + text(item.use, 'used as supplied')).join('\n'), '');
  if (strategy.short_form_opportunities.length) lines.push('## Short-form opportunities', '', strategy.short_form_opportunities.map(item => '- ' + item).join('\n'), '');
  if (strategy.risks.length) lines.push('## Risks and unsupported claims', '', strategy.risks.map(item => '- ' + item).join('\n'), '');
  lines.push('## Format', '', 'Target duration: ' + (brief.target_duration_seconds || 0) + ' seconds. Language: ' + (brief.language || 'en') + '.', '');
  return lines.join('\n');
}

async function strategy({brief, research: researchText, materials, provider}) {
  const prompt = strategyPrompt({brief, research: researchText, materials});
  const result = await provider.chat({system: prompt.system, user: prompt.user});
  const parsed = parseStrategy(result.text);
  const total = parsed.structure.reduce((sum, section) => sum + section.seconds, 0);
  return {
    outputs: {
      'strategy/content_strategy.md': strategyMarkdown(parsed, brief),
      'strategy/audience.json': JSON.stringify({audience: parsed.target_audience || brief.audience, story_promise: parsed.story_promise, angle: parsed.angle}, null, 2),
      'strategy/retention_plan.json': JSON.stringify({hooks: parsed.hooks, retention_moments: parsed.retention_moments, short_form_opportunities: parsed.short_form_opportunities, risks: parsed.risks}, null, 2),
      'strategy/material_usage.json': JSON.stringify({intended: parsed.material_usage}, null, 2),
      'strategy/provider_result.json': JSON.stringify({provider: 'anthropic', model: result.model, created_at: new Date().toISOString(), warnings: result.warnings, usage: result.usage}, null, 2)
    },
    artifactPath: 'strategy/content_strategy.md',
    artifact: {sections: parsed.structure.length, structure_seconds: total, hooks: parsed.hooks.length, model: result.model},
    apply: (ctx) => { ctx.project.strategy_result = {provider: 'anthropic', model: result.model, structure_seconds: total, story_promise: parsed.story_promise}; }
  };
}

/* ---------- script ---------- */

function parseScript(modelText, targetSeconds) {
  const extracted = extractJson(modelText);
  if (!extracted.ok) fail(extracted.reason + ' Nothing was saved. Retry, or switch the model.');
  const value = extracted.value;
  const sections = (Array.isArray(value.sections) ? value.sections : []).map((section, index) => ({
    id: text(section && section.id, 'section_' + (index + 1)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    title: text(section && section.title, 'Section ' + (index + 1)),
    narration: text(section && section.narration),
    visual_notes: list(section && section.visual_notes),
    seconds: seconds(section && (section.seconds || section.duration_seconds), 0),
    source_refs: list(section && section.source_refs),
    short_form: !!(section && section.short_form)
  })).filter(section => section.narration || section.title);
  // A script with no narration at all is not a script. A single silent section is kept so asset
  // production can report it instead of quietly rendering a scene with no voice over it.
  if (!sections.some(section => section.narration)) fail('The script result has no narration. Nothing was saved.');
  const total = sections.reduce((sum, section) => sum + section.seconds, 0);
  return {sections, estimated: seconds(value.estimated_duration_seconds, total || targetSeconds || 0)};
}

function scriptMarkdown(parsed, brief) {
  const lines = ['# Script', '', 'Status: provider script; human review required', '', '## Narration', ''];
  for (const section of parsed.sections) {
    lines.push('### ' + section.title, '', section.narration, '');
    if (section.visual_notes.length) lines.push('Visual notes: ' + section.visual_notes.join('; '), '');
    if (section.source_refs.length) lines.push('Based on: ' + section.source_refs.join(', '), '');
    if (section.seconds) lines.push('Estimated: ' + section.seconds + 's', '');
  }
  lines.push('## Production', '', 'Language: ' + (brief.language || 'en') + '. Tone: ' + (brief.tone || '') + '.', '');
  return lines.join('\n');
}

async function script({brief, research: researchText, strategy: strategyResult, materials, provider}) {
  const prompt = scriptPrompt({brief, research: researchText, strategy: strategyResult, materials});
  const result = await provider.chat({system: prompt.system, user: prompt.user});
  const parsed = parseScript(result.text, brief.target_duration_seconds);
  const shorts = parsed.sections.filter(section => section.short_form).map(section => ({section_id: section.id, title: section.title}));
  return {
    outputs: {
      'script/script.md': scriptMarkdown(parsed, brief),
      'script/script.json': JSON.stringify({sections: parsed.sections, estimated_duration_seconds: parsed.estimated, narration_style: brief.tone}, null, 2),
      'script/hooks.md': '# Hook Options\n\n' + (strategyResult && strategyResult.hooks && strategyResult.hooks.length
        ? strategyResult.hooks.map(hook => '- ' + hook).join('\n')
        : 'No hooks were produced by the strategy stage.'),
      'script/shorts_candidates.json': JSON.stringify({candidates: shorts}, null, 2),
      'script/provider_result.json': JSON.stringify({provider: 'anthropic', model: result.model, created_at: new Date().toISOString(), warnings: result.warnings, usage: result.usage}, null, 2)
    },
    artifactPath: 'script/script.md',
    artifact: {sections: parsed.sections.length, estimated_duration_seconds: parsed.estimated, shorts: shorts.length, model: result.model},
    apply: (ctx) => { ctx.project.script_result = {provider: 'anthropic', model: result.model, sections: parsed.sections.length, estimated_duration_seconds: parsed.estimated}; }
  };
}

/* ---------- storyboard ---------- */

/* The catalogue the director may choose from. Only what analysis actually read is described, so a
   scene can be matched to real footage without inventing anything about it. */
function assetCatalogue(assets) {
  return (assets || []).map(asset => {
    const analysis = asset.analysis || {};
    const media = analysis.media || {};
    const transcript = analysis.transcription && analysis.transcription.status === 'done' && analysis.content
      ? String(analysis.content.text || '').slice(0, 300)
      : null;
    const excerpt = !transcript && analysis.content && analysis.detected && analysis.detected.type === 'text'
      ? String(analysis.content.text || '').slice(0, 200)
      : null;
    return {
      id: asset.id,
      name: asset.name,
      category: asset.category,
      kind: asset.kind,
      mime: asset.mime || null,
      description: transcript || excerpt || null,
      durationSeconds: media.durationSeconds || null,
      width: media.width || null,
      height: media.height || null,
      // Precomputed so the prompt does not have to reassemble it (and get it wrong).
      resolution: media.width && media.height ? media.width + 'x' + media.height : null
    };
  });
}

/* Media that can actually be cut into a video. A note or a PDF is not footage. */
function visualAssets(assets) {
  return assetCatalogue(assets).filter(asset => {
    if (asset.kind !== 'file') return false;
    return /^(video|image|audio)\//.test(String(asset.mime || '')) || asset.category === 'media';
  });
}

function parseStoryboard(modelText, options) {
  const knownIds = new Set(options.assetIds || []);
  const sectionIds = new Set((options.sectionIds || []).map(id => String(id)));
  const extracted = extractJson(modelText);
  if (!extracted.ok) fail(extracted.reason + ' Nothing was saved. Retry, or switch the model.');
  const value = extracted.value;
  const rawScenes = Array.isArray(value.scenes) ? value.scenes : [];
  const rejectedAssets = [];
  const rejectedTemplates = [];

  const scenes = rawScenes.map((scene, index) => {
    const requested = scene && scene.asset_id ? String(scene.asset_id) : null;
    let assetId = null;
    if (requested) {
      // A hallucinated asset id is dropped, not trusted. The scene becomes a missing asset.
      if (knownIds.has(requested)) assetId = requested;
      else rejectedAssets.push(requested);
    }
    const section = scene && scene.narration_section_id ? String(scene.narration_section_id) : null;
    const narrationSectionId = section && sectionIds.has(section) ? section : null;
    // A template name the app does not know is dropped rather than trusted, exactly like an
    // invented asset id: the scene simply has no graphic assigned.
    const requestedTemplate = scene && scene.graphic_template ? String(scene.graphic_template).trim() : null;
    const graphicTemplate = requestedTemplate && sceneAssets.isGraphicTemplate(requestedTemplate) ? requestedTemplate : null;
    if (requestedTemplate && !graphicTemplate) rejectedTemplates.push(requestedTemplate);
    return {
      id: text(scene && scene.id, 'scene_' + String(index + 1).padStart(3, '0')).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      title: text(scene && scene.title, 'Scene ' + (index + 1)),
      narration_section_id: narrationSectionId,
      seconds: seconds(scene && (scene.seconds || scene.duration_seconds), 0),
      visual_intent: text(scene && scene.visual_intent),
      asset_id: assetId,
      shot_type: text(scene && scene.shot_type),
      on_screen_text: text(scene && scene.on_screen_text),
      generation_prompt: text(scene && scene.generation_prompt),
      graphic_template: graphicTemplate,
      graphic_data: graphicTemplate && scene.graphic_data && typeof scene.graphic_data === 'object' && !Array.isArray(scene.graphic_data) ? scene.graphic_data : null,
      transition: text(scene && scene.transition)
    };
  }).filter(scene => scene.title || scene.visual_intent);

  if (!scenes.length) fail('The storyboard result has no scenes. Nothing was saved.');
  const total = seconds(value.total_duration_seconds, scenes.reduce((sum, scene) => sum + scene.seconds, 0));
  return {scenes, total, rejectedAssets, rejectedTemplates};
}

function storyboardMarkdown(parsed, assetsById) {
  const lines = ['# Storyboard', '', 'Status: provider storyboard; human review required', ''];
  lines.push('Scenes: ' + parsed.scenes.length + '. Total: ' + parsed.total + 's. Missing assets: ' + parsed.scenes.filter(scene => !scene.asset_id).length + '.', '');
  for (const scene of parsed.scenes) {
    const asset = scene.asset_id ? assetsById.get(scene.asset_id) : null;
    lines.push('## ' + scene.id + ': ' + scene.title, '');
    if (scene.narration_section_id) lines.push('Narration section: ' + scene.narration_section_id);
    if (scene.seconds) lines.push('Duration: ' + scene.seconds + 's');
    if (scene.visual_intent) lines.push('Visual intent: ' + scene.visual_intent);
    if (scene.shot_type) lines.push('Shot: ' + scene.shot_type);
    lines.push('Own media: ' + (asset ? asset.name : 'none selected — needs to be produced or found'));
    if (scene.graphic_template) lines.push('Drawn locally: ' + scene.graphic_template + (scene.graphic_data ? ' (data supplied)' : ' (needs data)'));
    if (scene.on_screen_text) lines.push('On screen text: ' + scene.on_screen_text);
    if (scene.transition) lines.push('Transition: ' + scene.transition);
    if (!scene.asset_id && scene.generation_prompt) lines.push('Generation prompt: ' + scene.generation_prompt);
    lines.push('');
  }
  return lines.join('\n');
}

async function storyboard({brief, script, assets, provider, sceneProvider, blockedAssets}) {
  const catalogue = visualAssets(assets);
  // Own media whose rights are not settled is withheld from the catalogue entirely, so the director
  // cannot choose it and no scene can silently depend on material that may not be publishable.
  const withheld = blockedAssets || [];
  const prompt = storyboardPrompt({brief, script, assets: catalogue});
  const result = await provider.chat({system: prompt.system, user: prompt.user});
  const parsed = parseStoryboard(result.text, {
    assetIds: catalogue.map(asset => asset.id),
    sectionIds: ((script && script.sections) || []).map(section => section.id)
  });
  const assetsById = new Map(catalogue.map(asset => [asset.id, asset]));
  const missing = sceneAssets.buildMissingAssets(parsed.scenes, sceneProvider);
  const scenePrompts = sceneAssets.buildScenePrompts(parsed.scenes, sceneProvider);
  const pack = sceneAssets.buildPromptPack({scenes: parsed.scenes, provider: sceneProvider});
  const warnings = [];
  if (parsed.rejectedAssets.length) warnings.push('The model named ' + parsed.rejectedAssets.length + ' asset id(s) that do not exist. Those scenes were treated as missing assets rather than trusted.');
  if (parsed.rejectedTemplates && parsed.rejectedTemplates.length) warnings.push('The model named ' + parsed.rejectedTemplates.length + ' graphic template(s) this app does not have. Those scenes were left without one.');
  if (!catalogue.length) warnings.push('No own media was available, so every scene needs a new asset.');
  if (withheld.length) warnings.push(withheld.length + ' own media item(s) were withheld from this storyboard because their rights are not cleared. Record the licence for each, then generate the storyboard again to use them.');

  return {
    outputs: {
      'storyboard/storyboard.json': JSON.stringify({
        scenes: parsed.scenes,
        total_duration_seconds: parsed.total,
        missing_assets: missing,
        selected_asset_ids: [...new Set(parsed.scenes.map(scene => scene.asset_id).filter(Boolean))],
        withheld_assets: withheld,
        warnings
      }, null, 2),
      'storyboard/storyboard.md': storyboardMarkdown(parsed, assetsById),
      'storyboard/scene_prompts.json': JSON.stringify({
        provider: pack.provider,
        aspect_ratio: pack.aspect_ratio,
        profiles: pack.profiles,
        summary: pack.summary,
        prompts: scenePrompts
      }, null, 2),
      'storyboard/scene_prompts.md': sceneAssets.promptPackMarkdown(pack),
      'storyboard/provider_result.json': JSON.stringify({provider: 'anthropic', model: result.model, created_at: new Date().toISOString(), warnings: result.warnings, usage: result.usage}, null, 2)
    },
    artifactPath: 'storyboard/storyboard.json',
    artifact: {
      scenes: parsed.scenes.length,
      missing_assets: missing.length,
      selected_assets: parsed.scenes.filter(scene => scene.asset_id).length,
      rejected_asset_ids: parsed.rejectedAssets.length,
      rejected_templates: (parsed.rejectedTemplates || []).length,
      typographic_scenes: pack.summary.typographic,
      withheld_assets: withheld.length,
      total_duration_seconds: parsed.total,
      warnings,
      model: result.model
    },
    apply: (ctx) => {
      ctx.project.storyboard_result = {
        provider: 'anthropic',
        model: result.model,
        scenes: parsed.scenes.length,
        missing_assets: missing.length,
        selected_assets: parsed.scenes.filter(scene => scene.asset_id).length
      };
    }
  };
}

/* ---------- asset production ---------- */

/* What kind of media a library asset is, from its own type. Reliable without analysis, which a
   freshly generated file has not had yet. */
function mediaKind(asset) {
  const mime = String((asset && asset.mime) || '');
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/* A stable identity for a drawn scene, so an unchanged scene is reused instead of re-rendered and a
   changed one is redrawn. Only what actually affects the picture is included. */
function graphicSignature(scene, fps) {
  return createHash('sha1').update(JSON.stringify({
    template: scene.graphic_template,
    data: scene.graphic_data || {},
    text: scene.on_screen_text || '',
    title: scene.title || '',
    seconds: Number(scene.seconds) || 0,
    fps: fps || null
  })).digest('hex');
}

/* Draws one scene locally, or reuses the drawing from last time when nothing that affects the
   picture has changed. A template that cannot render its data fails with the reason rather than
   producing a blank or invented frame. */
async function drawGraphicScene({scene, index, graphicsDir, asProjectPath, drawScene, fps, known}) {
  const template = scene.graphic_template;
  const problem = sceneAssets.validateGraphicData(template, scene.graphic_data);
  if (problem) {
    return {scene_id: scene.id, status: 'failed', template, reason: problem + ' Give this scene the data it needs, or assign a different template.', retryable: false};
  }
  const fileName = 'scene-' + String(index + 1).padStart(3, '0') + '-' + String(scene.id).replace(/[^a-z0-9_-]+/gi, '_') + '.mp4';
  const target = path.join(graphicsDir, fileName);
  const signature = graphicSignature(scene, fps);
  if (known && known.signature === signature && known.file === fileName && fs.existsSync(target)) {
    return {scene_id: scene.id, status: 'rendered', file: fileName, path: asProjectPath(target), template, seconds: Number(scene.seconds) || 0, signature, reused: true};
  }
  try {
    const data = scene.graphic_data || {};
    const rendered = await drawScene({
      template,
      outputPath: target,
      fps: fps || undefined,
      seconds: Number(scene.seconds) || 4,
      scene: {
        template,
        text: data.text !== undefined ? data.text : (scene.on_screen_text || scene.title || ''),
        subtext: data.subtext || '',
        eyebrow: data.eyebrow || '',
        footnote: data.footnote || '',
        options: data.options || {},
        data,
        seconds: Number(scene.seconds) || 4
      }
    });
    return {
      scene_id: scene.id,
      status: 'rendered',
      file: fileName,
      path: asProjectPath(target),
      template,
      seconds: rendered.durationSeconds,
      bytes: rendered.bytes,
      framecount: rendered.frameCount,
      signature,
      reused: false
    };
  } catch (error) {
    return {scene_id: scene.id, status: 'failed', template, reason: error.message, retryable: false};
  }
}

/* Fills the two gaps the storyboard leaves: spoken narration, and footage for scenes that selected
   nothing. Every attempt is recorded, including the ones that produced nothing, so the composer and
   the operator both know exactly what exists. */
async function production({script, storyboard: board, audioDir, videoDir, projectDirectory, speech, stock, rightsOf, assetOf, tools, execFileSync: run, onProgress, renderGraphic, graphicFps, previousRenders}) {
  const sections = (script && script.sections) || [];
  const scenes = (board && board.scenes) || [];
  const anchor = path.resolve(projectDirectory || path.dirname(videoDir));
  const asProjectPath = filePath => path.relative(anchor, filePath).split(path.sep).join('/');
  const graphicsDir = path.join(path.dirname(videoDir), 'graphics');
  const drawScene = renderGraphic || (args => require('./frameRenderer').renderScene(args));
  const knownRenders = new Map((previousRenders || []).map(item => [item.scene_id, item]));

  const narration = await produceNarration({
    sections,
    audioDir,
    projectDirectory: anchor,
    tools,
    execFileSync: run,
    speak: ({text, targetPath}) => {
      if (!speech) fail('Narration needs a speech provider. Add an API key in Settings.');
      return speech({text, targetPath});
    }
  });

  const produced = [];
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index];
    if (scene.asset_id) continue;
    const query = scene.generation_prompt || scene.visual_intent || scene.title;
    if (onProgress) onProgress({sceneId: scene.id, index, total: scenes.length});

    /* A scene the storyboard assigned a template to is drawn here, by our own code, which spells the
       words exactly. This comes before stock sourcing: a chart or a terminal is not something to go
       looking for footage of. */
    if (scene.graphic_template) {
      produced.push(await drawGraphicScene({
        scene, index, graphicsDir, asProjectPath, drawScene, graphicFps, known: knownRenders.get(scene.id)
      }));
      continue;
    }

    if (!stock) {
      produced.push({scene_id: scene.id, status: 'skipped', reason: 'No stock media provider is configured, and this scene has no own material.', query: searchQueryFor(query)});
      continue;
    }
    const found = await stock.search({query, minDurationSeconds: scene.seconds});
    if (!found.ok) {
      produced.push({scene_id: scene.id, status: 'failed', reason: found.reason, query: searchQueryFor(query), retryable: found.retryable !== false});
      continue;
    }
    try {
      // A still comes back as jpg or png, so the extension comes from the source rather than being
      // assumed to be mp4. The composer decides how long a still is held.
      const extension = String(found.clip.extension || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
      const fileName = 'scene-' + String(index + 1).padStart(3, '0') + '-' + String(scene.id).replace(/[^a-z0-9_-]+/gi, '_') + '.' + extension;
      const saved = await stock.download({url: found.clip.url, targetPath: path.join(videoDir, fileName)});
      produced.push({
        scene_id: scene.id,
        status: 'produced',
        file: fileName,
        path: asProjectPath(saved.path),
        bytes: saved.bytes,
        clip: found.clip,
        matched_duration_seconds: found.clip.duration_seconds,
        sourced_after: found.attempts && found.attempts.length ? found.attempts : undefined
      });
    } catch (error) {
      produced.push({scene_id: scene.id, status: 'failed', reason: error.message, query: searchQueryFor(query)});
    }
  }

  const byScene = new Map(produced.map(item => [item.scene_id, item]));
  const scenesWithMedia = scenes.map(scene => {
    // Own media keeps its rights record with the scene, so the composer and the QC report can judge
    // it without going back to the library.
    if (scene.asset_id) {
      const rights = rightsOf ? rightsOf(scene.asset_id) : null;
      const asset = assetOf ? assetOf(scene.asset_id) : null;
      const analysis = (asset && asset.analysis) || {};
      const media = analysis.media || {};
      return {
        scene_id: scene.id,
        title: scene.title,
        seconds: scene.seconds,
        status: 'own_media',
        asset_id: scene.asset_id,
        origin: rights && rights.basis === 'generated' ? 'generated' : 'own',
        // What the composer needs to place this clip, so it never has to resolve the library itself.
        media: asset ? {
          kind: mediaKind(asset),
          duration_seconds: media.durationSeconds || null,
          width: media.width || null,
          height: media.height || null,
          name: asset.name || null
        } : null,
        rights
      };
    }
    const outcome = byScene.get(scene.id);
    const rendered = outcome && outcome.status === 'rendered';
    return {
      scene_id: scene.id,
      title: scene.title,
      seconds: scene.seconds,
      status: outcome ? outcome.status : 'skipped',
      file: outcome && outcome.file ? outcome.file : null,
      path: outcome && outcome.path ? outcome.path : null,
      reason: outcome && outcome.reason ? outcome.reason : null,
      template: outcome && outcome.template ? outcome.template : null,
      reused: !!(outcome && outcome.reused),
      clip: outcome && outcome.clip ? outcome.clip : null,
      // Drawn locally from the project's own script, so the basis is our own work.
      rights: rendered
        ? {basis: 'own', title: scene.title || null, holder: null, source_url: null, note: 'Drawn locally from this project\'s script.'}
        : (outcome && outcome.clip && outcome.clip.rights ? outcome.clip.rights : null)
    };
  });

  const producedCount = scenesWithMedia.filter(scene => scene.status === 'produced').length;
  const ownCount = scenesWithMedia.filter(scene => scene.status === 'own_media').length;
  const renderedCount = scenesWithMedia.filter(scene => scene.status === 'rendered').length;
  const generatedCount = scenesWithMedia.filter(scene => scene.origin === 'generated').length;
  const stillMissing = scenesWithMedia.filter(scene => scene.status !== 'own_media' && scene.status !== 'produced' && scene.status !== 'rendered').length;

  /* Only scenes that actually have media are gated. A scene with no footage is a separate failure,
     and conflating the two would hide which problem the operator has to solve. */
  const withMedia = scenesWithMedia.filter(scene => scene.status === 'own_media' || scene.status === 'produced' || scene.status === 'rendered');
  const gate = licensing.rightsGate(withMedia.map(scene => ({id: scene.scene_id, name: scene.title || scene.scene_id, rights: scene.rights})));
  // The verdict is written next to the provenance it came from, so the interface shows the real
  // decision instead of re-deriving one from the licence record.
  const verdicts = new Map(gate.cleared.concat(gate.blocked).map(item => [item.id, item]));
  for (const scene of withMedia) scene.rights_state = verdicts.get(scene.scene_id) || null;

  const warnings = [];
  if (!speech) warnings.push('Narration was not produced: no speech provider is configured.');
  if (narration.failed) warnings.push(narration.failed + ' narration section(s) failed.');
  if (narration.empty) warnings.push(narration.empty + ' script section(s) have no narration text.');
  const needsFootage = scenes.filter(scene => !scene.asset_id && !scene.graphic_template).length;
  if (!stock && needsFootage) warnings.push('Some scenes have no media: no stock provider is configured.');
  if (gate.summary.blocked) warnings.push(gate.summary.blocked + ' scene(s) use material whose rights are not cleared, so the video cannot be rendered yet.');
  const drawFailures = scenesWithMedia.filter(scene => scene.status === 'failed' && scene.template);
  if (drawFailures.length) warnings.push(drawFailures.length + ' scene(s) could not be drawn locally. Each one says why.');
  // A disabled source is reported as a reason, never as an unexplained absence of footage.
  const sourcing = (stock && typeof stock.describe === 'function') ? stock.describe() : null;
  if (sourcing) for (const item of sourcing.unavailable) warnings.push(item.short + ' was not searched: ' + item.reason);

  const manifest = {
    status: stillMissing === 0 && narration.failed === 0 && gate.can_render ? 'complete' : 'incomplete',
    narration: {produced: narration.produced, failed: narration.failed, empty: narration.empty, total_seconds: narration.totalSeconds, total_characters: narration.totalCharacters, sections: narration.sections},
    scenes: scenesWithMedia,
    sourcing,
    rights: {
      can_render: gate.can_render,
      attributions: gate.attributions,
      blocked: gate.blocked.map(item => ({scene_id: item.id, title: item.name, reasons: item.reasons})),
      warnings: gate.warnings.map(item => ({scene_id: item.id, title: item.name, warnings: item.warnings})),
      note: 'Material whose rights are not recorded is blocked here and again before rendering.'
    },
    counts: {
      own_media: ownCount,
      produced: producedCount,
      rendered: renderedCount,
      generated_external: generatedCount,
      still_missing: stillMissing,
      rights_blocked: gate.summary.blocked,
      total_scenes: scenes.length
    },
    warnings
  };

  return {
    outputs: {
      'generated/asset_manifest.json': JSON.stringify(manifest, null, 2),
      /* What was drawn, and the signature of what it was drawn from. The signature is what lets a
         later run reuse an unchanged drawing instead of spending minutes redrawing it. */
      'generated/graphics/render_manifest.json': JSON.stringify({
        renders: produced.filter(item => item.status === 'rendered').map(item => ({
          scene_id: item.scene_id,
          template: item.template,
          file: item.file,
          path: item.path,
          signature: item.signature,
          seconds: item.seconds,
          bytes: item.bytes || null,
          reused: !!item.reused
        })),
        note: 'Scenes drawn locally from this project\'s own script. No external source was used.'
      }, null, 2),
      'generated/audio/narration_plan.json': JSON.stringify({provider: speech ? 'openai' : null, status: narration.failed ? 'partial' : (narration.produced ? 'ready' : 'empty'), estimate: narration.estimate, sections: narration.sections}, null, 2),
      'analyzed/asset_index.json': JSON.stringify({
        generated: produced.filter(item => item.status === 'produced').map(item => ({scene_id: item.scene_id, path: item.path, media_kind: item.clip.media_kind || 'video', provider: item.clip.provider, source_url: item.clip.url, author: item.clip.author, licence: item.clip.licence, attribution_required: item.clip.attribution_required, duration_seconds: item.clip.duration_seconds, rights: item.clip.rights || null})),
        rendered: produced.filter(item => item.status === 'rendered').map(item => ({scene_id: item.scene_id, path: item.path, template: item.template, duration_seconds: item.seconds, reused: !!item.reused, note: 'Drawn locally from this project\'s own script; no external source.'})),
        narration: narration.sections.filter(section => section.status === 'done').map(section => ({section_id: section.section_id, path: section.path, duration_seconds: section.duration_seconds, model: section.model, voice: section.voice})),
        attributions: gate.attributions,
        note: 'Generated assets with provenance. Own material lives in the library, not here.'
      }, null, 2)
    },
    artifactPath: 'generated/asset_manifest.json',
    artifact: {
      narration_produced: narration.produced,
      narration_failed: narration.failed,
      narration_seconds: narration.totalSeconds,
      narration_estimate: narration.estimate,
      scenes_with_own_media: ownCount,
      scenes_produced: producedCount,
      scenes_rendered: renderedCount,
      scenes_generated_external: generatedCount,
      scenes_still_missing: stillMissing,
      rights_blocked: gate.summary.blocked,
      attributions: gate.attributions.length,
      status: manifest.status,
      warnings
    },
    apply: (ctx) => {
      ctx.project.assets_result = {
        status: manifest.status,
        narration_produced: narration.produced,
        narration_seconds: narration.totalSeconds,
        scenes_produced: producedCount,
        scenes_rendered: renderedCount,
        scenes_generated_external: generatedCount,
        scenes_still_missing: stillMissing,
        rights_blocked: gate.summary.blocked
      };
    }
  };
}

/* A stock query is derived from the scene description; this mirrors the adapter's own cleaning so the
   manifest shows the query that was actually used. */
function searchQueryFor(intent) {
  const clean = String(intent || '').replace(/[\r\n]+/g, ' ').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.split(' ').filter(Boolean).slice(0, 8).join(' ') || 'b roll';
}

module.exports = {research, strategy, script, storyboard, production, parseStrategy, parseScript, parseStoryboard, checkResearch, assetCatalogue, visualAssets, storyboardMarkdown, mediaKind, graphicSignature, RESEARCH_HEADINGS};
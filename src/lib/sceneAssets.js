'use strict';
/* Scene assets: choosing a template, deriving the data it needs, and building the prompt pack for
   tools this app cannot call. Pure functions with no disk, network or provider access, so the
   storyboard stage can use them without pulling in a browser or FFmpeg. */

const GRAPHIC_TEMPLATES = ['text-card', 'bar-chart', 'terminal', 'diagram', 'split-compare', 'end-card'];

/* Guidance for a manual generation round trip. These notes are advisory, not vendor documentation:
   they were not taken from Leonardo's or Mootion's own current manuals, and the interface says so. */
const TOOL_PROFILES = {
  manual: {
    short: 'Manual / own media',
    verified: true,
    notes: [
      'Treat this as a shot list: each scene names how long it needs and what should be on screen.',
      'Anything you cannot shoot or find is a candidate for a local template render instead.'
    ]
  },
  leonardo: {
    short: 'Leonardo AI',
    verified: false,
    notes: [
      'Paste the prompt unchanged. It already describes the shot, and extra style words will fight it.',
      'Generate at 16:9 so the result drops into the timeline without reframing.',
      'Keep one style phrase identical across every shot, or the scenes will not look like one video.',
      'These notes are guidance, not vendor documentation. Check the tool itself.'
    ]
  },
  comfy: {
    short: 'Comfy Cloud',
    verified: false,
    notes: [
      'The app can run this one itself: export the workflow with Workflow then Export (API) and point ' +
        'workflows.json at it. The prompt goes into the node named there.',
      'Generate at the scene length or longer. A shorter clip is looped to fill the scene, which is visible.',
      'These notes are guidance, not vendor documentation. Check the workflow you exported.'
    ]
  },
  mootion: {
    short: 'Mootion',
    verified: false,
    notes: [
      'Mootion works from a script or an image; feed it one shot at a time for per-scene control.',
      'Generate at 16:9 and keep each clip at least as long as the scene needs.',
      'These notes are guidance, not vendor documentation. Check the tool itself.'
    ]
  }
};

function graphicTemplates() { return GRAPHIC_TEMPLATES.slice(); }
function isGraphicTemplate(name) { return GRAPHIC_TEMPLATES.includes(String(name)); }
function toolProfiles() {
  const copy = {};
  for (const key of Object.keys(TOOL_PROFILES)) copy[key] = Object.assign({}, TOOL_PROFILES[key], {notes: TOOL_PROFILES[key].notes.slice()});
  return copy;
}
function profileFor(provider) {
  const key = String(provider || 'manual');
  return Object.hasOwn(TOOL_PROFILES, key) ? key : 'manual';
}

/* Text scenes are the ones where a video generator is the wrong tool: it misspells on-screen words.
   A heuristic, and the interface presents it as a flag, never as a verdict. */
function isTypographic(scene) {
  const onScreen = String((scene && scene.on_screen_text) || '').trim();
  if (onScreen) return true;
  const source = [scene && scene.visual_intent, scene && scene.generation_prompt, scene && scene.title].filter(Boolean).join(' ');
  return /\b(text|typography|typeface|title card|word|words|label|labels|caption|captions|subtitle|font|logo|read|reads|lettering)\b/i.test(source);
}

/* Ordered rules: the first that matches wins, so a "terminal showing a node graph" is a terminal. */
const TEMPLATE_RULES = [
  {template: 'end-card', test: /\bend[- ]?card\b|\boutro\b|\bclosing card\b|\bnext:\s/i},
  {template: 'terminal', test: /\bterminal\b|\bcommand line\b|\bpowershell\b|\bbash\b|\bshell\b|\bcli\b|pip install|npm install|\bcurl\b/i},
  {template: 'bar-chart', test: /\bbar chart\b|\bbar graph\b|\bbenchmark\b|\bthroughput\b|\bspeed[- ]?up\b|\brace[sd]? upward\b|\bracing bar\b|\bbars?\b[^.]{0,24}\b(race|rise|climb|grow)/i},
  {template: 'split-compare', test: /\bsplit[- ]screen\b|\bside[- ]by[- ]side\b|\bvs\.?\b|\bversus\b|\bcompar/i},
  {template: 'diagram', test: /\bdiagram\b|\bnodes?\b|\bgraph\b|\bpipeline\b|\bflowchart\b|\bwhiteboard\b|\bschematic\b|\barchitecture\b/i}
];

function suggestTemplate(scene) {
  const source = [scene && scene.visual_intent, scene && scene.generation_prompt, scene && scene.on_screen_text, scene && scene.title].filter(Boolean).join(' ');
  for (const rule of TEMPLATE_RULES) if (rule.test.test(source)) return rule.template;
  return 'text-card';
}

function sceneText(scene) {
  return String((scene && (scene.on_screen_text || scene.visual_intent || scene.title)) || '').trim();
}

/* Derivation attempts. Each returns empty rather than a plausible invention: a bar chart of made-up
   numbers in a technical explainer is worse than an empty one that fails validation. */
function deriveLines(scene) {
  const raw = String((scene && scene.on_screen_text) || '').trim();
  const source = raw || sceneText(scene);
  if (!source) return [];
  return source.split(/\r?\n|\s*\|\s*/).map(line => line.trim()).filter(Boolean).map(text => ({text}));
}

function deriveBars(scene) {
  const raw = String((scene && scene.on_screen_text) || '');
  const bars = [];
  const pattern = /([A-Za-z0-9 ._+-]{1,24}?)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const label = match[1].trim();
    if (label) bars.push({label, value: Number(match[2])});
  }
  return bars.length >= 2 ? bars : [];
}

function deriveNodes(scene) {
  const raw = String((scene && scene.on_screen_text) || '');
  const labels = raw.split(/\s*(?:->|=>|→|, then | then )\s*/).map(part => part.trim()).filter(Boolean);
  if (labels.length < 2) return {nodes: [], edges: []};
  const step = labels.length > 1 ? 60 / (labels.length - 1) : 0;
  const nodes = labels.map((label, index) => ({label, x: Math.round(20 + step * index), y: 50}));
  return {nodes, edges: nodes.slice(1).map((_, index) => [index, index + 1])};
}

function deriveSplit(scene) {
  const parts = String((scene && scene.on_screen_text) || '').split(/\s*\|\s*/).map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) return {left: {label: '', text: parts[0]}, right: {label: '', text: parts.slice(1).join(' ')}};
  return {left: {label: '', text: ''}, right: {label: '', text: ''}};
}

/* What the data must contain before a template can honestly render. Returns a message, or null. */
function validateGraphicData(template, data) {
  const value = data || {};
  if (template === 'bar-chart') {
    if (!Array.isArray(value.bars) || value.bars.length < 2) return 'A bar chart needs data.bars with at least two entries.';
    for (const bar of value.bars) {
      if (!bar || bar.label === undefined || !String(bar.label).trim()) return 'Every bar needs a label.';
      if (!Number.isFinite(Number(bar.value))) return 'Every bar needs a numeric value, and "' + bar.label + '" has none.';
    }
  }
  if (template === 'diagram') {
    if (!Array.isArray(value.nodes) || value.nodes.length < 2) return 'A diagram needs data.nodes with at least two entries.';
    for (const node of value.nodes) {
      if (!node || !String(node.label === undefined ? '' : node.label).trim()) return 'Every node needs a label.';
    }
  }
  if (template === 'split-compare') {
    const left = String((value.left && value.left.text) || '').trim();
    const right = String((value.right && value.right.text) || '').trim();
    if (!left || !right) return 'A split comparison needs data.left.text and data.right.text.';
  }
  if (template === 'terminal') {
    const lines = Array.isArray(value.lines) ? value.lines : [];
    if (!lines.some(line => String((line && line.text) || line || '').trim())) return 'A terminal needs data.lines with at least one line.';
  }
  return null;
}

/* A starting point the operator can edit, derived from what the storyboard already said. */
function defaultGraphicData(template, scene) {
  if (template === 'bar-chart') return {data: {bars: deriveBars(scene), footnote: ''}, options: {}};
  if (template === 'diagram') { const derived = deriveNodes(scene); return {data: {nodes: derived.nodes, edges: derived.edges}, options: {}}; }
  if (template === 'split-compare') return {data: deriveSplit(scene), options: {}};
  if (template === 'terminal') return {data: {title: '', lines: deriveLines(scene)}, options: {}};
  if (template === 'end-card') return {data: {next: ''}, options: {}};
  const source = String((scene && (scene.visual_intent || scene.generation_prompt)) || '');
  const reveal = /word[- ]by[- ]word|animat\w*\s+in\s+word/i.test(source) ? 'words' : 'fade';
  return {data: {}, options: {reveal}};
}

/* The scenes the storyboard left without own media: exactly the ones that need filling. */
function scenesNeedingMedia(scenes) {
  return (scenes || []).filter(scene => !scene.asset_id);
}

function buildScenePrompts(scenes, provider) {
  return scenesNeedingMedia(scenes).map(scene => ({
    scene_id: scene.id,
    title: scene.title || '',
    provider: provider || null,
    prompt: scene.generation_prompt || '',
    intent: scene.visual_intent || '',
    seconds: scene.seconds || 0,
    shot_type: scene.shot_type || '',
    on_screen_text: scene.on_screen_text || '',
    typographic: isTypographic(scene),
    aspect_ratio: '16:9',
    suggested_template: suggestTemplate(scene),
    /* A starting point for the suggested template, derived from what the storyboard already said.
       Empty when nothing could be derived, so the editor opens empty rather than with invented data. */
    suggested_data: (function () {
      const derived = defaultGraphicData(suggestTemplate(scene), scene);
      return Object.assign({}, derived.data, {options: derived.options});
    })(),
    /* Already planned to be drawn locally. It stays in the pack as a fallback, but the operator
       should not spend a generation on it by accident. */
    assigned_template: scene.graphic_template || null
  }));
}

function buildMissingAssets(scenes, provider) {
  return scenesNeedingMedia(scenes).map(scene => ({
    scene_id: scene.id,
    title: scene.title,
    seconds: scene.seconds,
    visual_intent: scene.visual_intent,
    shot_type: scene.shot_type,
    generation_prompt: scene.generation_prompt,
    provider: provider || null
  }));
}

function buildPromptPack({scenes, provider, profiles}) {
  const prompts = buildScenePrompts(scenes, provider);
  const chosen = profileFor(provider);
  return {
    provider: chosen,
    aspect_ratio: '16:9',
    profiles: profiles || toolProfiles(),
    scenes: prompts,
    summary: {
      total: prompts.length,
      typographic: prompts.filter(item => item.typographic).length,
      without_prompt: prompts.filter(item => !String(item.prompt).trim()).length,
      total_seconds: prompts.reduce((sum, item) => sum + (Number(item.seconds) || 0), 0)
    }
  };
}

/* The human-readable pack. The model's prompt is copied verbatim into a fenced block; the notes sit
   apart from it so nobody has to guess which words are the prompt and which are advice. */
function promptPackMarkdown(pack) {
  const chosen = pack.provider || 'manual';
  const profile = (pack.profiles || {})[chosen] || TOOL_PROFILES.manual;
  const lines = [
    '# Scene prompts',
    '',
    'Generated from the storyboard. Each block is one scene: the prompt is exactly what the storyboard',
    'wrote, and the notes are separate so they are never mistaken for part of it.',
    '',
    'Tool: ' + profile.short + (profile.verified ? '' : ' (notes are guidance, not vendor documentation)'),
    'Aspect ratio: ' + (pack.aspect_ratio || '16:9'),
    'Scenes needing media: ' + pack.summary.total + ', total ' + pack.summary.total_seconds + 's',
    ''
  ];
  lines.push('## How to use these', '');
  for (const note of profile.notes) lines.push('- ' + note);
  lines.push('');
  if (pack.summary.typographic) {
    lines.push('## A caution about ' + pack.summary.typographic + ' of these scenes', '');
    lines.push('They are mostly on-screen words. A video generator will misspell them or invent text that',
      'is not in your script, which is worse than useless in a technical explainer. Those scenes are',
      'better served by a local template render, which draws the exact words.', '');
  }
  for (const scene of pack.scenes) {
    lines.push('## ' + scene.scene_id + ': ' + (scene.title || 'Untitled'), '');
    lines.push('- Needs: ' + (scene.seconds || 0) + 's at ' + scene.aspect_ratio);
    if (scene.shot_type) lines.push('- Shot: ' + scene.shot_type);
    if (scene.on_screen_text) lines.push('- On screen: ' + scene.on_screen_text);
    if (scene.intent) lines.push('- Intent: ' + scene.intent);
    if (scene.typographic) lines.push('- Mostly on-screen text: a local template render will spell it correctly');
    lines.push('');
    if (String(scene.prompt).trim()) {
      lines.push('```text', String(scene.prompt).trim(), '```', '');
    } else {
      lines.push('_The storyboard wrote no prompt for this scene._', '');
    }
  }
  return lines.join('\n');
}

module.exports = {
  GRAPHIC_TEMPLATES, graphicTemplates, isGraphicTemplate, TOOL_PROFILES, toolProfiles, profileFor,
  isTypographic, suggestTemplate, validateGraphicData, defaultGraphicData, scenesNeedingMedia,
  buildScenePrompts, buildMissingAssets, buildPromptPack, promptPackMarkdown
};
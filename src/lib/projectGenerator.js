"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  APPROVAL_GATES,
  APPROVAL_STATES,
  DIRECTORY_STRUCTURE,
  WORKFLOW_STATUSES
} = require("../config/workflow");
const { buildBrief, slugify } = require("./promptIntake");

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, `${value.replace(/\s+$/u, "")}\n`, "utf8");
}

function parsePlatformList(value) {
  if (!value) return null;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNextProjectNumber(projectsRoot, year) {
  if (!fs.existsSync(projectsRoot)) return 1;

  const prefix = `${year}-`;
  const highest = fs.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const match = entry.name.match(new RegExp(`^${year}-(\\d{3})`));
      return match ? Number(match[1]) : 0;
    })
    .reduce((max, number) => Math.max(max, number), 0);

  return highest + 1;
}

function createProjectId(projectsRoot, now = new Date()) {
  const year = now.getUTCFullYear();
  const nextNumber = getNextProjectNumber(projectsRoot, year);
  return `${year}-${String(nextNumber).padStart(3, "0")}`;
}

function createApprovals() {
  return Object.fromEntries(APPROVAL_GATES.map((gate) => [gate, "not_ready"]));
}

function createWorkflowState() {
  return {
    version: 1,
    revision: 0,
    brief: { revision: 0, state: 'needs_review' },
    materials: { revision: 0, state: 'locked', selections: [], without_material: false },
    stages: Object.fromEntries(['research', 'strategy', 'script', 'storyboard', 'assets', 'compose', 'final', 'exports'].map(name => [name, { state: 'locked', revision: 0 }])),
    approvals: []
  };
}

// Existing projects retain artifacts; no historic approval is inferred during migration.
function migrateProject(project) {
  if (!project.workflow) {
    project.workflow = createWorkflowState();
    project.schema_version = '0.2.0';
    return project;
  }
  /* Stages added after this project was created are backfilled as locked, so an older project can
     still run them instead of failing on a missing record. */
  const expected = createWorkflowState().stages;
  if (!project.workflow.stages) project.workflow.stages = {};
  for (const name of Object.keys(expected)) {
    if (!project.workflow.stages[name]) project.workflow.stages[name] = { state: 'locked', revision: 0 };
  }
  return project;
}

function createProjectJson({ brief, projectId, slug, providers, now }) {
  return {
    schema_version: "0.2.0",
    workflow: createWorkflowState(),
    project_id: projectId,
    slug,
    created_at: now,
    updated_at: now,
    status: "created",
    approval_state: "not_ready",
    topic: brief.topic,
    audience: brief.audience,
    language: brief.language,
    tone: brief.tone,
    primary_platform: brief.primary_platform,
    target_platforms: brief.target_platforms,
    target_duration_seconds: brief.target_duration_seconds,
    llm_provider: {
      name: providers.llmProvider,
      model: providers.llmModel
    },
    video_generation_providers: {
      scene_asset_provider: providers.sceneProvider,
      sequence_provider: providers.sequenceProvider
    },
    voice_provider: {
      name: providers.voiceProvider,
      voice_id: providers.voiceId
    },
    paths: {
      original_prompt: "prompt/original_prompt.md",
      refined_brief: "prompt/refined_brief.json",
      research: "research/research_notes.md",
      sources: "research/sources.json",
      fact_check: "research/fact_check.json",
      strategy: "strategy/content_strategy.md",
      audience: "strategy/audience.json",
      retention_plan: "strategy/retention_plan.json",
      script: "script/script.md",
      script_json: "script/script.json",
      hooks: "script/hooks.md",
      shorts_candidates: "script/shorts_candidates.json",
      storyboard: "storyboard/storyboard.json",
      storyboard_markdown: "storyboard/storyboard.md",
      scene_prompts: "storyboard/scene_prompts.json",
      source_urls: "source/urls.json",
      asset_index: "analyzed/asset_index.json",
      material_analysis: "analyzed/material_analysis.json",
      narration_plan: "generated/audio/narration_plan.json",
      timeline: "compose/timeline.json",
      captions: "compose/captions.srt",
      render_config: "compose/render_config.json",
      qc_report: "qc/qc_report.md",
      qc_report_json: "qc/qc_report.json",
      youtube_master: "final/youtube_master.mp4",
      youtube_thumbnail: "final/youtube_thumbnail.jpg",
      youtube_metadata: "final/youtube_metadata.json",
      approval_log: "publishing/approval_log.json",
      publish_jobs: "publishing/publish_jobs.json",
      published_urls: "publishing/published_urls.json",
      youtube_analytics: "analytics/youtube_analytics.json",
      short_form_analytics: "analytics/short_form_analytics.json",
      lessons_learned: "analytics/lessons_learned.md"
    },
    approvals: createApprovals(),
    status_values: WORKFLOW_STATUSES,
    approval_values: APPROVAL_STATES
  };
}

function createStarterFiles(projectDirectory, project, brief) {
  writeText(path.join(projectDirectory, "prompt", "original_prompt.md"), `# Original Prompt\n\n${brief.original_prompt}`);
  writeJson(path.join(projectDirectory, "prompt", "refined_brief.json"), brief);

  writeText(path.join(projectDirectory, "research", "research_notes.md"), `# Research Notes\n\nStatus: not started\n\n## Research Questions\n\n- What should the audience understand by the end of the video?\n- Which claims need verification before scripting?\n- What current examples, objections, and trends matter for this topic?\n`);
  writeJson(path.join(projectDirectory, "research", "sources.json"), { sources: [] });
  writeJson(path.join(projectDirectory, "research", "fact_check.json"), { verified_claims: [], uncertain_claims: [], rejected_claims: [] });

  writeText(path.join(projectDirectory, "strategy", "content_strategy.md"), `# Content Strategy\n\nStatus: not started\n\n## Topic\n\n${brief.topic}\n\n## Audience\n\n${brief.audience}\n\n## Working Promise\n\nTo be drafted after research.\n`);
  writeJson(path.join(projectDirectory, "strategy", "audience.json"), { audience: brief.audience, segments: [], viewer_questions: [] });
  writeJson(path.join(projectDirectory, "strategy", "retention_plan.json"), { hooks: [], retention_moments: [], short_form_opportunities: [] });

  writeText(path.join(projectDirectory, "script", "script.md"), "# Script\n\nStatus: not started\n\n## Narration\n\n");
  writeJson(path.join(projectDirectory, "script", "script.json"), { sections: [], estimated_duration_seconds: brief.target_duration_seconds });
  writeText(path.join(projectDirectory, "script", "hooks.md"), "# Hook Options\n\n");
  writeJson(path.join(projectDirectory, "script", "shorts_candidates.json"), { candidates: [] });

  writeText(path.join(projectDirectory, "storyboard", "storyboard.md"), "# Storyboard\n\nStatus: not started\n\n");
  writeJson(path.join(projectDirectory, "storyboard", "storyboard.json"), { scenes: [] });
  writeJson(path.join(projectDirectory, "storyboard", "scene_prompts.json"), { prompts: [] });

  writeJson(path.join(projectDirectory, "source", "urls.json"), { urls: [] });
  writeJson(path.join(projectDirectory, "analyzed", "asset_index.json"), { project_id: project.project_id, assets: [] });
  writeJson(path.join(projectDirectory, "analyzed", "material_analysis.json"), { source_material: [], knowledge_assets: [], media_assets: [], brand_assets: [] });
  writeJson(path.join(projectDirectory, "generated", "audio", "narration_plan.json"), { provider: project.voice_provider, sections: [], audio_assets: [] });

  /* These are placeholders that say so. They used to be written as empty results, which made a fresh
     project look as though a timeline and a QC report already existed. */
  writeJson(path.join(projectDirectory, "compose", "timeline.json"), { status: "not_started", tracks: [], note: "No timeline has been composed yet." });
  writeText(path.join(projectDirectory, "compose", "captions.srt"), "");
  writeJson(path.join(projectDirectory, "compose", "render_config.json"), {
    renderer: "ffmpeg",
    master: { width: 1920, height: 1080, fps: 24, format: "mp4" },
    adaptations: {
      youtube_shorts: { width: 1080, height: 1920, max_seconds: 60, format: "mp4" },
      tiktok: { width: 1080, height: 1920, max_seconds: 180, format: "mp4" },
      instagram: { width: 1080, height: 1920, max_seconds: 90, format: "mp4" },
      facebook: { width: 1080, height: 1920, max_seconds: 90, format: "mp4" },
      square_feed: { width: 1080, height: 1080, max_seconds: 90, format: "mp4" }
    },
    note: "The composer and the exports use these figures. The render log records what actually ran."
  });

  writeText(path.join(projectDirectory, "qc", "qc_report.md"), "# QC Report\n\nStatus: not started\n\nNo video has been composed yet.\n");
  writeJson(path.join(projectDirectory, "qc", "qc_report.json"), { status: "not_started", checks: [], blocking_issues: [], can_approve_master: false, note: "No QC has run yet. Composing the video produces this report." });
  writeJson(path.join(projectDirectory, "final", "youtube_metadata.json"), { status: "not_started", note: "No metadata package has been generated yet. The final check writes this." });

  writeJson(path.join(projectDirectory, "publishing", "approval_log.json"), { approvals: [] });
  writeJson(path.join(projectDirectory, "publishing", "publish_jobs.json"), { jobs: [] });
  writeJson(path.join(projectDirectory, "publishing", "published_urls.json"), { urls: [] });

  writeJson(path.join(projectDirectory, "analytics", "youtube_analytics.json"), { imported_at: null, metrics: {} });
  writeJson(path.join(projectDirectory, "analytics", "short_form_analytics.json"), { imported_at: null, platforms: {} });
  writeText(path.join(projectDirectory, "analytics", "lessons_learned.md"), "# Lessons Learned\n\n");
}

function createProject(options) {
  const projectsRoot = path.resolve(options.outDir || "projects");
  const brief = buildBrief(options.prompt, {
    topic: options.topic,
    language: options.language,
    tone: options.tone,
    targetDurationSeconds: options.targetDurationSeconds,
    primaryPlatform: options.primaryPlatform,
    targetPlatforms: options.targetPlatforms
  });

  const nowDate = options.now || new Date();
  const now = nowDate.toISOString();
  const projectId = options.projectId || createProjectId(projectsRoot, nowDate);
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectId)) {
    throw Object.assign(new Error('Invalid project ID.'), {status:400});
  }
  const slug = slugify(options.slug || brief.topic);
  const projectDirectory = path.join(projectsRoot, `${projectId}-${slug}`);

  if (fs.existsSync(projectDirectory)) {
    throw new Error(`Project already exists: ${projectDirectory}`);
  }

  ensureDirectory(projectDirectory);
  for (const relativeDirectory of DIRECTORY_STRUCTURE) {
    ensureDirectory(path.join(projectDirectory, relativeDirectory));
  }

  const providers = {
    llmProvider: options.llmProvider || "openai",
    llmModel: options.llmModel || "configurable-default",
    sceneProvider: options.sceneProvider || "leonardo",
    sequenceProvider: options.sequenceProvider || "mootion",
    voiceProvider: options.voiceProvider || "elevenlabs",
    voiceId: options.voiceId || "default_creator_voice"
  };

  const project = createProjectJson({ brief, projectId, slug, providers, now });
  writeJson(path.join(projectDirectory, "project.json"), project);
  createStarterFiles(projectDirectory, project, brief);

  return {
    project,
    projectDirectory,
    createdFiles: [
      "project.json",
      ...Object.values(project.paths).filter((item) => !item.endsWith(".mp4") && !item.endsWith(".jpg"))
    ],
    createdDirectories: DIRECTORY_STRUCTURE
  };
}

module.exports = {
  createWorkflowState,
  migrateProject,
  createProject,
  createProjectId,
  parsePlatformList
};

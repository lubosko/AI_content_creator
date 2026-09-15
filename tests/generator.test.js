"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createProject } = require("../src/lib/projectGenerator");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function testCreatesProjectStructure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-agent-"));
  const result = createProject({
    outDir: path.join(root, "projects"),
    now: new Date("2026-09-09T10:00:00Z"),
    prompt: "Create an 8-minute YouTube video about humanoid robots in factories for technology enthusiasts. Adapt it into Shorts, TikTok, Instagram, and Facebook versions."
  });

  assert.equal(path.basename(result.projectDirectory), "2026-001-humanoid-robots-in-factories");
  assert.ok(fs.existsSync(path.join(result.projectDirectory, "project.json")));
  assert.ok(fs.existsSync(path.join(result.projectDirectory, "source", "video")));
  assert.ok(fs.existsSync(path.join(result.projectDirectory, "adaptations", "tiktok")));
  assert.ok(fs.existsSync(path.join(result.projectDirectory, "generated", "audio", "narration_plan.json")));

  const project = readJson(path.join(result.projectDirectory, "project.json"));
  assert.equal(project.project_id, "2026-001");
  assert.equal(project.status, "created");
  assert.equal(project.topic, "Humanoid Robots In Factories");
  assert.equal(project.target_duration_seconds, 480);
  assert.deepEqual(project.target_platforms, ["youtube", "youtube_shorts", "tiktok", "instagram", "facebook"]);
  assert.equal(project.video_generation_providers.scene_asset_provider, "leonardo");
  assert.equal(project.video_generation_providers.sequence_provider, "mootion");
  assert.equal(project.voice_provider.name, "elevenlabs");

  const brief = readJson(path.join(result.projectDirectory, "prompt", "refined_brief.json"));
  assert.equal(brief.audience, "technology enthusiasts");
}

function testCreatesNextProjectId() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-agent-"));
  const outDir = path.join(root, "projects");

  createProject({
    outDir,
    now: new Date("2026-09-09T10:00:00Z"),
    prompt: "Create a video about factory automation."
  });

  const result = createProject({
    outDir,
    now: new Date("2026-09-09T10:00:00Z"),
    prompt: "Create a video about warehouse robots."
  });

  assert.equal(result.project.project_id, "2026-002");
}

function testOverrides() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-agent-"));
  const result = createProject({
    outDir: path.join(root, "projects"),
    projectId: "custom-001",
    slug: "custom-slug",
    topic: "Custom Topic",
    language: "de",
    targetDurationSeconds: 300,
    primaryPlatform: "tiktok",
    targetPlatforms: ["tiktok", "instagram"],
    llmProvider: "anthropic",
    llmModel: "claude-configured",
    sceneProvider: "manual",
    sequenceProvider: "none",
    voiceProvider: "openai_audio",
    voiceId: "voice-1",
    prompt: "Create a short video."
  });

  assert.equal(path.basename(result.projectDirectory), "custom-001-custom-slug");
  assert.equal(result.project.topic, "Custom Topic");
  assert.equal(result.project.language, "de");
  assert.equal(result.project.target_duration_seconds, 300);
  assert.equal(result.project.primary_platform, "tiktok");
  assert.deepEqual(result.project.target_platforms, ["tiktok", "instagram"]);
  assert.deepEqual(result.project.llm_provider, { name: "anthropic", model: "claude-configured" });
  assert.equal(result.project.voice_provider.voice_id, "voice-1");
}

testCreatesProjectStructure();
testCreatesNextProjectId();
testOverrides();

console.log("All generator tests passed.");


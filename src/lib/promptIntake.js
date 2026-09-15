"use strict";

const PREFERRED_PLATFORM_ORDER = ["youtube", "youtube_shorts", "tiktok", "instagram", "facebook"];

const PLATFORM_ALIASES = new Map([
  ["youtube shorts", "youtube_shorts"],
  ["shorts", "youtube_shorts"],
  ["youtube", "youtube"],
  ["tik tok", "tiktok"],
  ["tiktok", "tiktok"],
  ["instagram reels", "instagram"],
  ["reels", "instagram"],
  ["instagram", "instagram"],
  ["facebook", "facebook"]
]);

function slugify(value) {
  return String(value || "content-project")
    .toLowerCase()
    .replace(/[\'\"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "content-project";
}

function titleCase(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferDurationSeconds(prompt) {
  const text = String(prompt || "").toLowerCase();
  const minuteMatch = text.match(/(?:(\d+(?:\.\d+)?)\s*-\s*minute)|(?:(\d+(?:\.\d+)?)\s*minutes?)|(?:(\d+(?:\.\d+)?)\s*min\b)/);
  if (minuteMatch) {
    const value = Number(minuteMatch[1] || minuteMatch[2] || minuteMatch[3]);
    if (Number.isFinite(value) && value > 0) return Math.round(value * 60);
  }

  const secondMatch = text.match(/(?:(\d+(?:\.\d+)?)\s*seconds?)|(?:\b(\d+(?:\.\d+)?)\s*sec\b)/);
  if (secondMatch) {
    const value = Number(secondMatch[1] || secondMatch[2]);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }

  return 480;
}

function inferPlatforms(prompt) {
  const text = String(prompt || "").toLowerCase();
  const platforms = [];

  for (const [alias, platform] of PLATFORM_ALIASES.entries()) {
    if (text.includes(alias) && !platforms.includes(platform)) {
      platforms.push(platform);
    }
  }

  if (!platforms.includes("youtube")) platforms.unshift("youtube");
  return PREFERRED_PLATFORM_ORDER.filter((platform) => platforms.includes(platform));
}

function inferAudience(prompt) {
  const match = String(prompt || "").match(/\bfor\s+([^.;,]+?)(?:\s+who\b|[.;,]|$)/i);
  return match ? match[1].trim() : "general audience";
}

function inferTopic(prompt) {
  const text = String(prompt || "").trim();
  const aboutMatch = text.match(/\babout\s+(.+?)(?:\s+for\b|[.;]|$)/i);
  if (aboutMatch) return titleCase(aboutMatch[1]);

  const videoMatch = text.match(/\bvideo\s+(.+?)(?:\s+for\b|[.;]|$)/i);
  if (videoMatch) return titleCase(videoMatch[1]);

  return titleCase(text.split(/[.;]/)[0]).slice(0, 120) || "Untitled Content Project";
}

function buildBrief(prompt, overrides = {}) {
  const targetPlatforms = overrides.targetPlatforms && overrides.targetPlatforms.length
    ? overrides.targetPlatforms
    : inferPlatforms(prompt);

  return {
    original_prompt: String(prompt || "").trim(),
    topic: overrides.topic || inferTopic(prompt),
    audience: overrides.audience || inferAudience(prompt),
    target_duration_seconds: overrides.targetDurationSeconds || inferDurationSeconds(prompt),
    language: overrides.language || "en",
    tone: overrides.tone || "clear, cinematic, practical",
    primary_platform: overrides.primaryPlatform || "youtube",
    target_platforms: targetPlatforms,
    constraints: overrides.constraints || [],
    own_material_preference: /own|existing|my\s+.+footage|reuse/i.test(prompt)
      ? "prefer_own_material_where_useful"
      : "optional"
  };
}

module.exports = {
  buildBrief,
  inferAudience,
  inferDurationSeconds,
  inferPlatforms,
  inferTopic,
  slugify
};

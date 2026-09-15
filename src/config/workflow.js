"use strict";

const WORKFLOW_STATUSES = [
  "created",
  "brief_ready",
  "research_in_progress",
  "research_ready",
  "strategy_in_progress",
  "strategy_ready",
  "script_in_progress",
  "script_ready",
  "storyboard_in_progress",
  "storyboard_ready",
  "asset_generation_in_progress",
  "assets_ready",
  "narration_in_progress",
  "narration_ready",
  "composition_in_progress",
  "master_rendered",
  "qc_in_progress",
  "qc_failed",
  "qc_passed",
  "human_review_required",
  "approved_for_publishing",
  "publishing_in_progress",
  "published",
  "analytics_pending",
  "analytics_collected",
  "complete",
  "archived"
];

const APPROVAL_STATES = [
  "not_ready",
  "pending",
  "changes_requested",
  "approved",
  "rejected",
  "skipped"
];

const APPROVAL_GATES = [
  "strategy",
  "script",
  "storyboard",
  "voice",
  "visual_assets",
  "master_video",
  "platform_adaptations",
  "metadata",
  "publishing"
];

const DIRECTORY_STRUCTURE = [
  "prompt",
  "research",
  "strategy",
  "script",
  "storyboard",
  "source/video",
  "source/images",
  "source/audio",
  "source/documents",
  "source/notes",
  "analyzed/transcripts",
  "generated/images",
  "generated/video",
  "generated/audio",
  "generated/thumbnails",
  "compose",
  "qc",
  "final",
  "adaptations/youtube_shorts",
  "adaptations/tiktok",
  "adaptations/instagram",
  "adaptations/facebook",
  "publishing",
  "analytics"
];

module.exports = {
  APPROVAL_GATES,
  APPROVAL_STATES,
  DIRECTORY_STRUCTURE,
  WORKFLOW_STATUSES
};

# AI Social Content Agent Creation Plan

> Update, 2026-09-09: [Agreed Product Workflow](AGREED_WORKFLOW.md) defines the approved stage order, review gates, asset library, and next implementation milestones. Read it before implementing further UI changes.

## 1. Purpose

The AI Social Content Agent is a production workflow for creating long-form YouTube videos and adapting them into short-form versions for YouTube Shorts, TikTok, Instagram, and Facebook.

The first version should start from a simple user prompt, research the topic, generate a content strategy, write a script, plan the video scene by scene, generate or reuse assets, compose the video, run quality checks, request human approval, publish, and learn from analytics feedback.

The system should be provider-agnostic. OpenAI/ChatGPT, Anthropic/Claude, Leonardo AI, Mootion, voice providers, publishing APIs, and analytics APIs should be replaceable through adapters instead of being hard-coded into the workflow.

## 2. Agreed High-Level Architecture

```text
USER PROMPT
  ↓
Project Manager Agent
  ↓
Research Agent
  ↓
Selectable LLM Provider Adapter
  • OpenAI / ChatGPT
  • Anthropic / Claude
  • other future LLM providers
  ↓
Content Strategy Agent
  ↓
Script Agent
  ↓
AI Director / Storyboard Agent
  ↓
Own Content Library + Material Analyzer
  • existing videos
  • images
  • audio
  • voice recordings
  • documents
  • PDFs
  • URLs
  • notes
  • logos
  • brand material
  ↓
Generation Provider Adapters
  • Leonardo AI adapter
  • Mootion adapter
  • future image/video providers
  ↓
Narration / Voice Provider Adapter
  ↓
Asset Manager
  ↓
Python / FFmpeg Video Composer
  ↓
Quality Control
  ↓
Master YouTube Video
  ↓
Platform Adaptation
  • YouTube Shorts
  • TikTok
  • Instagram Reels
  • Facebook
  ↓
Metadata Generator
  ↓
Human Approval
  ↓
Publishing
  ↓
Analytics Feedback
  ↓
Future strategy improvements
```

## 3. Main System Modules

### 3.1 Project Manager Agent

Creates and manages each content project. It owns the project folder, `project.json`, status tracking, provider settings, approvals, output files, and progress history.

Responsibilities:

- Create a unique project ID.
- Store the original prompt and target platforms.
- Track the current workflow state.
- Coordinate all downstream agents.
- Save every generated artifact.
- Maintain approval history.

### 3.2 Research Agent

Turns the simple prompt into structured topic research.

Responsibilities:

- Expand the user prompt into research questions.
- Collect facts, arguments, examples, trends, counterpoints, and source references.
- Use a selectable LLM provider such as OpenAI/ChatGPT, Anthropic/Claude, or another configured model.
- Save research notes in a structured format.
- Separate verified information from speculative ideas.

### 3.3 Selectable LLM Provider Adapter

The agent should not call one LLM directly from the core workflow. Instead, it should use an abstraction layer.

Example providers:

- OpenAI / ChatGPT
- Anthropic / Claude
- Google Gemini
- local models
- future specialized research or writing models

Core interface idea:

```text
LLMProvider.generate(prompt, options)
LLMProvider.summarize(input, options)
LLMProvider.structure(input, schema)
LLMProvider.review(input, criteria)
```

This keeps the system flexible and avoids vendor lock-in.

### 3.4 Content Strategy Agent

Converts research into a concrete video strategy.

Responsibilities:

- Define target audience.
- Choose angle and story promise.
- Decide video format.
- Create hook options.
- Define pacing and emotional arc.
- Suggest retention moments.
- Select long-form and short-form opportunities.

### 3.5 Script Agent

Writes the full script for the master video.

Responsibilities:

- Produce narration script.
- Split the script into sections and beats.
- Include visual notes.
- Include timing estimates.
- Mark sections that can become short clips.
- Create alternate hooks and endings when useful.

### 3.6 AI Director / Storyboard Agent

Turns the script into a shot-by-shot creative plan.

Responsibilities:

- Break the video into scenes.
- Define visual style.
- Decide where to use generated video, generated images, stock-like visual assets, own material, screenshots, charts, captions, and transitions.
- Create prompts for Leonardo AI or Mootion.
- Define camera movement, mood, composition, and scene timing.
- Create a storyboard that the composer can execute.

### 3.7 Own Content Library and Material Analyzer

Own material should be a first-class input, not an afterthought. It can enter the workflow before research, before scripting, during storyboard planning, or during final composition.

Supported material:

- Videos
- Photos
- Audio
- Voice recordings
- Documents
- PDFs
- URLs
- Notes
- Previous videos
- Logos
- Fonts
- Brand guides
- Music
- Intros and outros

Material categories:

```text
Own Material
  ↓
Material Analyzer
  ↓
Knowledge Asset
  • facts
  • transcriptions
  • notes
  • documents
  • previous content

Media Asset
  • video footage
  • photos
  • B-roll
  • screenshots
  • audio recordings

Brand Asset
  • logo
  • colors
  • fonts
  • intro
  • outro
  • music
```

The material analyzer should extract metadata, transcribe speech, identify useful scenes, detect quality issues, and make assets searchable.

### 3.8 Leonardo AI Provider Adapter

Leonardo AI should be treated primarily as a scene and asset generation engine.

Best use cases:

- Individual visual scenes
- Image generation
- Image-to-video animation
- B-roll style clips
- Cinematic establishing shots
- Concept art
- Transitions
- Supporting visuals

Leonardo should not own the whole content strategy. The agent should decide what it needs, then ask Leonardo to generate specific assets or clips.

### 3.9 Mootion Provider Adapter

Mootion can be used as a higher-level story or sequence generation engine.

Best use cases:

- Scene-by-scene generation
- Storyboard-driven video sequences
- Faster end-to-end draft generation
- Audio/image/text-based video generation
- Prototype video sequences before deeper custom composition

Mootion may overlap with parts of the agent workflow, but that is acceptable. In V1, it can accelerate production. Later, the system can replace or bypass Mootion for sections where more control is needed.

### 3.10 Provider Adapter Principle

Leonardo AI and Mootion should both sit behind replaceable adapters.

```text
Storyboard Scene
  ↓
VideoGenerationProvider
  ↓
LeonardoAdapter | MootionAdapter | FutureProviderAdapter
  ↓
Generated asset metadata + local file
```

The core system should only know that it requested an image, clip, scene, or sequence. It should not depend on provider-specific implementation details.

### 3.11 Narration / Voice Provider

Narration should be handled by a dedicated voice provider adapter rather than being mixed into the video generation provider.

Possible providers:

- ElevenLabs
- OpenAI audio
- PlayHT
- Azure Speech
- local voice models

Responsibilities:

- Generate narration from the approved script.
- Support voice selection.
- Support language and accent settings.
- Return audio files with timing metadata.
- Allow replacement later without changing the full workflow.

### 3.12 Asset Manager

The asset manager stores, indexes, validates, and retrieves all project assets.

Responsibilities:

- Save generated images, clips, audio, captions, thumbnails, and intermediate renders.
- Track source, license, prompt, provider, creation time, status, and usage rights.
- Prevent duplicate generation where possible.
- Provide assets to the video composer.
- Keep own material separate from generated material while allowing both to be used together.

### 3.13 Python / FFmpeg Video Composer

The composer assembles the final video from approved assets.

Responsibilities:

- Combine video clips, generated scenes, still images, captions, music, voiceover, transitions, and overlays.
- Use Python for orchestration and FFmpeg for reliable rendering.
- Export the master YouTube video.
- Export platform-specific versions.
- Save render logs and technical metadata.

### 3.14 Quality Control

QC should run before human approval.

Checks:

- Missing assets
- Broken files
- Audio/video sync
- Incorrect duration
- Black frames or blank sections
- Caption timing
- Aspect ratio issues
- Resolution issues
- Loudness issues
- Script coverage
- Brand consistency
- Basic factual consistency
- Platform requirement compliance

### 3.15 Publishing and Analytics

Publishing should only happen after human approval.

Responsibilities:

- Generate metadata.
- Prepare titles, descriptions, tags, chapters, thumbnails, and short-form captions.
- Publish to selected platforms through adapters.
- Store published URLs and platform IDs.
- Pull analytics later.
- Feed performance data back into future strategy.

## 4. Project Directory Structure

Suggested structure:

```text
projects/
  2026-001-humanoid-robots/
    project.json

    prompt/
      original_prompt.md
      refined_brief.json

    research/
      research_notes.md
      sources.json
      fact_check.json

    strategy/
      content_strategy.md
      audience.json
      retention_plan.json

    script/
      script.md
      script.json
      hooks.md
      shorts_candidates.json

    storyboard/
      storyboard.md
      storyboard.json
      scene_prompts.json

    source/
      video/
      images/
      audio/
      documents/
      urls.json
      notes/

    analyzed/
      transcripts/
      asset_index.json
      material_analysis.json

    generated/
      images/
      video/
      audio/
      thumbnails/

    compose/
      timeline.json
      captions.srt
      render_config.json

    qc/
      qc_report.json
      qc_report.md

    final/
      youtube_master.mp4
      youtube_thumbnail.jpg
      youtube_metadata.json

    adaptations/
      youtube_shorts/
      tiktok/
      instagram/
      facebook/

    publishing/
      approval_log.json
      publish_jobs.json
      published_urls.json

    analytics/
      youtube_analytics.json
      short_form_analytics.json
      lessons_learned.md
```

## 5. `project.json` Concept

`project.json` is the central state file for one video project.

Example:

```json
{
  "project_id": "2026-001",
  "slug": "humanoid-robots-manufacturing",
  "created_at": "2026-09-08T10:00:00Z",
  "updated_at": "2026-09-08T10:30:00Z",
  "status": "storyboard_in_progress",
  "approval_state": "not_ready",
  "topic": "Humanoid robots in manufacturing",
  "language": "en",
  "primary_platform": "youtube",
  "target_platforms": [
    "youtube",
    "youtube_shorts",
    "tiktok",
    "instagram",
    "facebook"
  ],
  "target_duration_seconds": 480,
  "llm_provider": {
    "name": "openai",
    "model": "gpt-5.1"
  },
  "video_generation_providers": {
    "scene_asset_provider": "leonardo",
    "sequence_provider": "mootion"
  },
  "voice_provider": {
    "name": "elevenlabs",
    "voice_id": "default_creator_voice"
  },
  "paths": {
    "research": "research/research_notes.md",
    "strategy": "strategy/content_strategy.md",
    "script": "script/script.md",
    "storyboard": "storyboard/storyboard.json",
    "timeline": "compose/timeline.json",
    "qc_report": "qc/qc_report.md",
    "youtube_master": "final/youtube_master.mp4"
  },
  "approvals": {
    "strategy": "approved",
    "script": "approved",
    "storyboard": "pending",
    "final_video": "not_ready",
    "publishing": "not_ready"
  }
}
```

## 6. Asset Metadata Example

Each own, generated, and final asset should have metadata.

Example:

```json
{
  "asset_id": "asset_00042",
  "project_id": "2026-001",
  "type": "video_clip",
  "origin": "generated",
  "provider": "leonardo",
  "path": "generated/video/scene_006_robot_arm_factory.mp4",
  "created_at": "2026-09-08T11:15:00Z",
  "duration_seconds": 6.2,
  "resolution": {
    "width": 1920,
    "height": 1080
  },
  "aspect_ratio": "16:9",
  "prompt": "Cinematic shot of a humanoid robot assisting with assembly in a modern factory, realistic lighting, smooth camera movement",
  "negative_prompt": "distorted hands, unreadable text, flickering, low quality",
  "source_material_ids": [
    "source_00013"
  ],
  "usage": [
    {
      "timeline_id": "youtube_master",
      "scene_id": "scene_006",
      "start_seconds": 118.0,
      "end_seconds": 124.2
    }
  ],
  "license_status": "allowed_for_project",
  "qc_status": "passed",
  "notes": "Generated as supporting B-roll for manufacturing section."
}
```

## 7. Status and Approval States

### 7.1 Workflow Status

Suggested project status values:

```text
created
brief_ready
research_in_progress
research_ready
strategy_in_progress
strategy_ready
script_in_progress
script_ready
storyboard_in_progress
storyboard_ready
asset_generation_in_progress
assets_ready
narration_in_progress
narration_ready
composition_in_progress
master_rendered
qc_in_progress
qc_failed
qc_passed
human_review_required
approved_for_publishing
publishing_in_progress
published
analytics_pending
analytics_collected
complete
archived
```

### 7.2 Approval States

Suggested approval values:

```text
not_ready
pending
changes_requested
approved
rejected
skipped
```

Suggested approval gates:

- Strategy approval
- Script approval
- Storyboard approval
- Voice approval
- Visual asset approval
- Master video approval
- Platform adaptation approval
- Metadata approval
- Publishing approval

## 8. V1 Scope

V1 should be practical and narrow enough to build.

Included in V1:

- Simple prompt input.
- Project folder creation.
- `project.json` state tracking.
- One selectable LLM provider, with adapter structure ready for more providers.
- Research generation.
- Content strategy generation.
- Script generation.
- Storyboard generation.
- Basic own material ingestion.
- Basic material metadata extraction.
- Leonardo AI adapter for scene or asset generation.
- Mootion adapter for higher-level sequence generation.
- One dedicated voice provider adapter.
- Asset manager.
- Python/FFmpeg composition pipeline.
- YouTube master video export.
- Platform adaptation exports for vertical short-form formats.
- Metadata generation.
- Manual human approval gates.
- Manual or semi-automated publishing preparation.
- Basic analytics import structure.

Not required in V1:

- Fully autonomous publishing without approval.
- Advanced brand memory.
- Complex multi-user collaboration.
- Full rights management automation.
- Automatic A/B testing.
- Real-time dashboard.
- Perfect analytics-driven optimization.
- Every possible video provider.

## 9. 15-Step Development Order

### Step 1: Define the Project Schema

Create the first version of `project.json`, status values, approval states, provider configuration, path conventions, and artifact references.

### Step 2: Create the Project Directory Generator

Build a tool that creates the full project folder structure from a topic, project ID, language, and target platforms.

### Step 3: Build the Simple Prompt Intake

Accept a basic prompt such as:

```text
Create an 8-minute YouTube video about humanoid robots in factories for technology enthusiasts.
```

Convert it into a structured brief with topic, audience, duration, tone, platform, language, and constraints.

### Step 4: Add the LLM Provider Adapter Layer

Create a provider interface for research, strategy, script, storyboard, metadata, and review tasks. Start with one provider, but design the interface so OpenAI/ChatGPT, Anthropic/Claude, and future models can be swapped.

### Step 5: Build the Research Agent

Generate structured research notes, source lists, fact candidates, and warnings about uncertain claims.

### Step 6: Build the Content Strategy Agent

Generate the audience profile, angle, video promise, structure, pacing, hook ideas, retention moments, and short-form opportunities.

### Step 7: Build the Script Agent

Generate the narration script, section timings, visual notes, and candidate short clips.

### Step 8: Build the Own Content Library

Create ingestion folders and asset records for user-provided videos, images, audio, documents, URLs, notes, logos, music, and previous videos.

### Step 9: Build the Material Analyzer

Extract metadata from own material. For V1, focus on filename, type, duration, dimensions, transcript where available, notes, and tags.

### Step 10: Build the AI Director / Storyboard Agent

Turn the script and available own material into a structured scene plan. Each scene should specify duration, narration segment, visual intent, preferred source material, fallback generation provider, and generation prompt.

### Step 11: Build Leonardo AI and Mootion Provider Adapters

Implement separate adapters:

- Leonardo AI for scene assets, images, B-roll clips, image-to-video clips, and supporting visuals.
- Mootion for higher-level story or sequence generation.

Both adapters should return standardized asset metadata, regardless of provider-specific response format.

### Step 12: Build the Narration / Voice Provider Adapter

Generate narration audio from approved script sections. Store audio files and timing metadata separately from video assets.

### Step 13: Build the Asset Manager

Index all own and generated material. Track file paths, providers, prompts, licenses, dimensions, durations, QC status, and scene usage.

### Step 14: Build the Python / FFmpeg Composer and QC

Create a timeline format, assemble the master YouTube video, render captions, mix audio, and produce a QC report. QC should block final approval when required assets are missing or render quality fails basic checks.

### Step 15: Build Platform Adaptation, Metadata, Approval, Publishing, and Analytics Feedback

Export platform-specific versions for YouTube Shorts, TikTok, Instagram, and Facebook. Generate metadata for each platform, request human approval, prepare publishing jobs, store published URLs, import analytics later, and write lessons learned back into the project.

## 10. Recommended V1 Workflow

```text
1. User enters simple prompt.
2. System creates project folder and project.json.
3. Research Agent creates research notes.
4. Content Strategy Agent creates the strategy.
5. Human approves or edits strategy.
6. Script Agent writes the script.
7. Human approves or edits script.
8. Own Content Library is scanned.
9. Material Analyzer indexes usable source material.
10. AI Director creates storyboard.
11. Human approves or edits storyboard.
12. Leonardo AI and/or Mootion generate needed visuals.
13. Voice provider generates narration.
14. Asset Manager indexes everything.
15. Python/FFmpeg composer renders YouTube master.
16. QC checks the video.
17. Human approves final video.
18. System creates short-form adaptations.
19. Metadata is generated.
20. Human approves publishing package.
21. Content is published.
22. Analytics are collected.
23. Lessons feed into future content strategy.
```

## 11. Key Design Decision

The most important design decision is to keep the agent workflow separate from provider implementations.

The core agent should own:

- Project state
- Strategy
- Script
- Storyboard
- Asset selection
- Timeline
- QC
- Approval
- Publishing logic
- Analytics feedback

External providers should only be used through adapters:

- LLM provider adapter
- Leonardo AI adapter
- Mootion adapter
- Voice provider adapter
- Publishing adapter
- Analytics adapter

This makes the system easier to test, easier to improve, and easier to migrate when a better provider becomes available.

## 12. Practical First Milestone

The first useful milestone is not a fully automated publishing machine. The first useful milestone is a local project generator that can produce:

- `project.json`
- research notes
- content strategy
- script
- storyboard
- asset list
- narration plan
- FFmpeg timeline plan
- metadata draft

After that works reliably, provider integrations and video rendering can be added one by one.

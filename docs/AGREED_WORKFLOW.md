# Agreed Product Workflow

Agreed on 2026-09-09. This document governs the next implementation phase and supersedes the stage order and first milestone in the original creation plan. It describes planned behavior, not completed features.

## Decisions

- Start with a simple prompt, then stop to clarify and approve the brief.
- Add own material before research. Continuing without material is an explicit choice.
- Use a reusable personal asset library with project-specific selections.
- Initially require review and approval at each creative stage.
- Save inputs, outputs, revisions, decisions, and current stage so projects can resume.
- First implementation milestone: real importing, library management, and project selection, supported by brief confirmation and persistent workflow state.
- Proposed import coverage: videos, photos, audio, documents/PDFs, URLs, notes, and brand files. Build file storage and text/URL entry first; extraction and analysis can follow by format. Import success must never imply analysis success.

## User journey and approval gates

| Stage | Visible result | Gate before continuing |
|---|---|---|
| 1. Simple prompt | Saved project idea | Continue to clarification |
| 2. Clarify theme | Editable brief: topic, angle, audience, purpose, language, duration, platforms, tone | Confirm brief |
| 3. Own material | Imported files, URLs, notes, analysis status, knowledge/media/brand categories, project selections | Confirm material selection or continue without material |
| 4. Research | Findings, references, links to own material, uncertain claims, unanswered questions | Approve research or request changes |
| 5. Content strategy | Story promise, angle, structure, retention plan, intended material usage | Approve strategy or request changes |
| 6. Script | Narration, visual notes, timing, source references, short-form opportunities | Approve script or request changes |
| 7. Storyboard / Director | Scene plan, narration references, selected own assets, missing asset list, generation prompts | Approve storyboard or request changes |
| 8. Asset production | Generated missing visuals and narration, selected own media, applied brand choices | Review and approve assets |
| 9. Composer | Playable master preview, captions, audio mix, platform versions, composition report | Continue to final check after successful composition |
| 10. Final check | Video preview and checks for factual accuracy, visuals, sound, captions, branding, export settings | Approve final video and export |

Publishing and analytics remain later extensions. Final video approval does not automatically authorize publishing.

## Own material flow

Own files, URLs, and notes feed the Material Analyzer. An item may serve multiple roles:

- Knowledge: transcripts, facts, documentation, notes, previous content → research and script.
- Media: video clips, photos, recordings, screenshots, B-roll → storyboard and composer.
- Brand: logos, intro/outro, music, fonts and style → director and composer.

Storyboard selects useful own material and specifies missing assets. Asset production fills those gaps. Composer combines approved own and generated assets into the video.

## UI contract

- Project picker supports creating, opening, and resuming any project.
- Stage navigation shows current stage, saved result, approval state, and prerequisites.
- Each stage has visible inputs, an editable or reviewable result, and a clear next action.
- Clarification asks only for missing details and presents a brief for confirmation; it must not silently approve inferred answers.
- Material stage offers Import files, Add URL, Write note, and Choose from library.
- Material cards show actual filename/title, type, category, preview when supported, analysis state, and project selection.
- Use / Maybe / Skip decisions belong to the project and persist across reloads. Removing a project selection does not remove the library original.
- Clearly distinguish imported, awaiting analysis, analyzed, failed, and unsupported items. Provide retry for failures.
- Generation shows progress, errors, and saved results. Retry preserves the previous result until a replacement succeeds.
- Show draft and unverified content honestly; no fake assets, completed stages, approval badges, or playable-video claims.
- Separate strategy generation from script generation.

## State and persistence

Keep projectGenerator.js as the source of truth for project scaffolding and schema migration. Use Node built-ins for the server and provider adapters for external services.

Proposed records:

- Library asset: stable ID, original name, managed storage location or URL, type, categories, metadata, analysis state and outputs.
- Project asset selection: asset ID, selected revision, Use/Maybe/Skip decision, intended use, project notes.
- Stage record: state, input revisions, output revision, saved artifact references, last error.
- Approval record: stage, exact output revision, decision, timestamp, feedback.

Stage states: locked, ready, running, needs_review, approved, failed, needs_update. File import and analysis have their own states.

Server checks prerequisites and approval revisions; disabling buttons alone is insufficient. Returning to an earlier stage is allowed. Editing approved inputs marks affected downstream stages as needs_update and blocks further progression until reviewed. Preserve old artifacts for comparison. Serialize generation per project to avoid overlapping writes.

Copy imported files into managed library storage so moving the source file does not break projects. Preserve originals. Validate supported file types and size limits, prevent path traversal, and report per-file import failures. URLs are saved as references; successful extraction is a separate result.

## Implementation sequence

### Milestone 1 — Brief, real material, and resume

1. Add persistent stage and approval records with compatibility for existing projects.
2. Add project picker and simple prompt → clarification → confirmed brief flow.
3. Implement actual file import, note and URL storage, reusable library listing, and project selections.
4. Build material cards and supported previews; expose analysis limitations explicitly.
5. Persist selection confirmation or the choice to continue without material.

Acceptance: create a project, confirm its brief, import an actual file and add a note/URL, select reusable assets, reload, reopen the project, and see the same material and decisions. Import errors are visible. No placeholder files are created by the UI. Research requires brief and material confirmation.

### Milestone 2 — Material analysis and grounded research

Add extraction/transcription adapters by format, editable categorization, source references, and a research provider. Feed confirmed knowledge selections into research. Show evidence and uncertainty. Persist research review and approval.

Acceptance: selected material is traceable in research; unsupported analysis is visible; source-backed findings are distinguishable from drafts and assumptions.

### Milestone 3 — Strategy, script, and storyboard

Implement separate stages with saved review revisions, approval gates, and material references. Storyboard identifies selected own media and missing assets.

Acceptance: each approved stage feeds the next; upstream changes invalidate dependent approvals; a scene can be traced to its narration and assets.

### Milestone 4 — Asset production and composition

Connect visual and narration adapters, review generated assets, and implement the composer with real media. Save render jobs, previews, and failures.

Acceptance: a project produces a playable video from actual assets. A timeline plan is never presented as a finished video.

### Milestone 5 — Final review and exports

Add final checks, approval of a specific video revision, downloads, and platform adaptations. Keep publishing separate.

Acceptance: users can preview, request changes, approve, and export a known revision; blocking checks prevent a misleading ready state.

## Verification approach

Use isolated test projects and library storage. Verify import persistence, project-specific selections, missing/unsupported files, approval prerequisites, stale revisions, resume behavior, and a complete browser journey. Keep existing generator and server tests passing. Never regenerate a user's saved project merely to test the UI.

# Milestone 1: Brief and Own Material

> Historical record. This milestone describes the first working slice and its limits at the time.
> For what the app does now, read [the completion strategy](PROJECT_COMPLETION_STRATEGY.md), whose
> status table and completion record are the current state.

> Update, 2026-09-10: [Claude Research](CLAUDE_RESEARCH.md) adds an API connection, web citations, and optional selected text material input. It supersedes the research-related limitations below.

> Update, 2026-09-10: [Material Analysis](MATERIAL_ANALYSIS.md) supersedes the analysis limitations
> below. Text files, notes, URLs, images and media are now analyzed, and analyzed knowledge feeds
> research. Speech transcription and PDF extraction are implemented in Phase 2, so the note below
> claiming they are unimplemented is out of date.

> Update, 2026-09-10: [Rights and Licensing](RIGHTS_AND_LICENSING.md) supersedes step 4 below.
> Confirming a material selection now requires a recorded licence basis for every item marked Use, and
> material with none is refused with 409 rather than confirmed.

Implemented: simple prompt intake, editable brief confirmation, managed imports, reusable library, per-project material choices, and project resume.

## Run

Run npm.cmd run dev in the workspace, then open http://localhost:3000. Restart an older server process after updating the code. Serve the HTML through Node; opening it directly from the filesystem cannot use the API.

1. Enter a simple prompt and press Start Project, or select a saved project and press Open Project.
2. Review the suggested theme, audience, duration, language, tone, and platforms. Fill in the angle and purpose. Confirm the brief.
3. Import files, add a note or URL, or choose from the reusable library. Pick an optional knowledge/media/brand category before import; otherwise the file type supplies a suggestion.
4. Mark each project item Use, Maybe, or Skip. Resolve Maybe choices, record the rights basis for every item marked Use, then confirm the selection. With no Use selections, choose Continue without material explicitly.
5. Generate Research becomes available. Reloading restores the last opened project, saved brief, selections, and approval records.

## Storage and compatibility

Managed originals and metadata live in projects/_library by default; LIBRARY_ROOT overrides that location. PROJECTS_ROOT overrides project storage. Files have generated IDs and retain their original display names. Removing a project selection keeps the library original. Maximum upload size is 100 MB per file; imports report errors individually. Video/audio previews depend on the browser codec support; saved originals remain accessible.

Workflow state is stored in project.json. Brief revisions are preserved in prompt/brief_history. Confirmed edits invalidate material confirmation and mark generated downstream stages as needing review without deleting outputs. Stale browser writes are rejected with a reload message. Existing projects receive unconfirmed intake defaults on read and persist the new schema on their next mutation; existing artifacts are retained.

## Limits and next milestone

Imported does not mean analyzed, but analysis is now implemented for text, notes, URLs, images and
media. Speech transcription and PDF extraction are not: a video contributes metadata and a preview
frame but no text, and it says so. Library selections are consumed by research, which prefers
extracted text over raw file reads. Strategy/script/storyboard/render generators remain legacy
prototypes; separate strategy generation and final video composition are not implemented. Brief and
material prerequisites are enforced on the server.

Next: transcription and PDF extraction, then the research approval gate.

## Verification

npm.cmd test covers existing generators and result APIs plus intake prerequisites, actual imported bytes and ranged reads, upload validation, URL validation, saved selections, server restart, per-project isolation, stale writes, upstream invalidation, missing files, and legacy project loading.

Browser verification used isolated temporary projects: prompt → confirmed brief → written note and real file upload → confirmed material → generated research → reload with the same saved selections. The user's existing project was not regenerated for testing.

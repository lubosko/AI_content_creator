# Astra Handoff Summary: AI Social Content Agent

> Update, 2026-09-09: [Agreed Product Workflow](AGREED_WORKFLOW.md) defines the approved stage order, review gates, asset library, and next implementation milestones. Read it before implementing further UI changes.

> Current implementation: [Milestone 1](MILESTONE_1.md) supersedes the placeholder material and latest-project-only behavior below. Brief/material confirmation and real importing now work; later creative stages remain prototypes.

> Current Settings implementation: [Settings guide](SETTINGS.md). Shared encrypted credentials and defaults are implemented; Claude is connected, other provider entries store credentials only. Remotion is deferred.

> Phase 0, 0.5, 1, 2, 3, 4, 5, 5.5, 5.6, 6, 7 and 8 complete: the pipeline runs from a prompt to a playable master and five platform exports. `npm test` exits 0, FFmpeg is detected, the UI lives in
> `src/ui/`, material analysis and transcription work, and research, strategy, script and storyboard
> are provider-backed with revision-specific approval gates. Asset production synthesizes narration
> and fills storyboard gaps from free-licence sources (Pexels, Archive.org, Openverse). Every piece of
> material needs a recorded licence basis: unrecorded material is refused at material confirmation,
> withheld from the storyboard, and blocked again by the render plan. Only the render plan is still a
> template.
> [`PROJECT_COMPLETION_STRATEGY.md`](PROJECT_COMPLETION_STRATEGY.md) governs the remaining work; see
> also [Creative stages](CREATIVE_STAGES.md), [Asset production](ASSET_PRODUCTION.md),
> [Rights and licensing](RIGHTS_AND_LICENSING.md), [Scene rendering](SCENE_RENDERING.md), [The composer and QC](COMPOSER_AND_QC.md), [Exports](EXPORTS.md) and
> [Material analysis](MATERIAL_ANALYSIS.md).

## Goal

Build a local AI Social Content Agent that starts from a short user prompt, creates a project folder, then moves through research, script, storyboard, and render planning for YouTube plus short-form platform adaptations.

The intended user flow is:

1. User writes a short prompt.
2. App creates a local project under `projects/`.
3. App generates research questions and starter research notes.
4. App generates strategy, hooks, and script.
5. App generates storyboard and scene prompts.
6. App creates a render/timeline/QC plan.
7. Later work will add real provider integrations, media generation, voice generation, FFmpeg rendering, publishing, and analytics.

## Repository

Workspace path:

```text
D:\MyApps\AI_content_agent
```

Important files:

```text
package.json
src/cli.js
src/server.js
src/lib/projectGenerator.js
src/lib/promptIntake.js
src/lib/intakeWorkflow.js
src/lib/materialLibrary.js
src/lib/providerResearch.js
src/lib/projectPaths.js
src/config/workflow.js
src/config/settings.js
src/config/capabilities.js
src/providers/claude.js
src/ui/index.html
src/ui/styles.css
src/ui/app.js
src/ui/stages.js
src/ui/router.js
src/ui/store.js
src/ui/api.js
src/ui/dom.js
src/ui/components.js
src/ui/views/*.js
docs/AI_Social_Content_Agent_Plan.md
docs/PROJECT_COMPLETION_STRATEGY.md
tests/*.test.js
tests/helpers/*.js
tests/run-tests.js
```

> Update, 2026-09-10: [`PROJECT_COMPLETION_STRATEGY.md`](PROJECT_COMPLETION_STRATEGY.md) is now the
> governing plan for finishing the project. The single-file UI prototype referenced below has been
> retired and replaced by the modular UI in `src/ui/`.

## Implemented

### Project Creation

`src/lib/projectGenerator.js` is the source of truth for project creation. It creates:

- `project.json`
- prompt files
- research starter files
- strategy starter files
- script starter files
- storyboard starter files
- source/analyzed/generated/compose/qc/final/publishing/analytics folders and JSON/MD placeholders

CLI still works:

```powershell
npm.cmd run create -- "Create a video about ..."
```

Local UI server works:

```powershell
npm.cmd run dev
```

Default URL:

```text
http://localhost:3000
```

A dev server was also run on:

```text
http://localhost:3001
```

### HTTP API

Implemented in `src/server.js` with Node built-ins only, no Express/Vite.

Routes:

```text
GET  /
GET  /index.html
GET  /api/projects
POST /api/projects
GET  /api/projects/:folder/project.json
POST /api/projects/:folder/research
POST /api/projects/:folder/script
POST /api/projects/:folder/storyboard
POST /api/projects/:folder/render
```

`PROJECTS_ROOT` env var is supported for isolated/empty project tests:

```powershell
$env:PROJECTS_ROOT="C:\temp\empty-projects"; $env:PORT=3001; npm.cmd run dev
```

### UI

The single-file prototype in `docs/AI_Social_Content_Agent_UI_Prototype.html` has been **retired and
deleted**. The interface now lives in `src/ui/` and is served by `src/server.js`:

- `src/ui/index.html` - the shell: stage rail, workspace, inspector drawer.
- `src/ui/styles.css` - dark-first design system (tokens, components, reduced-motion support).
- `src/ui/stages.js` - the client-side stage vocabulary, which must agree with `src/config/workflow.js`.
- `src/ui/router.js` - hash routing; every screen is addressable and reloadable.
- `src/ui/store.js`, `src/ui/api.js`, `src/ui/dom.js`, `src/ui/components.js` - state, API, element builder, components.
- `src/ui/views/*.js` - one module per stage or screen.
- `src/ui/app.js` - boot, routing, rail, inspector, and the render cycle.

Screens: `#/`, `#/settings`, `#/library`, and `#/project/<folder>/<stage>`.

Honesty rules the UI enforces:

- A stage the server cannot run is labelled **planned** and offers no generate button.
- A stage that only produces a local template is labelled **template** and shows a warning banner;
  it is never presented as provider-generated work.
- Imported material is never presented as analyzed.
- A failed generation says the previously saved result is unchanged.
- The composer states that no video is produced yet.

The old prototype's stale demo content is gone and a test prevents it from returning.

### Project paths

Implemented in:

```text
src/lib/projectPaths.js
```

Functions:

```js
resolveProjectDirectory(projectsRoot, folderName)
validateFolderName(folderName)
```

That is all that is left of the module this section used to describe. It held the deterministic
generators for research, script, storyboard and the render plan; those were deleted as each stage
became provider-backed or, in the composer's case, a real FFmpeg render. The file was renamed because
"workflow runner" no longer described it.

Status progression:

```text
created
research_ready
script_ready
storyboard_ready
qc_failed
```

`qc_failed` is expected after render planning because final video rendering is blocked until real media and narration assets exist.

## Current User Project

Project folder:

```text
projects/2026-010-dora-rs-new-operating-system
```

Project state after running the workflow:

```text
project_id: 2026-010
slug: dora-rs-new-operating-system
topic: DORA RS New Operating System
status: qc_failed
approval_state: pending
duration: 180 seconds
language: English
tone: Clear, cinematic, practical
visual provider: manual / none
voice provider: elevenlabs
```

Generated files include:

```text
projects/2026-010-dora-rs-new-operating-system/research/research_notes.md
projects/2026-010-dora-rs-new-operating-system/script/script.md
projects/2026-010-dora-rs-new-operating-system/storyboard/storyboard.json
projects/2026-010-dora-rs-new-operating-system/compose/timeline.json
projects/2026-010-dora-rs-new-operating-system/qc/qc_report.json
```

QC says final render is blocked because there are no generated/imported media assets yet.

## Tests

Test command:

```powershell
npm.cmd test
```

Current expected result (`npm.cmd test` exits 0):

```text
All generator tests passed.
All server tests passed.
All intake and material persistence tests passed.
All Claude provider and research integration tests passed (mock API, no paid calls).
All Settings tests passed: encryption, persistence, redaction, precedence, unreadable-key recovery, connection tests, defaults, and stale writes.
All capability tests passed: detection, missing tools, unrunnable binaries, encoder parsing, and WinGet shims.
All UI foundation tests passed: stage vocabulary, routing, state mapping, and honesty rules.
All UI serving tests passed: shell at root, every module served, traversal blocked.
All UI journey tests passed: create, brief, real import, selection, provider failure and recovery, resume, and honest fallbacks.
```

Tests cover:

- project creation
- duplicate project ID handling
- missing prompt handling
- project listing
- loading `project.json`
- empty project listing
- workflow endpoints
- brief and material confirmation gates, stale writes, upstream invalidation
- real imported bytes, ranged reads, upload validation, per-project isolation
- Claude provider behaviour against a mocked API (no paid calls)
- settings encryption, redaction, precedence, unreadable-key recovery
- FFmpeg capability detection including WinGet installs
- UI stage vocabulary agreement with the server, hash routing, stage state mapping
- UI honesty rules: no `innerHTML`, no inline styles, no stale demo content
- UI serving: every module reachable, path traversal blocked
- a full UI journey driven through the real view code against a real server

## User Confusions Already Addressed

The user expected the app to generate content after writing a short prompt. Initially only project creation existed.

Clarify to the user:

- `Start project` creates the project folder and starter files.
- `Save draft in browser` only saves browser form data. It does not create a project.
- The brief must be confirmed, then material chosen, before research unlocks. The stage rail shows this order and disables stages that are not reachable yet.
- `Generate research` uses Claude. There is no offline fallback: a stage that cannot reach a provider fails visibly.
- Script, storyboard and asset production are all provider-backed or rendered locally, and the rail labels nothing as a template.
- The composer produces `final/youtube_master.mp4` with FFmpeg and inspects it with ffprobe; QC blocks approval on a failed check.
- Narration runs through OpenAI speech, stock footage through Pexels, Archive.org and Openverse, and graphic scenes are drawn locally by six templates. Leonardo and Mootion credentials are stored but have no adapter.

## Recommended Next Engineering Steps

Done since this list was written: the project picker, persisted material with real analysis, the
provider adapter layer, provider-backed research with an approval gate, a modular UI with
browser-driven tests, and FFmpeg detection. See
[the completion strategy](PROJECT_COMPLETION_STRATEGY.md) for current status.

The planned work is finished. What remains is a short list of things that were always outside it:

1. **Publishing.** Nothing uploads to a platform. The exports are files with download links.
2. **Generated-asset review**: approve, reject or regenerate a single produced asset.
3. **A paid generation adapter**, if it is ever wanted. Leonardo and Mootion have no usable API here
   (Mootion is application-only; Leonardo looks paid-plan gated), so graphic scenes are drawn locally
   by six templates and anything else is attached by hand.
4. **Music, sound effects, voice cloning and multi-language narration.**
5. **The `publishing/` and `analytics/` scaffolding** written at project creation is parked: no stage
   reads or writes it.

Credits the rights gate collects are no longer on this list: they now ride through to the master
metadata, every platform description and the exports screen, with the description budget trimmed
around them. See [exports](EXPORTS.md).

## Constraints To Preserve

- Keep `projectGenerator.js` as the source of truth for project folder/schema creation.
- Use plain Node built-ins for the current server unless the user explicitly approves a framework.
- Keep generated projects under `projects/` and ignored by git.
- Do not hard-code provider-specific business logic into the workflow core; use adapters when adding integrations.
- Do not show fake completed/demo content in an empty project UI.

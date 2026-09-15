# Project Completion Strategy

Written 2026-09-10. This is the plan to take the AI Social Content Agent from its current prototype state to a finished end-to-end tool. It is grounded in the actual code, not the older docs. Where this document conflicts with `AI_Social_Content_Agent_Plan.md` or `ASTRA_HANDOFF_SUMMARY.md`, this document wins.

## Status

| Phase | State |
|---|---|
| 0 Baseline | **Done.** `npm test` exits 0; FFmpeg 9.0.1 installed and detected; unreadable credentials degrade instead of failing requests. |
| 0.5 UI foundation | **Done.** Modular UI in `src/ui/`, hash routing, stage rail, design system, inspector, and an end-to-end UI journey test. The old `docs/*UI_Prototype.html` is deleted. |
| 1 Analysis: text and documents | **Done.** Files are classified by content, text is extracted, media is probed with ffprobe, URLs are fetched with SSRF guards, and analysis feeds research. |
| 2 Analysis: transcription and PDFs | **Done.** Speech-to-text via an OpenAI adapter with an explicit cost confirmation for long files; PDF text-layer extraction with no dependency. |
| 3 Strategy and script | **Done.** A shared stage engine, provider-backed strategy and script, an approval API with revision-specific records, and the offline templates retired. |
| 4 Director and storyboard | **Done.** A model-generated storyboard that selects your own analyzed media per scene, verifies every asset id, and lists what still has to be produced. |
| 5 Assets and narration | **Done.** Narration through OpenAI speech with measured durations, stock footage for scenes with no own media, and an asset manifest that records every gap honestly. |
| 5.5 Rights and sourcing | **Done.** Every piece of material needs a recorded licence basis before it can be used; unrecorded material is refused at material confirmation, withheld from the storyboard, counted in the manifest and blocked again by the render plan. Free-licence sourcing widened to Archive.org and Openverse alongside Pexels. See [Rights and Licensing](RIGHTS_AND_LICENSING.md). |
| 5.6 Scene rendering | **Done.** Six local templates draw graphic scenes with headless Chrome and FFmpeg at no cost, with real text; a prompt pack and an attach flow cover the shots that must be generated elsewhere, and every drawn scene is free of third-party rights. See [Scene rendering](SCENE_RENDERING.md). |
| 6 Composer and QC | **Done.** FFmpeg assembles the real master from normalised per-scene segments, narration split across the scenes that share a section, estimated captions, and QC measured against the written file. A failed check blocks approval. See [The composer and QC](COMPOSER_AND_QC.md). |
| 7 Final check and exports | **Done.** A final check with computed and manual items, approval gates tied to a fingerprint of the exact video, five platform exports with burned captions and retimed subtitles, assembled metadata, and downloads. See [Exports](EXPORTS.md). |
| 8 Closeout | **Done.** The deterministic template render plan is deleted, the docs describe only shipped behaviour, and one end-to-end walkthrough is recorded in `tests/walkthrough.test.js`. |

## 1. Definition of Done

The project is finished when this works, reliably, on this machine, without hand-editing files:

```text
simple prompt
  -> clarify -> confirmed brief
  -> own material imported and analyzed
  -> grounded research (Claude, cited) -> approved
  -> strategy -> approved
  -> script -> approved
  -> storyboard -> approved
  -> missing assets generated + narration produced -> approved
  -> composer renders a real playable youtube_master.mp4
  -> final check on a specific revision -> approved
  -> platform exports (Shorts / TikTok / Instagram / Facebook)
  -> metadata package + downloadable exports
```

Publishing to the platforms themselves is explicitly **out of scope** for this completion. So is analytics pull-back. Final approval does not authorize publishing. Those stay as documented later extensions.

### Success criteria

| # | Criterion | How it is proven |
|---|---|---|
| 1 | One real project goes prompt to playable `.mp4` with no manual file edits | Browser walkthrough on an isolated test project |
| 2 | Research, strategy, script, storyboard are provider-generated, not templates | Artifacts contain model output; templates are gone or clearly marked "offline starter" |
| 3 | Own material is traceable into the script and storyboard | A scene names the narration line and the source asset IDs it uses |
| 4 | Rendering is real | `ffprobe` reports the expected duration, resolution, audio and video streams |
| 5 | Full `npm test` exits 0 from a clean checkout | CI-style run |
| 6 | Docs match reality | README, milestone docs, and `CLAUDE_RESEARCH.md` describe only shipped behavior |
| 7 | Every stage is operable in the browser | The full walkthrough is completed without touching files by hand; the stage rail, routing and honest-state rules from section 9 hold |

## 2. Verified Current State

What exists and genuinely works:

- `src/lib/projectGenerator.js` - canonical scaffolding and schema migration. Keep as source of truth.
- Brief intake: prompt to `prompt/refined_brief.json`, brief history, revision checks, server-enforced prerequisites.
- Managed material library (`projects/_library`): real uploads, text notes, URLs, ranged file serving, 100 MB limit, per-project Use/Maybe/Skip selections that survive reload.
- Claude research (`src/providers/claude.js`, `src/lib/providerResearch.js`): real API, web citations, warnings, history backup, write-with-rollback. This is the one real provider integration.
- Settings: six provider entries, DPAPI-encrypted keys, environment fallback, revision checks, redaction, connection test (Claude only).
- Workflow state in `project.json`: stages, revisions, approvals, downstream invalidation.

This section is a Phase 0 snapshot, kept as the record of where the work started. **Everything in the
table below is now implemented**; see the status table above and section 10 for what was built.

What was fake, partial, or absent at Phase 0:

| Area | Reality |
|---|---|
| `strategy` stage | **Does not exist.** Server accepts only `research`, `script`, `storyboard`, `render`. `strategy/content_strategy.md` is a generator placeholder. |
| Script / storyboard / render | Deterministic local templates in `src/lib/workflowRunner.js`. No model, no real content. |
| Approval gates | `intakeWorkflow.approve()` is called only for `brief` and `materials`. There is no API to approve research, strategy, script or storyboard, despite `AGREED_WORKFLOW.md` requiring it. |
| Material analysis | Not implemented at all. "Imported" never means "analyzed". |
| Asset generation | No Leonardo, Mootion, or stock adapter. Credentials stored but inert. |
| Narration | No ElevenLabs/OpenAI TTS adapter. No audio produced. |
| Composer | Emits `timeline.json` plus a QC report. Never produces an `.mp4`. |
| Platform adaptation | Directories exist, empty. No export code. |
| UI | One 75 KB `docs/AI_Social_Content_Agent_UI_Prototype.html` with inline script. Needs media preview, players, and asset review; it will not hold up much longer. |

### Baseline blockers

1. **`npm test` exits 1.** `tests/settings.test.js` calls `createServer(...)` without `settingsFile`, so it points at the live `projects/_settings/settings.json` and tries to DPAPI-decrypt a key saved under a different Windows profile. The test must use a disposable settings file, and the store should degrade instead of throwing a hard 500 when a stored secret cannot be decrypted.
2. **`ffmpeg` and `ffprobe` are not installed.** Nothing from Phase 6 onward can be verified without them.
3. **The UI has no structure to extend.** See section 9. Every later phase adds a workspace (material review, asset review, render monitor, final check), and the current single-page prototype cannot host any of them without a rewrite. This is the second reason Phase 0.5 exists.

## 3. Locked Decisions

| Decision | Chosen |
|---|---|
| End state | prompt, playable MP4, platform exports |
| Media source | Hybrid: own media for A-roll, generated or stock for B-roll and gaps |
| Rendering | Local FFmpeg, driven from Node; Python only where a library earns it |
| First priorities | Fix `npm test`, then UI foundation (Phase 0.5), then Material Analysis, then Strategy and Script |
| Architecture | Keep plain Node built-ins, no framework, adapters behind interfaces |
| UI | Full redesign, dark-first editor layout, stage-based routing, no framework and no bundler (section 9) |

Smaller decisions that follow:

- **Interfaces first.** `LLMProvider`, `Analyzer`, `MediaProvider`, `VoiceProvider`, `Renderer` get real interfaces before new implementations. Claude becomes `LLMProvider #1` rather than a special case.
- **Provider-backed stages reuse the existing pattern.** `providerResearch.js` is already the correct shape: call provider, validate revision, back up to `history/`, write atomically, roll back on failure, bump the stage revision. Strategy, script and storyboard should be the same shape, not new inventions.
- **One generic stage engine.** Generalize `generateProviderResearch` into `runStage({name, provider, promptBuilder, writer})`. Otherwise Phase 3 means three near-copies of a 50-line function.
- **Add the missing approval API.** `POST /api/projects/:folder/approvals/:stage` with `{decision, revision, feedback}`, writing the approval record that `AGREED_WORKFLOW.md` describes. Stages downstream of an approved one become `needs_update` when upstream inputs change; `intakeWorkflow.invalidate()` already contains that logic and should be reused.
- **Kill the templates, do not hide them** (done: every template path was deleted rather than relabelled). **Original rule:** Templates survive only as an explicit "offline starter draft" that is labeled as such in the artifact and blocked from approval. The plan rule that a draft is never presented as a verified result applies here.
- **Analysis is honest about failure.** States: `imported`, `analyzing`, `analyzed`, `failed`, `unsupported`. Retry on failure. Import success never implies analysis success.
- **The composer is deterministic and inspectable.** The timeline is a real intermediate artifact with a schema, and FFmpeg commands are written into the project so a failed render can be reproduced by hand.
- **Full-quality originals, delivery-quality renders.** Never treat upscaled generated B-roll as A-roll.
- **Rebuild the UI once, in Phase 0.5, then extend it.** Separate `styles.css`, `app.js` and per-stage modules behind a small vanilla view layer. Still one server-served page, no framework, no bundler, no build step. The redesign is specified in section 9.
- **The UI is part of the product, not a debug view.** It is the only interface this tool has. A stage that exists on the server but cannot be operated in the browser is not finished.

## 4. Phases

### Phase 0 - Baseline (0.5 to 1 day) - COMPLETE

1. Fix `tests/settings.test.js` to use a disposable `settingsFile`, `projectsRoot` and library.
2. Make `settings.credentials()` treat an undecryptable secret as a recoverable state: report `error` with a "re-enter the key" message in the UI instead of throwing during unrelated requests.
3. Install FFmpeg and add a startup capability check that reports `ffmpeg` and `ffprobe` presence and version in Settings, so a missing binary surfaces before a render is attempted.
4. Fix doc drift found along the way. Confirm the README and `MILESTONE_1.md` links to `docs/CLAUDE_RESEARCH.md` resolve.

**Exit:** `npm test` exits 0, and Settings shows FFmpeg detected.

### Phase 0.5 - UI Foundation (2 to 3 days) - COMPLETE

Rebuild the shell before any new stage workspace is written, so later phases extend a real structure instead of patching the prototype. Full specification in section 9.

1. Split `AI_Social_Content_Agent_UI_Prototype.html` into `src/ui/index.html`, `src/ui/styles.css`, `src/ui/app.js`, and one module per stage. Retire the `docs/*.html` prototype.
2. Serve UI files from `/ui/*` with correct content types through the existing Node server. No bundler, no framework, no build step.
3. Replace the three competing navigation systems with one stage rail plus hash routing (`#/project/:folder/research`).
4. Land the design system: tokens, dark-first theme, and a documented component set (button, field, panel, status pill, chip, card, banner, empty state, skeleton, toast, modal).
5. Move the server-side status vocabulary (`workflow.js`) into the client so a stage can never be invented by the UI that the server does not have.
6. Rewrite `tests/ui-prototype.test.js` into a UI test that asserts routing, the stage list, and the honest-state rules rather than grepping for button IDs.

**Exit:** Every existing feature (picker, brief, material, research, settings) still works, each stage has a real URL, no duplicate navigation remains, and the current-stage-first layout is in place.

### Phase 1 - Material Analysis, text and documents (2 to 4 days) - COMPLETE

The unblocker for everything downstream: grounded research, real script references, storyboard asset selection.

- `src/analyze/index.js` - an analyzer registry keyed by detected type, with an explicit `unsupported` result rather than silent success.
- Probers: ffprobe for media metadata (duration, dimensions, codec, fps); extension and magic-byte sniffing for everything else; keep the existing path-traversal protection.
- Text extractors: `.txt`, `.md`, and URLs (the library already stores URL references).
- Outputs: `analyzed/material_analysis.json`, `analyzed/asset_index.json`, per-item `analyzed/transcripts/*`.
- API: `POST /api/library/:id/analyze`, `POST /api/library/analyze-pending`, `GET /api/library/:id/analysis`.
- Workspace: the material stage gets real analysis state on every card, per-item Analyze and Retry, and visible failure reasons.

**Exit:** Importing a real document and a real video yields a real probe result, an unsupported type says so, and failures are visible and retryable.

### Phase 2 - Material Analysis, transcription and PDFs (2 to 4 days) - COMPLETE

- Audio and video transcription behind an `Analyzer` adapter. Start with one implementation (local Whisper-class tool or an API) and keep it swappable.
- PDF text extraction. OCR stays out of scope unless a sourced PDF proves it necessary.
- Frame thumbnails for video so material cards can be chosen by eye.
- Feed confirmed knowledge selections into research instead of the current empty-context path.

**Exit:** A selected own video contributes real, quoted, traceable content into research.

### Phase 3 - Strategy and Script (3 to 5 days) - COMPLETE

- Introduce the `strategy` stage end to end: generator, artifacts (`strategy/content_strategy.md`, `audience.json`, `retention_plan.json`, `hooks.md`), server route, stage state, approval.
- Retire the template research and script paths into an explicit offline starter mode.
- Generalize `providerResearch` into the shared stage runner described above.
- Script generation consumes approved research, approved strategy, and selected analyzed knowledge, and must cite them.
- Approval API and workspace gate controls for research, strategy and script.
- Workspace: research and strategy and script review views with revision-aware approval, inline edit, and request-changes feedback.

**Exit:** Each approved stage feeds the next, upstream edits flip downstream stages to `needs_update`, a script line can be traced to its research finding and source material, and the offline starter can never be approved.

### Phase 4 - Director and Storyboard (2 to 4 days) - COMPLETE

- Storyboard becomes model-generated: scenes with narration segment references, selected own-media asset IDs, an explicit missing-asset list, and generation prompts.
- Scene-to-narration and scene-to-asset traceability stored in `storyboard/storyboard.json`.
- Storyboard approval gate.
- Workspace: a scene table where each row expands to its narration, chosen own asset with thumbnail, and missing-asset placeholder, plus a bulk "generate the missing set" action.

**Exit:** Every scene names its narration and either a real asset or a specific missing asset.

### Phase 5 - Asset Production and Narration (4 to 7 days) - COMPLETE

- `MediaProvider` interface; a Leonardo adapter for images and image-to-video; a stock provider for B-roll gaps; Mootion later or dropped depending on whether API access exists.
- `VoiceProvider` interface; one TTS adapter (ElevenLabs or OpenAI) plus word-level timing so captions do not have to be guessed.
- Workspace: an asset review grid where each generated asset can be approved, rejected or regenerated, with prompt, provider and cost visible.
- Asset Manager: index origin and generated material with provenance, license status and scene usage.
- Cost guardrails: per-project generation budget, confirmation before expensive batches, retry limits.

**Exit:** A project missing-asset list can be filled by generation and narration, and every produced asset is reviewable and traceable.

### Phase 6 - Composer and QC (5 to 8 days)

This is the phase that actually produces the video.

- Timeline schema with scene entries: asset, in and out points, transitions, captions, audio tracks.
- FFmpeg render pipeline: normalize and concat own clips, insert generated B-roll, still images with motion, burn or attach captions, mix narration and music with loudness normalization, export `final/youtube_master.mp4`.
- Caption generation from narration timing into `compose/captions.srt`.
- Preview proxy generation so the UI can play something before the master render completes.
- QC against real files: missing assets, unreadable files, A/V sync, duration deviation from target, black or blank frames, caption timing, aspect ratio, resolution, loudness (EBU R128), script coverage. QC blocks approval on failure.
- **Library media lives outside the project folder**, in `projects/_library/`, so a timeline entry for own or attached media must reference it by asset id and be resolved through the library, not by a project-relative path. Drawn scenes and sourced clips are inside the project and can be read directly.
- **The rights gate is a precondition, not a check.** `can_render` is already computed in the render plan and written to `compose/timeline.json` and the QC report. The composer must refuse to render while it is false, and every clip it places must be rights-cleared. Credits collected by the gate go into the export metadata in Phase 7.
- Render job records with logs and per-command reproducibility.
- Workspace: a render monitor with a live log, progress, cancel, a working video player for the proxy and master, and a QC report where every failed check links to the offending scene or file.

**Exit:** A real project produces a playable master whose `ffprobe` output matches the plan, and a failing check blocks approval instead of showing a fake ready state.

### Phase 7 - Final Review and Exports (2 to 4 days)

- Final-check stage: playable preview, a checklist of factual, visual, audio, caption, branding and export checks, and approval tied to a specific video revision.
- Platform exports: the 16:9 master plus 9:16 reframes for Shorts, TikTok, Instagram and Facebook, each with its own duration and caption treatment.
- Metadata packages per platform: title, description, tags, chapters, thumbnail, short-form captions.
- Download endpoints for master, adaptations, captions and metadata.
- Workspace: a final-check screen with the player, the checklist, per-revision approval, and an export list with file sizes and download buttons.

**Exit:** Users preview, request changes, approve and export a known revision, and blocking checks prevent a misleading ready state.

### Phase 8 - Closeout (1 to 2 days)

- Rewrite the README, `MILESTONE_1.md` and the handoff summary to match shipped reality.
- One end-to-end browser walkthrough on an isolated test project, recorded in the docs.
- Delete or clearly park dead paths (Mootion if unused, prototype-only endpoints).
- Final status update in this document.

**Exit:** Documentation describes only what exists, and every success criterion in section 1 has evidence.

## 5. Sequencing and Dependencies

```text
Phase 0 baseline
   |
   +--> Phase 0.5 UI foundation ----+ (shell, routing, design system)
   |                                |
   |                                +--> per-stage workspaces land with each phase below
   |
   +--> Phase 1 analysis (text/docs) ----+
   |          |                          |
   |          +--> Phase 2 transcription +--> Phase 3 strategy + script
   |                                                  |
   |                                                  +--> Phase 4 storyboard
   |                                                           |
   |                                                           +--> Phase 5 assets + narration
   |                                                                    |
   +--------------------------------------------------------------------+--> Phase 6 composer + QC
                                                                                 |
                                                                                 +--> Phase 7 exports
                                                                                          |
                                                                                          +--> Phase 8 closeout
```

Hard dependencies:

- FFmpeg (Phase 0) blocks Phase 6 and weakens Phase 1 probing.
- **Phase 0.5 blocks every workspace in Phases 1 to 7.** Without the shell, each new screen becomes another patched section of the single-file prototype, and the redesign cost multiplies.
- Phase 2 blocks the "grounded in own material" half of the success criteria; research currently sends an empty material context.
- Phase 5 blocks Phase 6. There is nothing to compose until assets and narration exist.
- Phase 4 should land before Phase 5 so asset generation is driven by an approved missing-asset list rather than generated speculatively. This is the main cost-control lever given the hybrid media decision.

Parallelizable: the FFmpeg install and the Phase 0 fixes; Phase 1 document extraction alongside Phase 2 transcription; Phase 0.5 CSS and component work alongside server-side Phase 1 work, since they touch different files.

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Paid generation cost runs away | Real money | Approved missing-asset list before any generation; per-project budget cap; batch confirmation; count retries |
| Hybrid media looks inconsistent | Quality | Own footage is A-roll only; constrain generated B-roll to a consistent style and grade |
| Transcription and analysis are slow | UX | Background jobs with progress, per-item status, cancel and resumable analysis |
| The 75 KB single-file UI collapses under players and review grids | Slows every later phase | Phase 0.5 rebuild lands before any workspace is added |
| UI rebuild becomes an open-ended redesign | Schedule | Fixed scope in section 9: no framework, no bundler, named components, and a hard exit check |
| Vanilla JS view layer becomes an unmaintainable string-concatenation mess | Slows every later phase | One module per stage, one small render helper, no global mutable DOM state, no HTML strings outside the templates module |
| Styling work attracts polish that blocks real progress | Schedule | Visual polish is a bounded pass in Phase 7, not continuous |
| Templates get mistaken for real output | Trust and wrong approvals | Label offline starter drafts distinctly and block approval on them |
| Mootion and Leonardo API access is unclear | Blocks part of Phase 5 | A stock provider covers B-roll; Mootion is optional and droppable |
| DPAPI keys do not survive profile or backup moves | Lost settings | Already documented; add an explicit re-enter-key recovery path in Phase 0 |
| Provider results vary run to run | Inconsistent test outcomes | Tests mock providers; keep only one deliberate, budgeted real-provider smoke test |

## 7. Effort

Rough working days for a single developer with agent assistance:

| Phase | Days |
|---|---|
| 0 Baseline | 0.5 to 1 |
| 0.5 UI foundation | 2 to 3 |
| 1 Analysis: text and docs | 2 to 4 |
| 2 Analysis: transcription and PDF | 2 to 4 |
| 3 Strategy and script | 3 to 5 |
| 4 Director and storyboard | 2 to 4 |
| 5 Assets and narration | 4 to 7 |
| 6 Composer and QC | 5 to 8 |
| 7 Final review and exports | 2 to 4 |
| 8 Closeout | 1 to 2 |
| **Total** | **about 24 to 42 working days** |

The long pole is Phase 6. Phases 5 and 6 together are more than half the remaining work. The workspace work inside Phases 1 to 7 is included in those phase estimates, not added on top.

## 8. Open Questions

1. **ElevenLabs or OpenAI for narration?** Determines the first `VoiceProvider` implementation.
2. **Does Mootion API access actually exist?** If not, drop the adapter and let the stock provider cover sequence gaps.
3. **Which stock provider for B-roll?** Pexels and Pixabay have free tiers; a paid one may match quality better.
4. **Transcription: local or API?** Local avoids per-minute cost and upload limits but needs a model download and slower runs.
5. **Roughly how much owned footage exists, and in what formats?** This decides whether the first composer must handle scene detection and trimming, or can start with simple cuts.
6. **Windows-only is acceptable?** DPAPI-encrypted settings already require it.
7. **Dark-first or light-first?** Section 9 proposes dark-first with a light option. Say so if you want light as the default.
8. **Is a "compact" or "dense" mode wanted for reviewing many scenes and assets at once?** It affects the component set, not the layout.

## 9. UI Rebuild

The current interface is not a design that needs polish. It is a prototype that needs replacing.

### 9.1 What is actually wrong

Measured against `docs/AI_Social_Content_Agent_UI_Prototype.html` (1713 lines, 710 of CSS and 580 of script):

1. **Three competing navigation systems.** The sidebar uses `data-jump` for four scroll targets; horizontal tabs use `data-view` for seven result views; the workflow panel is a flat row of stage buttons. Nothing tells you where you are, and the sidebar vocabulary (`project`, `workflow`, `library`, `settings`, `approvals`, `outputs`) does not match the 10-stage journey in `AGREED_WORKFLOW.md`.
2. **One page, three thousand pixels tall.** Every stage is stacked and everything is simultaneously visible. The current stage is not the center of attention, and `clarification` even carries an inline `style="margin-top:18px"` rather than being a real layout element.
3. **No routing at all.** No hash routes, no deep links, no back button, no bookmarkable state. Reloading can only resurface "the last opened project", and Settings is a scroll target rather than a page.
4. **No stage awareness.** Locked, ready, running, needs review, approved, needs update and failed all render as roughly the same button row. The honest-state contract in `AGREED_WORKFLOW.md` is not represented visually.
5. **No real media surfaces.** A `<video>` tag, a `<audio>` tag and an image preview. No thumbnails, no timeline strip, no scene-to-asset view, no side-by-side comparison. Phase 5 and 6 cannot be operated here.
6. **A 580-line imperative script.** Roughly 120 `getElementById` references, five separate sync functions (`updateProjectState`, `syncControls`, `applyIntake`, `fillBrief`, `renderDocument`) that all mutate the same DOM by hand, and no view ownership. Adding one stage means editing several of them.
7. **Visual language is generic.** The token set is reasonable, but the result reads as an admin dashboard. It does not look or feel like a video production tool.
8. **No visible feedback for slow work.** Generation and uploads need progress, cancellation and per-item status, and there is nowhere for them to appear beyond a toast.
9. **No accessibility baseline.** No focus management, no keyboard path through the stage flow, no live regions for async results, no reduced-motion handling, and small unlabeled icon buttons (the sidebar icons are literally the letters P, W, L, S, H, O).

### 9.2 Target information architecture

- **Project picker** is its own route: create, open, resume, with brief status per project.
- **Stage rail** is the only navigation. It lists the journey in order with per-stage state and prerequisites, marks the current stage, and collapses completed stages to a one-line summary that can be reopened.
- **Workspace** is the single main column: the current stage's inputs, its editable or reviewable result, and one clear primary action. Previous results are a click away, not scrolled past.
- **Inspector drawer** on the right holds revision history, approval records, artifact paths, and per-stage errors. This is where `history/` and approval revisions finally become visible.
- **Utilities** (Settings, library management, provider status) are separate routes, reachable from the project switcher, not scroll targets competing with the active stage.

Routes:

```text
#/                          project picker
#/settings                  providers, models, research defaults, capability checks
#/library                   reusable library management, global
#/project/:folder/          stage rail entry, redirects to the current stage
#/project/:folder/brief
#/project/:folder/material
#/project/:folder/analysis
#/project/:folder/research
#/project/:folder/strategy
#/project/:folder/script
#/project/:folder/storyboard
#/project/:folder/assets
#/project/:folder/compose
#/project/:folder/final
#/project/:folder/exports
```

### 9.3 Design direction

Dark-first, as fits a video tool, with a light theme available through the same tokens:

- Warm dark surfaces rather than pure black, neutral greys for chrome, and one saturated accent reserved exclusively for the primary action. Status colors stay separate from the accent so an approved stage can never be confused with a clickable button.
- Numeric and technical data (durations, revisions, resolutions, file sizes) in a tabular-figure font so columns align.
- A real 8px spacing scale, three elevation levels, and two radii. No inline styles anywhere.
- Generous whitespace in the workspace, tight and dense in the asset and scene grids.

### 9.4 Component set

Built once in Phase 0.5 and reused everywhere: button (primary, secondary, ghost, danger, loading), icon button with a real icon set and an accessible label, text field, textarea, select, checkbox, platform chip, file drop zone with progress, panel, section header, status pill per stage state, revision badge, asset card with thumbnail and category, scene row, banner (info, warning, error, offline-draft), empty state with a next action, skeleton loader, job progress with cancel, modal with focus trap, toast, and a video or audio player with captions.

### 9.5 Honesty and accessibility requirements

These are acceptance criteria, not aspirations:

- Every stage displays its state, its revision, and whether it is stale relative to upstream changes. "Approved" always shows which revision was approved.
- Locked stages look locked and explain their prerequisite. Failed stages show the actual error text with a retry.
- No stage offers an approval control for work that was not produced by a provider or rendered for real. Every approval names the revision or the video fingerprint it reviewed.
- No fake assets, no invented completion percentages, and no playable-video claim before a real render exists.
- Keyboard operable end to end, visible focus rings, WCAG AA contrast, ARIA roles on the stage rail, labels on every control, live regions for async results, and `prefers-reduced-motion` respected.

### 9.6 Constraints

- Vanilla JS with small modules. No React, no Vite, no bundler, no npm dependency added to a repository that has none.
- One server-served page. Static files served from `/ui/*` by the existing `src/server.js`.
- The stage list is generated from the server's status vocabulary in `src/config/workflow.js` so the UI cannot invent a stage the server does not have.
- One module per stage workspace, plus `api.js`, `router.js`, `store.js` and `components.js`. No HTML strings outside `components.js`.
- The old `docs/AI_Social_Content_Agent_UI_Prototype.html` is deleted at the end of Phase 0.5, with `README.md` and `ASTRA_HANDOFF_SUMMARY.md` updated to point at the new location.

### 9.7 Verification

- Routing tests over every route, including unknown project and unknown stage.
- A test asserting every server status and stage state has a corresponding UI rendering, so a new server state cannot silently render as "ready".
- A test asserting no inline `style=` attributes remain in the templates.
- A keyboard-only walkthrough of prompt to confirmed brief.
- A **real-browser smoke test** using the machine's installed Chrome or Edge through the DevTools Protocol (`tests/ui-browser.test.js`). It loads the shell, executes all 14 module scripts in order, applies the real stylesheet, asserts the rail fits without clipping, creates a project, confirms the brief, imports a real file, and fails on any page exception or console error. It is the only check that can catch a blank page. Screenshots are written to `test-results/` for visual inspection; they are evidence, not assertions.
- No npm dependency was added for any of this: the browser test speaks CDP over Node's built-in `WebSocket`.
## 10. Completion Record

The four success criteria that were outstanding, and the evidence for each:

| # | Criterion | Evidence |
|---|---|---|
| 1 | One real project goes prompt to playable `.mp4` | `tests/walkthrough.test.js` drives prompt to master to five exports in one run and probes the result with `ffprobe` |
| 2 | Research, strategy, script and storyboard are provider-generated | No deterministic generator remains in the tree; `src/lib/workflowRunner.js` was deleted and its one surviving function moved to `src/lib/projectPaths.js` |
| 4 | Rendering is real | `ffprobe` reports 1920x1080, h264, 24 fps and an audio stream for the composed master; `tests/compose.test.js` and `tests/exports.test.js` assert it |
| 7 | Every stage is operable in the browser | The rail carries ten stages, none labelled planned or template; three browser suites drive the real page |

The walkthrough, and what it produced on this machine:

```text
Walkthrough passed: prompt -> brief -> material -> research -> strategy -> script -> storyboard
  -> assets -> master -> QC -> approval -> five exports -> download.
Master: 1920x1080 14.00s, 217 KB.
Exports: youtube_shorts 1080x1920, tiktok 1080x1920, instagram 1080x1920,
         facebook 1080x1920, square_feed 1080x1080.
```

Its language model and speech service are mocked, because the test suite must never spend money.
Everything downstream is real: the graphics are drawn by headless Chrome, the narration durations are
measured with ffprobe, the master is encoded by FFmpeg, QC is measured against the written file, and
the exports are really reframed. The provider paths themselves are covered by
`tests/research-provider.test.js` against a mocked API with no paid calls.

### What is deliberately not built

- **Publishing.** Nothing uploads to a platform. The exports are files.
- **Music, sound effects, voice cloning and multi-language narration.**
- **An image or video generation provider.** Graphic scenes are drawn locally by six templates, and
  anything that must be generated is attached by hand through the scene prompt pack.
- **Generated-asset review.** Re-running the assets stage replaces the manifest; there is no
  approve/reject loop per asset.
- **The `publishing/` and `analytics/` scaffolding** written when a project is created. Those
  directories are parked, not implemented, and no stage reads or writes them.
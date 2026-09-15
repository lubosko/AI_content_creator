# Creative Stages

Implemented 2026-09-10. This is Phase 3 and Phase 4 of
[the completion strategy](PROJECT_COMPLETION_STRATEGY.md): the strategy, script and storyboard
stages, the shared stage engine, and the approval gates.

> The offline starter drafts are **gone**. Research, strategy, script and storyboard are
> provider-backed, and a stage that cannot reach a provider fails visibly. No stage silently
> substitutes a template.

## The stages

| Stage | Route | Produces |
|---|---|---|
| Research | `POST /api/projects/:folder/research` | `research/research_notes.md`, `sources.json`, `fact_check.json`, `provider_result.json` |
| Strategy | `POST /api/projects/:folder/strategy` | `strategy/content_strategy.md`, `audience.json`, `retention_plan.json`, `material_usage.json`, `provider_result.json` |
| Script | `POST /api/projects/:folder/script` | `script/script.md`, `script.json`, `hooks.md`, `shorts_candidates.json`, `provider_result.json` |
| Storyboard | `POST /api/projects/:folder/storyboard` | `storyboard/storyboard.json`, `storyboard.md`, `scene_prompts.json`, `scene_prompts.md`, `provider_result.json` |
| Assign a local template | `POST /api/projects/:folder/scene-graphic` | Rewrites the storyboard plan: `{scene_id, template|null, data?}` |
| Draw a preview | `POST /api/projects/:folder/scenes/:sceneId/render-preview` | Writes `generated/preview/` only; never touches the plan |
| Attach generated media | `POST /api/projects/:folder/scenes/:sceneId/asset` | `{asset_id, tool?, note?}`; `asset_id: null` detaches |
| Final check | `POST /api/projects/:folder/final` | `final/final_check.json`, `final/youtube_metadata.json`, `final/youtube_thumbnail.jpg` |
| Platform exports | `POST /api/projects/:folder/exports` | `adaptations/<platform>/` plus `adaptations/export_manifest.json` |
| Approve the video | `POST /api/projects/:folder/approvals/master_video` | Requires a passing QC report and every manual checklist item confirmed |
| Approve the exports | `POST /api/projects/:folder/approvals/platform_adaptations` | Requires an export manifest matching the current run |
| Render plan | `POST /api/projects/:folder/render` | Still a template; no video is produced |

Research takes its own options in the request body: `{provider, web_search, include_materials}`.
Strategy, script and storyboard take none; they read the approved artifacts from the project.

## Order of operations

```text
brief approved -> material confirmed -> research -> approve research
   -> strategy -> approve strategy -> script -> approve script
   -> storyboard -> approve storyboard -> render plan
```

A stage refuses to run without its inputs:

- Research and every stage need the brief and material confirmed.
- Strategy needs saved research. It does **not** require that research be approved, but approving it
  is what unlocks the stage in the interface.
- Script needs saved strategy.
- Storyboard needs a saved script with sections, because scenes reference script section ids.

## The storyboard

The storyboard is where your own footage enters the plan. The director is given a catalogue of the
**visual** assets selected for the project — video and images, not notes or PDFs — with each one's
real name, resolution, duration, and a short description taken from what analysis actually read: a
transcript for footage, extracted text for a document.

Each scene records:

- the script section it covers, so a scene can be traced back to its narration;
- a duration, visual intent, shot type, on-screen text and transition;
- either `asset_id` pointing at one of your assets, or `null`;
- a `generation_prompt` describing the shot when nothing available fits.

### Asset selection is verified, not trusted

A model can invent an asset id. **Any id that is not in the catalogue is dropped**, the scene is
treated as a missing asset, and the count of rejected ids is reported as a warning on the artifact and
in the interface. A scene can therefore never claim to use footage that does not exist. A scene that
names a script section that does not exist loses the link for the same reason.

The missing-asset list is computed by the server from the validated scenes, not written by the model,
so `storyboard/missing_assets`, `scene_prompts.json` and `scene_prompts.md` are exactly the scenes that still need
something produced. That list is what asset production consumes.

If the project has no own media at all, the prompt says so explicitly and every scene must carry a
generation prompt instead.

Errors name the missing step, for example: *"Strategy needs approved research first. Generate and
approve research, then retry."*

## Approval gates

`POST /api/projects/:folder/approvals/:stage` with:

```json
{
  "decision": "approved" | "changes_requested",
  "revision": 12,
  "stage_revision": 1,
  "feedback": "optional text"
}
```

- `revision` is the project workflow revision; `stage_revision` is the revision of the result being
  reviewed. **Both are checked.** If the project changed, or the result was replaced, the decision is
  refused with 409 rather than being applied to something the reviewer never saw.
- An approval is recorded with the exact stage revision it reviewed, so a later regeneration cannot
  inherit it. The record also keeps any feedback and the timestamp.
- Approving a stage unlocks the next one. Requesting changes leaves the stage in `needs_review`.
- Regenerating a stage marks every downstream stage `needs_update`, so stale work cannot look ready.

The interface shows the approval panel on the stage itself, naming the revision:
"Approve revision 2". A `changes_requested` decision keeps the result and records why.

## The stage engine

`src/lib/stageRunner.js` is one engine for every provider-backed stage. It:

1. Captures the project inputs and the workflow revision.
2. Calls the provider.
3. **Refuses to save if the project changed while the provider was working** — the result would be
   based on inputs nobody has any more.
4. Archives the previous artifacts under `<stage>/history/<timestamp>-<id>/` so a replacement can be
   compared with what it replaced.
5. Writes every output, and on any failure restores the previous bytes.
6. Bumps the stage revision, sets it to `needs_review`, invalidates downstream stages, and records
   that approval is pending again.

Output paths are checked against the project directory, so a stage cannot write outside it.

## Filling a scene

A scene without own media can be drawn locally by assigning a template, attached from a file generated
elsewhere, or left to footage sourcing. Assignment and attachment are plan changes and go through the
stage engine, so they are archived, invalidate what depended on them and reset the storyboard's
approval. A preview is deliberately outside that engine and changes nothing. See
[Scene rendering](SCENE_RENDERING.md).

## Delivering the video

Composing and exporting are gated rather than sequential by convention: the composer's QC report must
have no blocking issues before the video can be approved, the approval is tied to a fingerprint of the
exact master, and the exports refuse to run until that approval exists. See
[The composer and QC](COMPOSER_AND_QC.md) and [Exports](EXPORTS.md).

## What the model must return

Research must return Markdown containing `Summary`, `Key findings` and `Claims to verify` headings.
Strategy, script and storyboard must return JSON matching a documented shape. Anything else is a
failure and nothing is saved.

Parsing is tolerant of the ways models actually answer — code fences, prose around the JSON — but it
never guesses. Truncated JSON, a missing story promise, an empty structure, a script with no
narration, or a storyboard with no scenes all fail with a specific reason instead of writing a
half-result to the project.

Optional fields default rather than failing: a strategy with no hooks is still a strategy, and the
missing pieces are visible in the artifact.

## Validation

`tests/stages.test.js` covers JSON extraction from fenced and prose-wrapped answers, rejection of
truncated or unusable JSON, every required-field failure, the defaults for sparse answers, the asset
catalogue, and storyboard asset validation — including that a hallucinated asset id is dropped, that
an unknown narration section is unlinked, and that with no media available every scene is missing.
It also covers the intake gate, stage history, revision handling, refusal to save when inputs changed
mid-flight, and rollback after a failed write including the path guard.

`tests/server.test.js` drives the whole journey from research to render plan through real HTTP with a
generated video clip as genuine own media, asserting that a scene selecting that asset keeps it, that
the other scene appears in the missing-asset list with its generation prompt, and that a stale
approval is refused. Provider calls are mocked: no network requests and no paid calls. The browser
test approves revision 1 in a real browser and asserts the next stage unlocks.
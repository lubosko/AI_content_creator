# Run to final check

One action that takes an approved storyboard to a rendered, QC-inspected master — and stops there.
It is in the sidebar menu, and it is a *project action*, not a stage: it drives the stages without
being one, so it never appears in the approval chain.

## The steps

| # | Step | Skipped when | Stops the run when |
|---|---|---|---|
| 1 | **Generate missing scene media** through Comfy | No Comfy key or workflow, or nothing to generate | A scene fails to generate |
| 2 | **Assets** — narration, local template drawings, stock sourcing | never | Scenes still have no media |
| 3 | **Composer** — build the master, inspect it with QC | never | never |
| 4 | **Final check** — checklist, thumbnail, metadata package | never | never |

Step 4 runs **even when QC found blocking issues**, because the final check screen is where those
issues are consolidated and read.

## What it deliberately does not do

- **It never approves anything.** The manual checklist — that you watched it, that the figures are
  right, that the branding is right, that every source may be used as it is — asserts things the app
  cannot know. Handing those a rubber stamp would defeat the point of having them.
- **It never runs the exports stage.** "Up to the final check" is the contract.
- **It never starts by itself.** There is no schedule and no trigger; you press Start.

## Preconditions

Before the Start button enables, the project must have:

1. an approved brief,
2. an approved material selection, and
3. an **approved storyboard**.

The storyboard gate is doing real work. Generating media costs credits and takes minutes, and running
that against a scene plan nobody has reviewed would spend money on a plan that is about to change.
When a precondition fails the button is disabled and the reason is shown, rather than the refusal
appearing after a click.

## Stop points

| `stop_after` | Behaviour |
|---|---|
| `final_check` (default) | The whole run: generate, assets, compose, final check |
| `generate` | Generate the missing media and stop, so you can look at the images and clips before committing to a render |

## Stopping on a failed scene

If a scene cannot be generated, the run **stops** rather than carrying on. Composing anyway would draw
a placeholder card for that scene and produce a video QC must block, which wastes a render.

Recovery is cheap by design: generated scenes are already attached, and a re-run only retries what
failed — `generateScene` only ever sees scenes with no `asset_id`, and the assets stage skips any scene
that has one.

If scenes still have no media after the assets stage, the run stops there too, naming them, and **no
render is started**.

## It runs in the background

A generation pass plus a render is minutes of work, so the run is not held inside an HTTP request. The
record lives at `generated/pipeline_run.json`:

```json
{ "started_at": "...", "stop_after": "final_check", "status": "succeeded",
  "steps": [ { "id": "generate", "status": "skipped", "detail": "..." } ],
  "generated": { "succeeded": [], "failed": [], "skipped": [], "total": 0 },
  "stop_reason": "The video was rendered and the final check run. Watch it, then approve it." }
```

Because the record is on disk:

- **Reloading the page re-attaches** to a run already in progress.
- **A server restart is reported as `interrupted`**, not as a progress bar that never moves again. The
  message says the scenes already generated are attached, so starting again continues from there.
- **Cancel** flags the run, stops it between scenes and between steps, and cancels the Comfy job in
  flight so billed GPU seconds stop.

The screen polls the server, starting at 1.5s and backing off to 8s, and stops polling when the run
settles or you navigate away.

## Routes

| Route | Behaviour |
|---|---|
| `GET /api/projects/:folder/pipeline` | The last run, the preconditions, and what a run would do |
| `POST /api/projects/:folder/pipeline` | `{stop_after}` — starts, returns the record with `202` |
| `POST /api/projects/:folder/pipeline/cancel` | Stops the run and the job in flight |

A project is "busy" while a pipeline runs, so a manual stage and a pipeline cannot run over each
other.

## Validation

`tests/pipeline.test.js` covers the engine with fake steps — ordering, both stop points, a failed
scene, no Comfy configured, cancellation, the interrupted state and every preflight refusal — and then
drives the routes through the real server with **real FFmpeg**, asserting that a master is rendered,
that the final check is written, and that **no approval is recorded**. `tests/ui-pipeline.test.js`
does the same through the real views in the fake DOM, with Comfy mocked so nothing leaves the machine.
# Scene Rendering and Filling a Scene

Implemented 2026-09-11. Every scene in a storyboard can now be filled without leaving the app:
drawn locally by a template, attached from a generation tool you ran yourself, or left to footage
sourcing. Nothing in this feature spends money.

## What it does

| Output | Where | Notes |
|---|---|---|
| Drawn scene | `generated/graphics/scene-NNN-<scene>.mp4` | Silent, 1920x1080, 24 fps by default |
| Render provenance | `generated/graphics/render_manifest.json` | Template, file, duration and the signature it was drawn from |
| Preview | `generated/preview/scene-<scene>.mp4` | 640x360 at 12 fps, for looking at, never part of the plan |
| Prompt pack | `storyboard/scene_prompts.json`, `storyboard/scene_prompts.md` | One entry per scene needing media, prompt verbatim |
| Assignment | `storyboard/storyboard.json` | `scene.graphic_template` and `scene.graphic_data` |
| Attachment | `storyboard/storyboard.json` | `scene.asset_id` and `scene.attachment` |

## The six templates

| Template | Fills | Data it needs |
|---|---|---|
| `text-card` | Centred text, revealed word by word or faded | nothing beyond the text |
| `bar-chart` | Horizontal bars growing to their values | `bars: [{label, value, display?, color?}]`, at least two |
| `terminal` | Monospace card with typed-line reveal | `lines: [{prompt?, text}]` |
| `diagram` | Nodes and arrows appearing in sequence | `nodes: [{label, x, y}]`, `edges: [[from, to]]` |
| `split-compare` | Two labelled panels, optional badge | `left: {label, text}`, `right: {label, text}` |
| `end-card` | Logo, tagline, "next:" line | `next`, and an optional brand logo |

Data the operator does not supply is **derived where it can be and left empty where it cannot**. An
on-screen line of `ROS2=100 | Dora-rs=380` becomes two bars; a line with no parseable figures produces
no bars and the render is refused with the reason. Nothing is invented: a chart of made-up numbers in
a technical explainer is worse than an empty one.

## How a scene is drawn

`src/lib/frameRenderer.js` builds a self-contained page from a template, the shared runtime and the
shared stylesheet, then:

1. Launches the browser already installed on this machine through the Chrome DevTools Protocol client
   in `src/lib/browser.js` — no npm dependency, no bundler.
2. Pins the viewport with `Emulation.setDeviceMetricsOverride`, so the capture is exactly the size
   asked for rather than whatever the window happens to be.
3. Steps `n` from 0 to `frameCount - 1`, calling `window.renderFrame(n)` and screenshotting each
   frame as JPEG (quality 92).
4. Assembles the frames with FFmpeg: `libx264 -crf 18 -pix_fmt yuv420p`, with `+faststart`.
5. Deletes the frame directory and the temporary page on success **and** on failure.

Templates are plain HTML, CSS and JavaScript, and everything is expressed in viewport units, so a
640x360 preview and a 1920x1080 master look identical rather than merely similar.

**Frames are driven by the index, never by wall-clock time.** That is why stepping frames is chosen
over recording the page in real time with `MediaRecorder`: recording is faster, but it introduces
timing jitter and codec variability and makes the output depend on how fast this machine happens to
render. The same scene must always produce the same video.

### Refusals

| Situation | Result |
|---|---|
| Unknown template | 400, naming the six that exist |
| Text that cannot fit the frame even at the smallest size | 409, quoting the text that did not fit |
| A scene above the frame ceiling (3600 frames) | 409, before a single frame is captured |
| Template data that is missing or malformed | 409, naming what the template needs |
| A template that renders nothing at all | 500, rather than an empty frame |

The text fit is measured with the height cap lifted. Comparing `scrollHeight` against `clientHeight`
on a clipped element reports a one-pixel difference that never goes away, and chasing it shrank an
ordinary headline to a third of its size.

An empty `eyebrow` or `footnote` is hidden after the build, because an empty element still
contributes its margin and pushes the real content off centre.

## Assigning, previewing and producing

- **Assignment** is a plan change. It goes through the stage engine, so it is archived under
  `storyboard/history/`, bumps the storyboard revision, resets its approval to `needs_review`, and
  invalidates the assets, compose and final stages. `storyboard/provider_result.json` — what the
  model actually returned — is never rewritten.
- **A preview** is deliberately not a plan change. It writes to `generated/preview/` and touches
  nothing else. Tests assert that it leaves the revision, the approval state and the approvals
  untouched, because that is the entire point of separating it.
- **Production** fills a scene in this order: own or attached media from the library, then an assigned
  template, then an unchanged drawing from a previous run, then stock sourcing. A drawing is reused
  only when its template, data, text and duration are unchanged, compared by a signature recorded in
  `generated/graphics/render_manifest.json`.

The asset manifest reports drawn scenes as `status: "rendered"` and `counts.rendered`, and each scene
that has media carries `media: {kind, duration_seconds, width, height}` so the composer never has to
resolve the library itself. A drawn scene's rights basis is `own`: it is our own code drawing the
project's own script.

## Filling a scene

The Storyboard screen shows **one card per scene**, and each card offers the three ways to fill it as
buttons. Only the chosen path opens, so a fourteen-scene storyboard does not put every control for
every scene on screen at once:

| Path | What it does |
|---|---|
| **Draw locally** | Assign one of six templates, edit its data, render a preview, or clear it |
| **Generate with Comfy** | Pick a workflow, edit the prompt, generate, watch progress, cancel |
| **Use a file** | Attach material chosen for this project, upload a generated file, or detach the current media |

A card remembers whether it is open and which path you were on, because a re-render rebuilds the
element and `<details>` cannot hold that state itself. Without it the card snapped shut after every
save, and while the script results were still arriving.

The state is named in one vocabulary everywhere — on the pill, in the metrics and on the assets
screen: **Your media**, **Drawn locally**, **Generated**, **Needs media**. It used to be four names for
the same thing (`Missing`, `Not filled`, `To fill`, `Still to produce`), which read as four problems.

The library picker lists only **material chosen for this project**, which is the same rule
`providerStages.selectedAssets()` applies. Offering the whole library meant an unrelated file appeared
even when nothing had been chosen.

### The prompt pack

Built by `src/lib/sceneAssets.js` and served through the Storyboard stage:

- **The model's prompt is carried verbatim.** The tool notes sit in their own block so nobody has to
  guess which words are the prompt and which are advice.
- Tool profiles exist for manual, Leonardo AI, Mootion and Comfy. Their notes are **guidance, never
  vendor documentation**, and both the interface and the pack say so.
- Scenes that are mostly on-screen text are flagged in the **Generate** path, where the decision is
  made. A video generator will misspell those words or invent ones that are not in the script, which
  is worse than useless in a technical explainer; the flag points at the local templates instead.
- Scenes already assigned a template stay in the pack as a fallback, marked `assigned_template`, so a
  generation is not spent on them by accident.

**Attaching** a file to a scene (`POST /api/projects/:folder/scenes/:sceneId/asset`) refuses, in this
order, when: the scene is unknown; the file is missing; the item is a knowledge reference rather than
media; its rights are not cleared; or the scene is assigned a template. On success it records
`scene.attachment` with the tool, the note and the rights basis, and adopts the asset into the
project's material selection — asking to attach this file to this scene already is that decision, and
requiring a separate selection round trip would be busywork. Detaching (`asset_id: null`) clears both
fields and returns the scene to needing media, and has a control on the card.

## Decisions and why not Remotion

[Remotion](https://www.remotion.dev/docs/license/pricing) was evaluated and deliberately not adopted.
It renders React components to video using the same headless-Chrome-plus-FFmpeg mechanism built here,
with a better authoring experience and a live preview Studio. It would have broken the constraint
recorded in [the completion strategy](PROJECT_COMPLETION_STRATEGY.md): *"No React, no Vite, no
bundler, no npm dependency added to a repository that has none."* Its licence is also free only for
individuals and organisations of up to three people, and an automated pipeline is the category its
$100/month "Automators" tier names.

Two other routes were ruled out on evidence:

- **Local AI video is not viable on this machine.** A 4 GB Radeon Pro 560X with no CUDA, against open
  weights that want 12-24 GB.
- **OpenAI video is not viable at all.** The Videos API and both Sora 2 models are deprecated with a
  shutdown date of 24 September 2026 and no replacement listed. Their image API is unaffected.

A paid aggregator or vendor API is now partly built: **Comfy Cloud** is the one generation provider the
app can run itself, driven from the scene panel. See [Comfy generation](COMFY_GENERATION.md). Output
from a vendor you hold the account with is your own work and is recorded as `generated` — see
[rights and licensing](RIGHTS_AND_LICENSING.md). Through an aggregator the chain is a reseller's claim,
which would be recorded as declared rather than verified.

## Honest limits

- **These are motion graphics, not photoreal footage.** A template draws what it is given; it cannot
  produce a shot of a robot arm on a workbench.
- **No transitions between scenes.** The composer owns those.
- **No still animation.** A still image is placed as a still; zoom and pan are not implemented.
- **No music or sound effects.** Drawn scenes are silent, and narration is mixed in by the composer.
- **Six templates, not a design system.** A scene that wants something else needs a video generator or
  the composer.
- **The tool notes are unverified.** They were not taken from Leonardo's or Mootion's current manuals.
- **Rendering is linear in frames.** A 20-second scene at 24 fps is about 480 frames and takes on the
  order of a minute; a long scene is refused above 3600 frames rather than running for an hour.

## Validation

`tests/render.test.js` renders every template through real Chrome and verifies the output with
`ffprobe`: codec, resolution, frame count and duration. It covers determinism, that hostile text is
rendered literally rather than as markup, that each template controls its own text size, that frames
are cleaned up on success and after failure, and the refusals above.

`tests/scene-assets.test.js` covers the heuristics, the prompt pack, assignment and clearing,
attachment and its five refusals, detaching, production precedence and render reuse, with the network
mocked and the renderer injected.

`tests/ui-scene-fill.test.js` drives the panel in the fake DOM, including the clipboard and its
fallback. `tests/ui-render-browser.test.js` proves the whole chain in a real browser: the interface
asks for a preview, the server draws it, and the page plays the file back at the right size and
duration.
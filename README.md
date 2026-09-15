# AI Social Content Agent

A local, dependency-free content production pipeline: from a written prompt to a playable master video
and a set of platform exports. It runs on your machine, keeps your material and credentials local, and
makes no AI calls you have not explicitly asked for.

It is built to be honest about what it has and has not done. Every stage records what it actually
produced, the rights gate blocks material whose licence is not recorded rather than assuming it is
fine, and the app never approves its own work — the final checklist exists precisely because the
remaining questions are the ones only you can answer.

## Quickstart

```bash
# 1. Node 18 or newer, plus FFmpeg and ffprobe on PATH
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg

# 2. Start it
npm.cmd run dev          # or: node src/server.js

# 3. Open http://localhost:3000
```

Nothing to install: `package.json` has no dependencies and there is no `node_modules`. On macOS and
Linux use `npm run dev` and your package manager for FFmpeg.

Then: open **Settings** and add at least an Anthropic API key (research, strategy, script and
storyboard) — optionally OpenAI for narration and transcription, Pexels for stock video, and Comfy
Cloud for generated shots. Without a key a stage fails with a clear message rather than substituting
a template.

## Providers

| Provider | Used for | Required? |
|---|---|---|
| Anthropic (Claude) | Research, strategy, script, storyboard | Yes, for the creative stages |
| OpenAI | Narration (speech) and transcription | Optional |
| Pexels | Stock video | Optional |
| Archive.org, Openverse | Stock footage and stills | No key needed |
| Comfy Cloud | Generating a shot from your own ComfyUI workflow | Optional |

Keys are stored encrypted with Windows DPAPI, or in a `.env` file on other platforms.

## What it does not do

- **It does not upload anything.** Exports are files with download links; publishing is yours.
- **It does not generate music, sound effects, voice clones or multiple languages.**
- **It does not run unattended.** Generation costs credits and is always something you asked for.
- **It is not a stock-footage replacement.** Own footage is A-roll; generated and stock material is
  B-roll, and the app never pretends otherwise.

## Product workflow

See [Agreed Product Workflow](docs/AGREED_WORKFLOW.md) for the approved user journey and the current
status of every phase in [the completion strategy](docs/PROJECT_COMPLETION_STRATEGY.md).

## Local UI

Run `npm.cmd run dev` and open [the local app](http://localhost:3000).

The interface is served from `src/ui/`: one shell (`index.html`), a design-system stylesheet,
and small vanilla JavaScript modules with no framework, bundler, or build step. Screens are
addressable by hash route, for example `#/`, `#/settings`, `#/library`, and
`#/project/<folder>/<stage>`.

The whole agreed journey is implemented, from a prompt to a playable master and platform exports. The
stage rail carries ten stages and none of them is a placeholder.

## Requirements

Node.js 18 or newer. Video composition additionally requires FFmpeg and ffprobe on PATH; Settings reports whether they are detected. Install them separately, for example with `winget install Gyan.FFmpeg`. Research requires an Anthropic API key.

## Material analysis

Imported material can be analyzed: text is extracted from notes, text files, PDFs and URLs; media
metadata and a preview frame come from FFmpeg; speech is transcribed through an OpenAI adapter with
timings and a WebVTT subtitle file; and images report their real dimensions. Importing never implies
analysis, unsupported types say so, and failures keep their reason. Transcription is billed per
minute, so files longer than ten minutes ask for confirmation with a cost estimate first. See
[Material analysis](docs/MATERIAL_ANALYSIS.md).

## Creative stages

The workflow is `brief → own material → research → strategy → script → storyboard → assets → composer → final check → exports`.
At each creative stage a language model produces the artifact, you review it, and you approve that
exact revision before the next stage unlocks. Approvals are recorded against the revision they
reviewed, so regenerating invalidates them rather than inheriting them.

The storyboard selects your own analyzed media scene by scene, or records that a scene still has to
be produced. Every asset id it names is verified against your library, so a scene can never claim to
use footage that does not exist.

Research, strategy, script and storyboard are provider-backed. **There is no offline fallback**: a
stage that cannot reach a provider fails with a clear message instead of quietly producing a
template. See [Creative stages](docs/CREATIVE_STAGES.md).

## Asset production

Once a storyboard is approved, the **Assets** stage fills its gaps: narration is synthesized per
script section with durations measured from the real audio files, graphic scenes are drawn locally by
six templates, and scenes with no own media are filled from free-licence sources — Pexels when a key
is set, then Archive.org and Openverse, which need none. Every gap is reported with a reason, so the
manifest never claims more than was produced. See [Asset production](docs/ASSET_PRODUCTION.md).

## Generating a shot

For a scene no template can draw and no stock library has, **Comfy Cloud** generates it on demand: you
export a workflow from ComfyUI, point the app at it, and generate from the scene panel. The result is
imported as your own generated work and attached to the scene. See
[Comfy generation](docs/COMFY_GENERATION.md).

## Run to final check

The sidebar carries **Run to final check**, which generates whatever media the storyboard is still
missing, runs the assets stage, renders the master and runs the final check — then stops. It never
approves anything and never builds the platform exports, because those are decisions only you can
make. You can also stop it after generating, to review the images and clips first. See
[Run to final check](docs/RUN_TO_FINAL_CHECK.md).

## Rights and licensing

Every piece of material that can appear **inside the video** needs a recorded basis before it can be
used: your own work, written permission, public domain, or a specific Creative Commons licence.
Material with nothing recorded is **blocked**, not assumed to be fine — at material confirmation, in
the storyboard, in the asset manifest and again before rendering. Licences that forbid commercial use
or editing are refused, and the credits a licence requires are collected ready for the exports. Notes,
PDFs and URL references read for research are deliberately *not* gated: reading a page and writing
about it is not copying it into a video. This is why other people's YouTube footage is not a source
here; see [Rights and licensing](docs/RIGHTS_AND_LICENSING.md).

## The composer and QC

The **Composer** stage renders `final/youtube_master.mp4`: 1920x1080, 24 fps, h264 with AAC narration.
Each scene becomes a normalised segment, the segments are joined, and the narration is laid underneath
scene by scene so audio and picture cannot drift apart. A script section narrated once but spread over
several scenes has its audio split across them, and the captions follow the same split.

Then QC inspects the file that was actually written — resolution, frame rate, duration against the
plan, audio, caption timing, script coverage, black stretches and loudness — and **any blocking check
stops the video being approved**. See [The composer and QC](docs/COMPOSER_AND_QC.md).

## Final check and exports

The **Final check** shows the video, a thumbnail extracted from it, the metadata package, and the
items only you can confirm: that you watched it, that the figures are right, that the branding is
right, and that every source may be used as it is. Approving is refused until those are confirmed, and
the approval is tied to a fingerprint of that exact video, so re-rendering invalidates it.

The **Exports** stage then produces versions for YouTube Shorts, TikTok, Instagram, Facebook Reels and
a square feed post, each with its own duration limit and its own captions. Vertical versions keep the
whole frame: the 16:9 picture is centred over a blurred enlargement of itself rather than cropped, so
the words survive. See [Exports](docs/EXPORTS.md).

## Filling a scene

Every scene that has no own media can be filled in four ways, and the storyboard stage offers them
side by side:

- **Drawn locally.** Assign one of six templates — text card, bar chart, terminal, diagram, split
  comparison, end card — and the app draws it with headless Chrome and FFmpeg, for free, offline, and
  spelling your words exactly. This is the right answer for the graphic and typographic scenes that
  make up most of a technical explainer, where a video generator would misspell the on-screen text.
- **Generated here, through Comfy.** Export an API workflow from ComfyUI, point the app at it, and
  generate the shot from the scene panel. It costs credits and takes minutes, and the result is
  attached to the scene as your own generated work.
- **Generated elsewhere, then attached.** Copy the scene prompt into Leonardo or Mootion, and attach
  the result. The prompt is quoted verbatim, the tool notes are labelled as unverified guidance, and
  the licence basis is recorded before the file can be attached.
- **Footage sourcing**, from the free-licence sources above, for photoreal shots.

A preview is free and changes nothing; assigning a template is a plan change and needs approval
again. See [Scene rendering](docs/SCENE_RENDERING.md).

## Settings

Use the **Settings** sidebar section to manage provider credentials, models and research defaults. [Settings guide](docs/SETTINGS.md).

## Connect Claude research

See [Claude setup and research usage](docs/CLAUDE_RESEARCH.md). Configure your API key in `.env`, restart the server, then use **Research → Test Claude connection**.

## Connect transcription

Add an OpenAI API key in **Settings** to transcribe speech from your own video and audio. The model
defaults to `whisper-1`. Without a key, media is still probed for metadata and the card says that no
transcription provider is configured.

## Create a Project

```powershell
npm run create -- "Create an 8-minute YouTube video about humanoid robots in factories for technology enthusiasts. Use my own product footage where possible and adapt the final video into Shorts, TikTok, Instagram, and Facebook versions."
```

The generator creates a folder under `projects/` with:

- `project.json`
- the full suggested production directory structure
- starter files for prompt intake, research, strategy, script, storyboard, asset indexing, narration, timeline, QC, metadata, publishing, and analytics

## CLI Options

```text
node src/cli.js create "<prompt>" [options]

Options:
  --topic <topic>              Override inferred topic
  --language <language>        Defaults to en
  --duration <seconds>         Target duration in seconds
  --platforms <list>           Comma-separated platform IDs
  --primary-platform <id>      Defaults to youtube
  --out <directory>            Defaults to projects
  --id <project-id>            Override generated project ID
  --slug <slug>                Override inferred slug
  --llm-provider <name>        Defaults to openai
  --llm-model <model>          Defaults to configurable-default
  --scene-provider <name>      Defaults to leonardo
  --sequence-provider <name>   Defaults to mootion
  --voice-provider <name>      Defaults to elevenlabs
  --voice-id <id>              Defaults to default_creator_voice
  --json                       Print machine-readable result
```

## Test

```powershell
npm test
```

The suite includes a real-browser smoke test that drives the served page in headless Chrome or
Edge, asserts the page boots with all modules and styles applied, and writes screenshots to
`test-results/`. It uses the browser already installed on the machine through the DevTools
Protocol, so the project keeps zero npm dependencies. Set `CHROME_PATH` to point at a specific
Chromium-based browser, or `ALLOW_SKIP_BROWSER_TESTS=1` to skip that test deliberately.

### Dependency-free

`package.json` has no dependencies and there is no `node_modules`. The server uses Node built-ins,
and the browser test speaks the DevTools Protocol over Node's built-in `WebSocket`.

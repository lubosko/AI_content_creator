# Comfy generation

Scenes that need a shot no template can draw and no stock library has can be generated on demand
through **Comfy Cloud**, using a ComfyUI workflow you export yourself. This is the one generation
provider the app can run on its own; every other route is a manual round trip.

## What the app calls

The official [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview), over plain HTTP with
`fetch`. Nothing else in the app speaks to Comfy.

| | |
|---|---|
| Base URL | `https://cloud.comfy.org` |
| Auth | `Authorization: Bearer <COMFY_API_KEY>` |
| Submit | `POST /api/v2/jobs` with the workflow graph |
| Poll | `GET /api/v2/jobs/{id}` |
| Bytes | `GET /api/v2/assets/{id}/content` (302 to a signed URL) |
| Cancel | `POST /api/v2/jobs/{id}/cancel` |

**The official `@comfyorg/sdk` is deliberately not used.** It would add this repository's first npm
dependency, and its `client.run()` hides the submit/poll split that lets a multi-minute GPU job
survive a page reload and be cancelled. The raw API is three calls.

Two details from the spec shape the implementation:

- **Cloud answers `204` for every job log**, so a failure is explained from `job.error` —
  `code`, `message`, `node_id` and `class_type` — not from logs.
- **`Idempotency-Key` is single-use and reject-on-duplicate.** One key is minted per submission and
  reused only while retrying that same submission, never regenerated across retries.

## Your workflow

Export from ComfyUI with **Workflow → Export (API)** and save it under `projects/_settings/comfy/`.
An editor export (`nodes`/`links`, `widgets_values`) is refused locally, with the export instructions,
before any request is spent.

```
projects/_settings/comfy/
  workflows.json          the mapping below
  image.workflow.json     your exported API workflow
  video.workflow.json     another one, if you want video
```

```json
{
  "version": 1,
  "default": "image",
  "workflows": {
    "image": { "file": "image.workflow.json", "output": "image" },
    "video": { "file": "video.workflow.json", "output": "video", "uses_api_nodes": true }
  }
}
```

**`prompt_node` is optional.** With exactly one text-encoding node in the graph, the app finds it, so
the smallest working config is a `file` and an `output`. Set it explicitly when the graph has more than
one text encoder — the positive and the negative prompt — because the app refuses to guess between them
rather than risk writing your prompt into the wrong node:

```json
{ "file": "image.workflow.json", "output": "image", "prompt_node": "6", "prompt_field": "text" }
```

- `prompt_field` defaults to `text`.
- `output` is `image` or `video`, and decides which media output is kept.
- `purpose` is `general` (the default) or `text`. Mark the workflow you trust to render words legibly
  as `text` and scenes that are mostly on-screen words are sent there automatically — see below.
- `output_node` picks one output when a workflow saves several. Otherwise the first media output wins
  and the rest are recorded as skipped.
- `uses_api_nodes` must be `true` for a workflow containing partner/API nodes. It is **declared, not
  detected**: the app cannot reliably tell an API node from a custom one, and guessing would either
  withhold a key the workflow needs or send one it does not. When true, the same key is forwarded in
  `extra_data.api_key_comfy_org`.

A node id that is not in the file is refused, and the refusal lists the ids and `class_type`s the file
does contain, so the fix is obvious.

**A config file is not a workflow.** Until the file it names actually exists, the app reports Comfy as
not configured and names the path it is looking for, rather than offering a generation it cannot
deliver.

Nothing here rewrites your file. The prompt is injected into a copy in memory.

## Words on screen

Diffusion models do not spell. They render text as pixels, reproduced from what the model saw during
training, and the failure mode is worst on exactly the strings a technical video is full of: product
names, acronyms and unusual casing — `Dora-rs`, `LeRobot`, `ROS2`. The first human-evaluation
benchmark for on-screen text in video models ([T2VTextBench](https://arxiv.org/abs/2505.04946))
put ten leading systems below 0.4 out of 1, and found the pattern behind it: models memorise text at
the *word* level, so they do well on a single common word and degrade sharply on sentences and on
arbitrary character sequences. A general image model asked for a chart is usually worse still.

Three things follow, and the app does all three.

**1. A workflow can be marked for text.** If your image model is a photorealism model — Z-Image Turbo
and most "turbo" variants are — it is the wrong tool for a scene whose picture is the words. Add a
workflow built on a model known for typography (Qwen-Image is the usual choice among open models):

```json
{
  "version": 1,
  "default": "image",
  "workflows": {
    "image":      { "file": "image.workflow.json", "output": "image", "prompt_node": "67" },
    "typography": { "file": "typography.workflow.json", "output": "image", "purpose": "text", "prompt_node": "6" }
  }
}
```

A scene the app flags as mostly on-screen text is then submitted to `typography` without being asked.
Naming a workflow in the scene panel still overrides it. A workflow marked `text` whose file is missing
is ignored rather than used, so a broken entry cannot turn a working generation into a refusal.

**2. The app will not pretend it checked.** It cannot read text back out of a picture — there is no OCR
anywhere in it — so a generated scene that puts words on screen is recorded as
`generated_text_unverified` in the asset manifest, with the words named, and the final check asks you
to confirm you looked at them. It is a confirmation you make, never a silent pass.

**3. There is one cheap way to find out.** The generate panel for a scene with on-screen text offers
**Generate a test image**. It submits one image whose subject is that scene's own words, sent to the
same workflow the scene would use, and shows you the result. You answer "the words are correct" or
"the words are wrong", and the answer is remembered **against the workflow** — a judgement is about
the model, not about one scene, so every later scene on the same workflow inherits it.

The test image is imported into the library so you can look at it and keep it. It is **never attached
to the scene**: finding out whether a workflow can spell must not change what a scene is made of.

Probes are recorded at `generated/text_probes.json`.


## Generating a scene

On a storyboard scene that has no own media and no local template, the panel offers a workflow, an
editable prompt pre-filled from the storyboard's `generation_prompt`, and **Generate this scene**. The
cost is stated before it is spent; nothing generates on its own.

- Submitting returns a job record immediately. The job runs on the server, so **leaving the page does
  not cancel it** and returning re-attaches to it.
- Progress and a Cancel action appear while it runs. Cancel reaches Comfy, so billed GPU seconds stop.
- On success the output is **imported into the library as `generated`** — your own work, cleared by the
  rights gate, no credit — and attached to the scene through the normal attach path. The scene then has
  `asset_id`, so the assets stage skips it and a re-run costs nothing.
- Import happens **exactly once**: the job record stores the asset id, so a repeated poll cannot
  duplicate it.

Job records live at `generated/comfy_jobs.json` per project.

## Failure modes

| Case | What happens |
|---|---|
| Editor-format workflow | Refused locally, with the export instructions; no request spent |
| `prompt_node` absent | Refused, listing the node ids and `class_type`s present |
| Out of credits (402) | Named as a billing problem, status `402` kept so it is distinguishable |
| Queue full / deployment starting (429) | `Retry-After` honoured; status kept |
| Job `failed` | Comfy's own `code`, `message` and `node_id` reported; nothing imported |
| Job `expired` | Reported as discarded before it finished |
| Only `latent`/`text` outputs | Refused, naming the types returned — the workflow has no save node |
| Polling deadline reached | **The job is cancelled** so it is not left running, then reported |
| Unknown output MIME type | Refused rather than filed under a guessed extension |

## Limits

- **No image input.** Workflows that take an image are out of scope: there is no upload path in v1.
- **No cost estimation.** Comfy publishes no per-run price this app could honestly quote, so it says
  "costs credits" and stops there.
- **A generated clip shorter than its scene is looped** by the composer to fill it, which is visible.
  Generate at the scene length or longer.
- **A generated clip longer than its scene is trimmed.**
- **Text-bearing scenes are a poor fit** unless you mark a text-oriented workflow. The app routes them,
  records the result as unverified, and offers a probe — but it cannot read the picture, so the final
  judgement about spelling is yours.

## Validation

`tests/comfy.test.js` mocks the network at the `providerFetch` seam and asserts the adapter, the
config loader, the per-scene routes and the error mapping — including that the asset-content call is
issued with `redirect: 'manual'` so the API key is never forwarded to the signed-URL host. The happy
path imports a real PNG and attaches it, and a repeated poll is asserted not to import twice. Text
routing is covered end to end: a scene made of words reaches the workflow marked `text`, an explicit
choice overrides it, and a probe is imported but never attached.

`tests/ui-pipeline.test.js` drives the scene control and a full run through the real views in the fake
DOM. **No test performs real HTTP and no test can spend credits.**
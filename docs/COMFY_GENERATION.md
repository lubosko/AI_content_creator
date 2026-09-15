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
    "image": { "file": "image.workflow.json", "output": "image",
               "prompt_node": "6", "prompt_field": "text", "output_node": null },
    "video": { "file": "video.workflow.json", "output": "video",
               "prompt_node": "6", "prompt_field": "text", "output_node": null,
               "uses_api_nodes": true }
  }
}
```

- `prompt_node` is the node id the scene prompt is written into; `prompt_field` defaults to `text`.
  A node id that is not in the file is refused, and the refusal lists the ids and `class_type`s the
  file does contain, so the fix is obvious.
- `output` is `image` or `video`, and decides which media output is kept.
- `output_node` picks one output when a workflow saves several. Otherwise the first media output wins
  and the rest are recorded as skipped.
- `uses_api_nodes` must be `true` for a workflow containing partner/API nodes. It is **declared, not
  detected**: the app cannot reliably tell an API node from a custom one, and guessing would either
  withhold a key the workflow needs or send one it does not. When true, the same key is forwarded in
  `extra_data.api_key_comfy_org`.

Nothing here rewrites your file. The prompt is injected into a copy in memory.

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
- **Text-bearing scenes are a poor fit.** A generator misspells on-screen words; the prompt pack flags
  those scenes and points at the local templates instead.

## Validation

`tests/comfy.test.js` mocks the network at the `providerFetch` seam and asserts the adapter, the
config loader, the per-scene routes and the error mapping — including that the asset-content call is
issued with `redirect: 'manual'` so the API key is never forwarded to the signed-URL host. The happy
path imports a real PNG and attaches it, and a repeated poll is asserted not to import twice.

`tests/ui-pipeline.test.js` drives the scene control and a full run through the real views in the fake
DOM. **No test performs real HTTP and no test can spend credits.**
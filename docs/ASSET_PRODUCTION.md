# Asset Production

Implemented 2026-09-10. This is Phase 5 of [the completion strategy](PROJECT_COMPLETION_STRATEGY.md):
filling the storyboard's gaps with real narration audio and footage for scenes that selected nothing.
The rights gate and the free-licence sources are documented in
[Rights and Licensing](RIGHTS_AND_LICENSING.md).

## What it produces

| Output | Where | Notes |
|---|---|---|
| Narration audio | `generated/audio/NNN-<section>.mp3` | One file per script section, duration measured from the file |
| Narration plan | `generated/audio/narration_plan.json` | Provider, estimate, and per-section status |
| Produced footage | `generated/video/scene-NNN-<scene>.mp4` (or `.jpg` for a still) | Sourced for scenes with no own media |
| Drawn scene | `generated/graphics/scene-NNN-<scene>.mp4` | Silent, drawn locally by a template. See [Scene rendering](SCENE_RENDERING.md) |
| Render provenance | `generated/graphics/render_manifest.json` | Template, file, duration and the signature each drawing was made from |
| Asset manifest | `generated/asset_manifest.json` | Every scene and narration section with its real status, rights record and verdict |
| Asset index | `analyzed/asset_index.json` | Provenance: provider, source URL, author, licence, rights |

Enter the stage from **Assets** once the storyboard is approved. The route is
`POST /api/projects/:folder/assets`.

## Narration

Narration uses OpenAI speech synthesis (`gpt-4o-mini-tts`, voice `alloy`). Set the key in Settings.

- A transcription model cannot speak, so `whisper-1` is **never** sent to the speech endpoint. A
  transcription model in Settings falls back to the speech default rather than making a request that
  must fail.
- Text longer than one request is split on sentence boundaries. A single sentence longer than the
  limit is hard-split, because there is no better boundary.
- **Durations are measured with ffprobe, not estimated.** The composer needs real timings, and an
  estimate would desync the captions.
- A section with no narration text is kept and reported as `empty`. It is not silently skipped: a
  scene with no voice over it is a problem the operator should see.

Cost: about $15 per million characters, so a typical eight-minute script is roughly $0.11. Every
section records its character count, and the plan carries an estimate.

## Drawn scenes

A scene the storyboard assigned a template to is drawn locally before any sourcing is considered: a
chart, a diagram, a terminal or a text card is not something to go looking for footage of, and a
drawing spells the words exactly. `counts.rendered` reports how many, and a drawn scene's rights basis
is `own`. An unchanged drawing from a previous run is reused rather than redrawn, compared by a
signature recorded in `generated/graphics/render_manifest.json`. See
[Scene rendering](SCENE_RENDERING.md).

A template whose data the scene does not contain never reaches this stage. It is resolved when the
plan is written — derived if the scene's own words allow it, otherwise replaced by a text card and
recorded as such — so **the asset stage cannot fail a scene for missing template data**. If it ever
reports *"A bar chart needs data.bars with at least two entries"*, that means someone assigned the
template by hand and has not filled it in yet, which the storyboard already told them.

## Generated scenes and their text

A scene filled by Comfy Cloud is imported as `generated` — your own work, cleared by the rights gate.
One thing about it is not checked and cannot be: **words visible in the picture**. This app has no OCR,
and diffusion models render text as pixels reproduced from training data rather than by spelling, which
fails worst on exactly the strings a technical video is full of — product names, acronyms, unusual
casing.

So the manifest carries the fact rather than a verdict:

- `generated_text_unverified: true` on any generated scene whose `on_screen_text` is not empty, with
  `generated_text_words` naming them.
- `counts.generated_text_unverified`, and a top-level `generated_text_unverified` list of
  `{scene_id, title, words}`.
- A warning that says so in plain words, and a manual item in the
  [final check](RUN_TO_FINAL_CHECK.md) that asks you to confirm you looked at those words — named, so
  the question is answerable.

A scene you shot yourself is never flagged: it carries no generated text. To find out whether a
workflow can spell at all before committing to it, see the text probe in
[Comfy generation](COMFY_GENERATION.md).

## Produced footage

Scenes that selected no own media are filled from the free-licence sources in
[Rights and Licensing](RIGHTS_AND_LICENSING.md), searched with a query cleaned from the scene's
generation prompt.

| Source | Needs a key | Media | Licence handling |
|---|---|---|---|
| Pexels | yes | video | Provider terms permit the use; recorded as `stock_licence` |
| Archive.org | no | video | Resolved per item: licence address, public-domain statement, or public-domain collection |
| Openverse | no | images | Search restricted to `license_type=commercial,modification` |

The sources are tried in order and the first usable result wins: Pexels first (authored, reliably
16:9), then Archive.org, then Openverse stills.

- A landscape HD file is preferred so the clip cuts into a 16:9 timeline without upscaling.
- Archive.org is searched only for items whose licence the app can resolve; items that declare none
  are passed over, and each candidate's reason is recorded.
- A still has no duration. The manifest records `media_kind`, and the composer decides how long it is
  held on screen.
- **Provenance is recorded per clip**: provider, page URL, author, licence and the full rights record.
  A credit-required licence also produces the credit line the export must carry.
- Downloads are size-capped and time-limited. An Archive.org item whose only video files exceed the
  ceiling says so, rather than reporting a vague format problem.

## The rights gate

Every scene that has media carries a rights record and the verdict reached on it. Material with no
recorded basis is blocked: the manifest counts it under `rights_blocked`, the status becomes
`incomplete`, and the render plan refuses. See
[Rights and Licensing](RIGHTS_AND_LICENSING.md) for the model and where it is enforced.

## Honest gaps

Asset production never reports success it did not achieve.

- A source that could not be used is reported with its real reason, not omitted: *"Pexels was not
  searched: No Pexels API key is configured."* The manifest carries a `sourcing` block listing every
  source that was searched and every one that was not.
- **A miss is reported per source, not as one sentence.** A scene that found nothing records
  `sourced_after` — each source that was asked and what it answered — plus the `query` that was tried,
  so the assets screen can list *"Archive.org — searched, no item matched"* separately from
  *"Pexels — not searched: no API key"*. Those are different problems: one you cannot fix by
  searching again, the other is a missing key. Only the "nothing matched" line is styled as a failure;
  a source that was never consulted is a note, because nothing about the scene broke.
- A failed search produces a `failed` record carrying the per-source reasons.
- A failed narration section does not discard the audio already produced.
- Every scene that has media also carries `media: {kind, duration_seconds, width, height}`, so the
  composer is told what kind of file it is holding without resolving the library itself.
- The manifest status is `complete` only when every scene has media, no narration section failed, and
  no scene's rights are blocked. Otherwise it is `incomplete`, and the interface says composition
  stays blocked.
- **Words in a generated picture are recorded as unverified rather than assumed correct**, with the
  words named and a confirmation at the final check. See *Generated scenes and their text* above.

## What is not implemented

- **Comfy Cloud is the one generation provider, and it is on demand.** The assets stage still only does
  narration, local template drawings and free-licence sourcing; it never generates. A scene is sent to
  Comfy when you ask for it from the scene panel, or as step 1 of
  [a run to the final check](RUN_TO_FINAL_CHECK.md). Leonardo and Mootion still have no adapter and no
  key, so for those the prompt pack remains a manual round trip.
- **No still animation.** A still is placed on the timeline as a still. Zoom and pan are not
  implemented.
- **No generated-asset review workflow yet.** Produced assets are recorded and reported, but there is
  no approve/reject/regenerate loop on them. Re-running the stage replaces the manifest and
  re-searches; the previous artifacts are archived under `generated/history`.
- **No music, no sound effects, no voice cloning, no multi-language narration.** Openverse indexes
  audio; nothing consumes it.

## Validation

`tests/production.test.js` covers the speech adapter (chunking without losing text, the transcription
model fallback, cost estimates, error messages) and the stock adapter (query cleaning, HD landscape
preference, an empty result). It then runs the whole creative chain and produces assets with **real
ffmpeg-generated audio** rather than stub bytes, asserting that the measured durations match the real
file lengths, that one scene is produced and one reported as failed with its reason, that provenance
is recorded, and that a run with no providers configured reports what it could not do instead of
failing silently. No paid calls are made.

`tests/sourcing.test.js` covers the free-licence sources and the chain over them with a mocked
network: licence resolution, file selection, the query filters, ordering, and reason reporting. The
suite never touches the real Archive.org or Openverse APIs.
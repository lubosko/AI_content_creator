# Final Check and Platform Exports

Implemented 2026-09-11. This is Phase 7 of [the completion strategy](PROJECT_COMPLETION_STRATEGY.md):
the screens and gates between a rendered video and files ready to upload.

## The final check

`POST /api/projects/:folder/final` writes:

| Output | Where |
|---|---|
| The checklist | `final/final_check.json` |
| The metadata package | `final/youtube_metadata.json` |
| A thumbnail | `final/youtube_thumbnail.jpg`, a real frame at 1280x720 |

The checklist has two kinds of item, and the difference matters:

- **Computed** items are measured against the written file: QC passed, the video is playable, captions
  exist, rights are cleared, the duration is close to the brief's target, and a thumbnail was
  extracted.
- **Manual** items are the ones no check can decide: that the operator watched it, that the facts and
  figures are right, that the title, tone and branding are right, that the captions read correctly,
  and that they are content every source may be used as it is. These report `null`, never `true`.

## The gates

| Gate | Requires |
|---|---|
| `master_video` | QC passed against the written file, the final check has run, every manual item is confirmed **in the approval request**, and the subject fingerprint matches the current video |
| `platform_adaptations` | An export manifest with at least one exported platform, and a matching fingerprint |

The **subject** is a cheap fingerprint — the compose revision, the master's size and its duration. An
approval is recorded against it, so re-rendering the video invalidates an earlier approval instead of
silently inheriting it, and the exports stage refuses to run until the current video is approved.
Publishing an unapproved cut is the one thing this ordering exists to prevent.

There is no publishing stage: nothing here uploads anything.

## The platform exports

`POST /api/projects/:folder/exports` produces:

| Platform | Shape | Limit | Captions |
|---|---|---|---|
| YouTube Shorts | 1080x1920 | 60s | burned in, plus a sidecar |
| TikTok | 1080x1920 | 180s | burned in, plus a sidecar |
| Instagram Reels | 1080x1920 | 90s | burned in, plus a sidecar |
| Facebook Reels | 1080x1920 | 90s | burned in, plus a sidecar |
| Square feed post | 1080x1080 | 90s | sidecar only |

Each gets its own folder under `adaptations/<platform>/` with the video, an `.srt` and a
`metadata.json`, and every file is listed in `adaptations/export_manifest.json` with its size,
dimensions, duration, title and tags. Download links on the Exports screen are ordinary project file
URLs, which support range requests so a player can stream them.

### Reframing keeps the whole frame

Cropping a 16:9 master to 9:16 throws away the sides of every frame, and in a technical video the
sides are where the words are. The full frame is scaled to fit the width and centred over a blurred
enlargement of itself, so nothing is lost and the bars are not dead space. Square versions use the
same approach.

### Which part of the video becomes a short

The script marks sections as `short_form`, and those sections' scenes give the windows for the short:
taking the first seconds of an eight-minute video would be an arbitrary cut. When no section is marked,
the opening scenes are used and the manifest says so in as many words — every export records
`short_source` and a `short_note` explaining where its footage came from.

Captions are **retimed** to the trimmed timeline: a cue inside a kept window shifts by however much was
cut before it, and a cue that spans a cut is dropped rather than left pointing at the wrong moment.

### Burning captions on Windows

Short-form video is watched with captions on, so they are burned in for the vertical exports.
FFmpeg is run from the caption file's own directory and given the bare filename, because a Windows
drive letter inside a filter argument is parsed as an option separator: `subtitles=C:/path/c.srt` fails
with `Unable to parse "original_size"`, and `subtitles=c.srt` with the working directory set does not.

### The metadata is assembled, not written

Each `metadata.json` is built from the project's own brief, script and timeline: the title comes from
the brief, the description lists the script's sections, the tags come from the topic, and the chapters
come from the timeline's scene starts. Every file says so, with:

> Assembled from this project's own brief, script and timeline. Edit before publishing; no model wrote
> this copy.

That distinction is deliberate. It is a starting point that is accurate about its own provenance, not
generated copy presented as finished.

### Credits reach the description

An attribution obligation does not apply to a JSON file nobody reads; it applies to the published
description. So the credits the rights gate collected are carried all the way through: into the
master's metadata package, into every platform's `metadata.json`, and onto the exports screen above
the upload buttons. The manifest states the position either way:

```json
"credits": ["\"Robotics lab\" by Jane Doe — CC BY 4.0 — https://example.com/clip"],
"credit_note": "These attributions are required by the licences of material used in this video.
                They are already in every platform description; keep them there."
```

A project drawn and narrated entirely from its own material gets `"credits": []` and the note *every
asset in this video is owned, commissioned or generated, so no attribution is required* — the absence
is stated rather than left ambiguous. When credits exist they appear under a `Credits:` heading, and
the space they need is subtracted from the body's budget *before* the description is trimmed, so a
platform's character limit can never quietly delete the one part a licence obliges you to publish.
Each credit is itself capped at 300 characters.

If the required credits alone exceed a platform's description limit — many long CC BY credits on a
short-form caption of 2,200 characters, say — then something has to give, and the export says so
rather than pretending otherwise: `credits_truncated: true` is set and the exports screen warns that
the credits do not fit and belong in the first comment. Three field-name-plus-link credits on one
video never come close to that.

## Limits

- **Two shapes only**: 9:16 and 1:1. No 4:5, no 16:9 variants, no per-platform safe-area guides.
- **The same cut for every platform.** The duration limit differs; the choice of scenes is the same.
- **Nothing is uploaded.** Downloads are local files.
- **Caption timing is estimated** as described in [the composer](COMPOSER_AND_QC.md), and burning a
  wrong cue makes it permanent in that file, which is why the sidecar is always written too.
- **No per-platform thumbnail.** The master's thumbnail is shared.

## Validation

`tests/exports.test.js` builds a project around a real 8-second master and asserts the gates rather
than the screens: exports refused before approval, refused without the manual confirmations, refused
for a different video's fingerprint, then succeeding — and after a re-render, refused again. It probes
every exported file with `ffprobe` for shape and duration, checks the short came from the `short_form`
section and that the other section's caption was dropped, and downloads a file twice, once with a
range request, asserting the MP4 signature. Its fixture carries one CC BY asset, so it also asserts the
credit reaches the master metadata, all five platform descriptions and the manifest. The walkthrough
covers the opposite case: a project with no borrowed material must report `credits: []` and no
`Credits:` heading.

`tests/ui-delivery.test.js` drives the three screens in the fake DOM: the composer's QC report, the
final checklist with its confirmations holding the approval button disabled until every box is ticked,
and the exports list with its download links.

`tests/walkthrough.test.js` runs the whole pipeline and ends by downloading an export.
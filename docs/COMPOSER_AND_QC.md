# The Composer and QC

Implemented 2026-09-11. This is Phase 6 of [the completion strategy](PROJECT_COMPLETION_STRATEGY.md):
the stage that finally produces a video, and the inspection that decides whether it may be approved.

## What it produces

| Output | Where | Notes |
|---|---|---|
| The master | `final/youtube_master.mp4` | 1920x1080, 24 fps, h264 crf 18, AAC 192k, faststart |
| Timeline | `compose/timeline.json` | Three tracks: visuals, narration, captions. No absolute paths |
| Captions | `compose/captions.srt` | A sidecar file, so a player can toggle them |
| QC report | `qc/qc_report.json`, `qc/qc_report.md` | Every check, measured against the written file |
| Render log | `compose/render_log.json` | Every command the composer ran, in order |

Enter it from **Composer** once assets are produced. The route is `POST /api/projects/:folder/render`.

## How a video is assembled

1. **Plan the timeline** from the storyboard, the script and the asset manifest. A scene is filled by
   its own library media, by a drawn graphic, or by a sourced clip; a scene with nothing gets a
   placeholder card naming the gap, and QC blocks the result either way.
2. **Normalise each scene into a segment**: scaled to fit the frame, padded with black to 16:9, pinned
   to 24 fps, silent. A clip shorter than its scene is looped; a still gets a slow 10% zoom.
3. **Build a matching audio segment** per scene: the narration sliced to that scene, padded to its
   length, 48 kHz stereo.
4. **Join the segments** with the concat demuxer, then lay the audio underneath with
   `loudnorm=I=-16:TP=-1.5:LRA=11`.

Segments are normalised first rather than assembled in one filter graph. A single graph over a dozen
mixed sources of unknown codec is where this kind of pipeline usually fails, and when it fails it
names no scene. A failed render keeps `compose/segments/` so the broken file can be inspected.

### One narration file, several scenes

A script section is narrated once, but a storyboard often gives it more than one scene: the project
this was built against has **14 scenes across 8 sections**. Each section's audio is therefore split
across its scenes in proportion to their durations, and each scene's slice is recorded as
`audio_offset_seconds` and `audio_span_seconds`.

Without that split every scene carrying a section would replay the whole section, and the video would
narrate itself twice. The captions follow the same split, so a section is captioned once and each
scene's window gets its share of the words.

### Captions

The narration is synthesized per section, so the only timing known is the measured length of each
audio file. Cue timing is therefore **estimated**: a section's duration is divided across its scenes
by scene length, and inside a scene by text length. That is stated in the timeline, in the QC report
and in the [scene rendering](SCENE_RENDERING.md) documentation. The alternative is paying to
transcribe audio this app just generated, which would re-derive the timings less accurately than the
script text already in hand.

## QC: the gate on the video

Every check is made against the file that was written, never against the plan that was supposed to
produce it. A check that cannot be measured reports `unknown` with the reason rather than passing
quietly.

| Check | What it measures | Blocks |
|---|---|---|
| `scenes_have_media` | Every scene resolved to a file | yes |
| `rights_cleared` | The manifest's own rights verdict | yes |
| `master_exists` | The file exists and is not empty | yes |
| `master_readable` | ffprobe can read it back | yes |
| `duration_matches_plan` | Within one second of the planned timeline | yes |
| `resolution` | Exactly the planned width and height | yes |
| `frame_rate` | Within half a frame of the target | yes |
| `has_audio` | An audio stream, when narration was produced | yes |
| `caption_timing` | Cues in order, not overlapping, inside the video | yes |
| `script_coverage` | Every script section appears in the video | yes |
| `black_frames` | No unexplained black stretch | over 3 seconds |
| `loudness` | Integrated loudness in -24 to -8 LUFS | yes |

The verdict is written to the project as `qc_passed` or `qc_failed`, and it is what the approval gate
reads. A failed QC still saves its report: the operator sees why.

### The black-frame threshold is deliberately low

`blackdetect`'s default luma threshold of 0.10 flags a deliberately dark picture. The scene templates
use a near-black background at roughly 0.05 luma, so a dark-themed video was being reported as blank
the first time the walkthrough ran end to end. The threshold here is 0.02 with a 98% pixel ratio:
low enough to mean "no picture at all", which is what a failed render produces, and a deliberate dark
theme passes.

## What is honest about the transaction

The master is a binary file, so it is written directly rather than through the text transaction the
stage engine uses for artifacts. The QC report, timeline, captions and render log all do ride that
transaction, which means they are archived under `compose/history/` and rolled back together.

A render that finishes while the project has changed underneath it is refused by the engine, so no QC
report is written for it. The orphaned master is overwritten by the next render, and without a report
there is nothing for the approval gate to read. Re-running the composer on an unchanged project is
stable.

## Limits

- **No cross-scene transitions.** Scenes cut hard from one to the next.
- **No music or sound effects.** The only audio is the narration.
- **No still animation beyond a slow zoom.**
- **One output format.** 16:9 at 1080p; the platform versions come from the exports stage.
- **Rendering is linear in duration.** The walkthrough's 14-second master composes in a few seconds;
  a long video takes proportionally longer, and the whole thing runs inside one HTTP request.
- **Approval is not publishing.** Nothing here uploads anything.

## Validation

`tests/compose.test.js` composes a project with three scenes and two sections, one of them spanning
two scenes, and asserts the real master with `ffprobe`: codec, resolution, frame rate, duration and an
audio stream. It checks that the shared section's audio is split rather than repeated, that the
captions are captioned once, that the QC report carries every check with no blocking issues, that
every FFmpeg command is logged, and that the working segments are cleaned up.

`tests/walkthrough.test.js` runs the whole pipeline from a prompt and asserts a playable master and
five platform exports at the end. See [Exports](EXPORTS.md).
# Material Analysis

Implemented 2026-09-10. This is Phase 1 of [the completion strategy](PROJECT_COMPLETION_STRATEGY.md):
analysis for text, documents and media. Import still never implies analysis.

> Update, 2026-09-10 (Phase 2): speech transcription and PDF text extraction are implemented. See
> **Speech transcription** and **PDF** below. OCR is still not implemented.

## What analysis does today

| Item | What is extracted | State |
|---|---|---|
| Note | The written text | analyzed |
| Text file (`.txt`, `.md`, `.csv`, `.json`, `.log`, `.srt`, `.vtt`, `.yml`) | Up to 20,000 characters, with a truncation note | analyzed |
| URL reference | Page fetched and converted to text, with the page title | analyzed |
| **PDF with a text layer** | Up to 20,000 characters, page count and document title | analyzed |
| Image (PNG, JPEG, GIF, BMP) | Width, height, aspect ratio, size | analyzed |
| Video and audio | Container, duration, bitrate, resolution, codecs, frame rate, sample rate, plus a preview frame | analyzed |
| **Video and audio with speech** | The above, plus a transcript with timings and a WebVTT subtitle file | analyzed, or needs_confirmation |
| PDF with no text layer (a scan) | Nothing | failed, OCR required |
| DOCX, XLSX, PPTX and other ZIP containers | Nothing | unsupported |
| SVG, fonts | Nothing. Brand files are stored as-is. | unsupported |
| A file with a text name but binary contents | Nothing | failed |
| A corrupt or unreadable media file | Nothing | failed |

## Speech transcription

Transcription turns speech into text, which is what research and captions need. The provider sits
behind an adapter, so the workflow never speaks HTTP to a vendor directly.

Configure an OpenAI API key in Settings. The model defaults to `whisper-1` and follows
`OPENAI_MODEL` when set. Without a key, audio is still probed for metadata, and the card says that no
transcription provider is configured rather than implying the audio was silent.

How a file is prepared:

1. The audio track is re-encoded to 16 kHz mono FLAC, so a 100 MB video becomes a small upload.
2. If that would still exceed the 25 MB per-request limit, it is split into time-ranged parts and
   each part is transcribed separately.
3. Part timings are shifted by their start offset and stitched into one transcript.
4. The prepared audio is deleted afterwards. It is an intermediate, not your material.

The transcript text becomes the item's extracted text, so research and the script can use it. A
WebVTT subtitle file is built from the same timings for the composer to reuse later.

### Cost

Transcription is billed per minute, so **anything longer than 10 minutes asks first.** The card shows
the duration and an estimated cost, and the confirmation dialog repeats both before anything is sent.
Cancelling spends nothing and changes nothing. A bulk **Analyze N item(s)** sweep deliberately skips
items awaiting confirmation, so a sweep can never spend your money on its own.

The estimate uses the provider's published per-minute rate and is shown to two decimal places. It is
an estimate, not a quote.

## PDF

PDFs are parsed with no dependency: streams are located, inflated with zlib, and the text operators
are read directly. A PDF with a real text layer yields its text, page count and title.

A scanned or image-only PDF has no text layer. That is reported as a failure stating that OCR is
required, and it is marked **not retryable**, because retrying cannot produce text that is not there.
OCR is not implemented.

## States

`awaiting_analysis`, `analyzing`, `analyzed`, `failed`, `unsupported`, `needs_confirmation`.

- Every outcome carries a reason a person can act on.
- `failed` distinguishes a **retryable** failure (a missing tool, an unreachable page) from one that
  is a property of the file (binary contents behind a `.txt` name, a scanned PDF). Only retryable
  failures offer Retry, and only retryable failures are picked up by a bulk sweep, so a sweep always
  terminates.
- An unsupported item is never reported as a failure and never as analyzed.
- A transcription failure is **not** an analysis failure: the metadata already read is kept, and the
  transcription problem is stated separately.
- `needs_confirmation` is neither success nor failure: the metadata is real, and only the paid step
  is waiting.

## Use

Open a project, go to **Own material**, and use **Analyze** on a card, or **Analyze N item(s)** to
sweep everything that still needs it. Analysis never modifies or deletes the original file. Results
are written to the asset's own metadata, so a card shows its real state after a reload.

Importing a file selects it for the project but does not analyze it.

## What reaches research

Research is grounded in **what analysis actually read**, and nothing else. Every item marked **Use**
contributes its extracted text, whatever category it sits in: a transcribed interview is content even
though the footage is stored as `media`.

An item that produced no text is reported to the research request with its real reason, rather than
being silently dropped or leaking raw content:

| Item state | What happens |
|---|---|
| analyzed, with text | its text is included and tagged `source: analysis` |
| unsupported, failed, or awaiting confirmation | excluded, with the recorded reason |
| analyzed but produced no text | excluded |
| not analyzed yet (a note or a URL) | excluded, telling you to analyze it first |

There is no category filter, so re-tagging an item is never needed to make its content count. The
total context is capped at 30,000 characters, and anything dropped past the cap says
"Material context limit reached".

Analyzing is therefore the step that makes your material count. An unanalyzed note contributes
nothing, which is intentional: research should not cite material nobody has read.

## URLs and safety

Fetching a stored URL is a local server action, so private addresses are refused: `localhost`,
`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `.local`,
`.internal`, and IPv6 loopback and unique-local ranges. A public URL that redirects into a private
address is also refused. Only `http` and `https` are fetched, only text, JSON or XML bodies are
kept, responses are capped at 2 MB, and the request times out after 15 seconds.

## Limits

- File text: 20,000 characters, read from at most the first 256 KB.
- PDF text: 20,000 characters, from at most 24 MB of inflated stream data.
- Page text: 20,000 characters, from at most the first 2 MB of the response.
- Preview frames are extracted one second into a video. A clip shorter than that gets no frame.
- Audio is prepared as 16 kHz mono FLAC and split only when one request would exceed 25 MB.
- OCR is not implemented, so a scanned PDF or an image containing text yields no text.
- Analysis runs one item at a time; there is no background queue yet.

## API

```text
POST /api/library/:id/analyze           analyze one item; body {confirm_long: true} agrees to the
                                        paid transcription of a long file
POST /api/library/analyze-pending       analyze everything awaiting or retryably failed; never
                                        transcribes long audio, because that costs money
GET  /api/library/:id/analysis          the stored record and summary
GET  /api/library/:id/thumbnail         the extracted preview frame, when one exists
GET  /api/settings                      includes a `transcription` block: provider, model,
                                        configured state and the confirmation threshold
```

## Validation

`npm.cmd test` includes `tests/analysis.test.js` and `tests/transcribe.test.js`, which use real files,
real ffprobe output and real generated media: detection including an extension that lies about its
contents, text extraction and truncation, binary-content detection, image dimensions read from real
PNG and JPEG headers, generated video clips for resolution, codecs, duration and preview frames, a
silent clip, an unreadable media file, a real PDF with a deflated text layer, a real image-only PDF,
URL fetching with HTML stripping and script removal, every SSRF guard, the sweep's termination
behaviour, transcription part stitching and WebVTT output, provider error mapping, and the
"ask before spending" gate that asserts the provider is not called before confirmation. Provider
calls are mocked: no network requests are made and no paid calls are used. The real-browser test
drives the confirmation dialog and cancels it, verifying that nothing is spent.
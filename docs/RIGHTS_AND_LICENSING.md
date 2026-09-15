# Rights and Licensing

Implemented 2026-09-10 alongside Phase 5. Any material that reaches a rendered video must have a
recorded basis for using it, and the pipeline refuses to render material that does not.

**This is not legal advice.** The app encodes the constraints the common licences impose and refuses
to guess at the ones it cannot resolve. It cannot verify that a licence claim made by someone else is
accurate, and it does not try.

## Why it exists

The tempting shortcut for B-roll is other people's YouTube footage. It is also the fastest way to
lose a channel:

- YouTube's Terms of Service forbid downloading or reproducing content except as the service allows
  or with the rights holder's written permission.
- Content ID scans an upload on arrival. A claim takes the revenue from a video; a strike puts the
  channel one step from deletion.
- Reusing footage as background in your own video is not commentary or critique, so it is the
  fact pattern where a fair-use argument is weakest.

The practical alternative is not "no footage". It is footage whose licence is known: your own
recordings, public domain and Creative Commons archives, and stock libraries. That is what this app
sources, and the gate is what keeps the difference from being lost.

## The licence vocabulary

`src/lib/licensing.js` is the single source of truth. Every entry carries the four facts that matter
for cutting material into a monetised video.

| Basis | Commercial | Editing | Credit | Notes |
|---|---|---|---|---|
| `own` | yes | yes | no | Your own recording or artwork |
| `permission` | yes | yes | no | Written permission; who granted it and how it was given are required |
| `cc0` | yes | yes | no | Public domain dedication |
| `public_domain` | yes | yes | no | Copyright expired, or stated as public domain |
| `cc_by` | yes | yes | **yes** | Credit and a link to the original are required |
| `cc_by_sa` | yes | yes | **yes** | ShareAlike: the finished video must carry the same licence |
| `cc_by_nc` | **no** | yes | yes | NonCommercial: a monetised video cannot use it |
| `cc_by_nd` | yes | **no** | yes | NoDerivatives: it cannot be trimmed into your video |
| `cc_by_nc_sa` | **no** | yes | yes | |
| `cc_by_nc_nd` | **no** | **no** | yes | |
| `stock_licence` | yes | yes | no | Pexels and similar: the provider terms permit this use |
| `generated` | yes | yes | no | AI-generated output you made on your own account. Treated as your own work: the provider assigns the output to the account holder, so there is nothing to clear and nothing to credit |
| `unknown` | **no** | **no** | – | Not confirmed, so not usable |

An unrecognised licence string from any source maps to `unknown`, which blocks. A licence this code
has never seen can never be treated as permission.

### Material this app produced itself

Two kinds of material carry no third-party licence at all, and both are cleared:

- **A scene drawn locally** by a template is recorded as `own`, because it is this app rendering the
  project's own script text. It needs no credit and blocks nothing.
- **A file you generated with an AI tool** is recorded as `generated`, and is treated as your own work
  on the same footing as `own`. You were the account holder when the output was produced, and the
  vendors in play assign that output to you: Anthropic's Commercial Terms say the customer *owns its
  Outputs* and that Anthropic *assigns to Customer its right, title and interest (if any) in and to
  Outputs* ([Commercial Terms](https://www.anthropic.com/legal/commercial-terms), § B). There is no
  third-party right to clear, so the verdict is `cleared`, no credit is generated and nothing has to be
  declared.

The tool and the terms you relied on can still be recorded. They are **provenance, not a condition of
use**: they land in `analyzed/asset_index.json` and the scene's attachment record, and the rights form
labels them optional. An earlier version of this app demanded both and returned a `warning`; it was
asking you to restate terms it could not read, which is a nudge rather than a check, and it is gone.

Two caveats worth knowing, neither of which the gate can act on for you:

- **A free tier is not the same as a subscription.** The assignment above is the paid terms. If you
  generated something on a free plan, or with a tool that does not assign output, record that in the
  note field yourself.
- **Ownership and copyrightability are different questions.** Holding the output does not by itself
  make it copyrightable subject matter in every jurisdiction. That affects what you can enforce
  against someone else, not whether you may publish your own video, so the gate clears it either way.

Because a paid aggregator sits between you and the model vendor, a reseller's "you retain ownership"
cannot grant more than the upstream licensor permits. If you rely on one, the note field is the place
to say which provider it was — which is exactly why the field is kept.

## What is gated

The gate covers material that can reach the video — the same test the storyboard catalogue uses, so
the two cannot disagree:

| Item | Gated | Why |
|---|---|---|
| A video, image or audio file | **yes** | It can be cut into the timeline |
| Anything filed under the `media` or `brand` category | **yes** | You filed it for the video or the director |
| A note, URL reference, text file or PDF in `knowledge` | no | It is read for research and informs the script; it is never published |

Reading a public page and writing about it is not copying it into a video, so demanding a "licence"
for a URL would be meaningless — and a gate people learn to click through is worse than no gate at
all. Filing an item as `media` moves it into the gate.

## The gate

`assessRights()` returns one of three verdicts for a single item:

- **cleared** — usable, nothing further required.
- **warning** — usable, but something must appear in the finished work: a credit, or a matching
  licence under ShareAlike.
- **blocked** — must not reach a render, with the reason stated.

`rightsGate()` runs it across everything headed for the video and returns `can_render`, the credits
the export must carry, and the blocked list. **The composer and the QC report both read
`can_render`, so they cannot disagree about whether material may be used.**

It is enforced in four places:

1. **Confirming material** (`materials-confirm`) refuses with 409 when a gated item marked Use has no
   recorded basis. Confirming is what lets material into research, the storyboard and eventually a
   render, so it is the right place to stop.
2. **The storyboard catalogue** withholds un-cleared own media entirely, so the director cannot
   choose it. The withheld items and the reason are recorded in `storyboard/storyboard.json`.
3. **The asset manifest** records each scene's rights record and the verdict that was reached, and
   counts `rights_blocked`. A blocked scene makes the manifest `incomplete`.
4. **The render plan** re-judges every scene from the manifest rather than trusting the earlier
   stage, and blocks QC with the reason. A hand-edited or older manifest cannot slip unlicensed
   footage through.

## Attribution

Creative Commons requires the licence and a link to the material. It requires crediting the creator
**only if the licensor supplied one**, so:

- A creator name is recorded when the source provided it, and named in the credit.
- When no creator was supplied, the credit names the work and links to the original. An identity is
  never invented.
- A credit-required licence with **no source address** is blocked, because the credit could not be
  honoured.

Credits are collected in the asset manifest, the render plan and the QC report. Phase 7 writes them
into the export metadata.

## Free-licence sources

| Source | Needs a key | Media | Licence handling |
|---|---|---|---|
| Pexels | yes | video | Provider terms permit the use; recorded as `stock_licence` |
| Archive.org | no | video | Resolved per item: licence address, a public-domain statement, or a public-domain collection |
| Openverse | no | images | Search restricted to `license_type=commercial,modification` |

Sources are tried in order and the first usable result wins. A source that could not be used is
reported with its real reason, so a scene without media explains itself:

- Archive.org items that record no licence are passed over, and the reason is recorded per candidate.
- The Archive.org search is restricted to items that declare a licence or sit in a public-domain
  collection. Without that filter most of the archive is offered and then refused.
- Openverse indexes images and audio, not video, so its results become stills the composer holds on
  screen for the length of a scene.

## Limits worth knowing

- **Archive.org licences are self-declared by uploaders.** The app records what the item claims; it
  cannot verify it. Items re-uploaded from elsewhere are the least reliable.
- **ShareAlike is a real obligation.** A video using CC BY-SA material must itself be published under
  CC BY-SA. The app warns; the decision is yours.
- **NonCommercial material is blocked outright** for a monetised project. Follow your actual purpose:
  a non-monetised edit can pass `{commercial: false}` to the gate.
- **The app cannot tell you whether your use is fair use.** That is a fact-specific legal judgement,
  not a feature.
- **No music is sourced yet.** Openverse indexes audio; nothing consumes it.

## Validation

`tests/sourcing.test.js` covers licence resolution (address, statement, collection, and silence),
file selection and its failure reasons, the Openverse commercial-and-modification filter, the chain's
ordering and reason reporting, and the shared downloader's size ceiling. `tests/server.test.js` and
`tests/intake.test.js` assert that an unrecorded basis is refused and that a recorded one passes, and
`tests/ui-browser.test.js` drives the rights dialog in a real browser. All provider calls in tests are
mocked.
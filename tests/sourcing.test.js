'use strict';
/* The free-licence media sources and the chain over them. Every network call is mocked: no real
   search is made and nothing is downloaded from the internet here. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const archive = require('../src/providers/archive');
const openverse = require('../src/providers/openverse');
const {createSourcing} = require('../src/lib/mediaSourcing');
const licensing = require('../src/lib/licensing');

function jsonResponse(payload) { return {ok: true, status: 200, json: async () => payload, headers: {get: () => null}}; }
function textResponse(body, status) { return {ok: false, status, headers: {get: () => null}}; }

async function testArchiveLicences() {
  // A licence address on the item is authoritative.
  const byUrl = archive.rightsFor({metadata: {identifier: 'clip-1', title: 'Orchard', creator: 'A Grower', licenseurl: 'https://creativecommons.org/licenses/by/4.0/'}});
  assert.equal(byUrl.basis, 'cc_by');
  assert.equal(byUrl.title, 'Orchard');
  assert.equal(byUrl.holder, 'A Grower');
  assert.match(byUrl.source_url, /archive\.org\/download\/clip-1/);

  const nc = archive.rightsFor({metadata: {identifier: 'clip-2', licenseurl: 'https://creativecommons.org/licenses/by-nc/4.0/'}});
  assert.equal(nc.basis, 'cc_by_nc');
  assert.equal(licensing.assessRights(nc).state, 'blocked', 'A non-commercial item must be blocked by the gate');

  // A public-domain statement is usable even without a licence address.
  const stated = archive.rightsFor({metadata: {identifier: 'clip-3', rights: 'Public Domain'}});
  assert.equal(stated.basis, 'public_domain');

  // A public-domain collection is the fallback when the item says nothing at all.
  const collection = archive.rightsFor({metadata: {identifier: 'clip-4', collection: ['prelinger']}});
  assert.equal(collection.basis, 'public_domain');

  // Silence is not permission.
  assert.equal(archive.rightsFor({metadata: {identifier: 'clip-5'}}), null, 'An item that records no licence must be refused');
  assert.equal(archive.rightsFor({metadata: {identifier: 'clip-6', licenseurl: 'https://example.com/our-terms'}}), null, 'An unrecognised licence must be refused, not assumed');

  /* A Creative Commons licence obliges you to credit a creator the licensor actually supplied. An
     item with no creator is usable, as long as the credit links to the original. */
  const thin = archive.rightsFor({metadata: {identifier: 'clip-7', title: 'Thin', licenseurl: 'https://creativecommons.org/licenses/by/4.0/'}});
  const thinVerdict = licensing.assessRights(thin);
  assert.equal(thinVerdict.state, 'warning', 'CC BY with no creator supplied must still be usable');
  assert.match(thinVerdict.attribution, /archive\.org\/download\/clip-7/, 'The credit must link to the item page');
  assert.match(thinVerdict.warnings.join(' '), /no creator name/);

  // A credit-required licence with nowhere to point cannot be honoured, so it is blocked.
  assert.equal(licensing.assessRights({basis: 'cc_by', title: 'Orphan'}).state, 'blocked', 'CC BY without a source address must be blocked');
  assert.equal(licensing.assessRights({basis: 'cc_by', title: 'Orphan', holder: 'Someone'}).state, 'blocked');
  console.log('  archive licence resolution: address, statement, collection, and silence all handled');
}

async function testArchiveFileChoice() {
  const files = {files: [
    {name: 'movie.ogv', size: '900000000', length: '120'},
    {name: 'movie.mp4', size: '50000000', length: '95'},
    {name: 'thumb.jpg', size: '4000'},
    {name: 'movie.mpg', size: '8000000', length: '95'}
  ]};
  const chosen = archive.pickVideoFile(files);
  assert.equal(chosen.name, 'movie.mp4', 'mp4 must win, and an oversized file must not be chosen');
  assert.equal(chosen.length, 95);

  assert.equal(archive.pickVideoFile({files: [{name: 'poster.png', size: '900'}]}), null, 'A still is not a video file');
  assert.equal(archive.pickVideoFile({}), null);

  // The reason a file could not be chosen must distinguish the two problems an operator can have.
  assert.equal(archive.fileReason({files: [{name: 'poster.png', size: '900'}]}), 'the item has no downloadable video file');
  assert.equal(archive.fileReason({files: [{name: 'huge.mp4', size: String(5 * 1024 * 1024 * 1024)}]}), 'every video file is larger than the 200 MB download ceiling');
  assert.equal(archive.fileReason({files: [{name: 'movie.mp4', size: '1000'}]}), 'no video file in a usable format');

  const url = archive.downloadUrl('some item', 'sub dir/movie.mp4');
  assert.match(url, /^https:\/\/archive\.org\/download\/some%20item\/sub%20dir\/movie\.mp4$/);
  console.log('  archive file selection: mp4 preference, size ceiling, stills rejected');
}

async function testArchiveSearch() {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.indexOf('advancedsearch') >= 0) return jsonResponse({response: {docs: [{identifier: 'silent'}, {identifier: 'licensed'}]}});
    if (url.indexOf('/metadata/silent') >= 0) return jsonResponse({metadata: {identifier: 'silent', title: 'Silent'}, files: [{name: 'a.mp4', size: '1000', length: '30'}]});
    if (url.indexOf('/metadata/licensed') >= 0) return jsonResponse({metadata: {identifier: 'licensed', title: 'Licensed', creator: 'Someone', licenseurl: 'https://creativecommons.org/licenses/by-sa/4.0/'}, files: [{name: 'b.mp4', size: '2000', length: '44'}]});
    throw new Error('unexpected request ' + url);
  };
  const found = await archive.searchVideo({query: 'orchard pruning', fetchImpl});
  assert.equal(found.ok, true);
  assert.equal(found.clip.provider_id, 'licensed', 'An item with no licence must be passed over, not used');
  assert.equal(found.clip.rights.basis, 'cc_by_sa');
  assert.equal(found.clip.media_kind, 'video');
  assert.equal(found.clip.extension, 'mp4');
  assert.equal(found.clip.attribution_required, true);
  assert.equal(found.clip.skipped.length, 1, 'The item that was passed over must be reported');
  assert.match(found.clip.skipped[0].reason, /does not record a licence/);
  // Without this filter most of the archive is offered and then refused for having no licence.
  assert.match(requested[0], /licenseurl/, 'The search must ask only for items that declare a licence');

  // Nothing usable at all: the reason must name the real cause.
  const none = await archive.searchVideo({query: 'anything', fetchImpl: async (url) => url.indexOf('advancedsearch') >= 0
    ? jsonResponse({response: {docs: [{identifier: 'silent'}]}})
    : jsonResponse({metadata: {identifier: 'silent'}, files: [{name: 'a.mp4', size: '1000'}]})});
  assert.equal(none.ok, false);
  assert.match(none.reason, /recorded licence/);

  const empty = await archive.searchVideo({query: 'anything', fetchImpl: async () => jsonResponse({response: {docs: []}})});
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /No Archive\.org item matched/);

  const limited = await archive.searchVideo({query: 'x', fetchImpl: async () => textResponse('', 429)});
  assert.equal(limited.ok, false);
  assert.equal(limited.retryable, true, 'A rate limit is retryable; the sweep must know the difference');

  const search = requested[0];
  assert.match(search, /mediatype%3Amovies/, 'The search must be limited to moving images');
  assert.match(search, /output=json/);
  console.log('  archive search: skips unlicensed items, reports why, maps rate limits');
}

async function testOpenverse() {
  const empty = await openverse.searchImage({query: 'x', fetchImpl: async () => textResponse('', 429)});
  assert.equal(empty.ok, false);
  assert.equal(empty.retryable, true);
  assert.match(empty.reason, /rate-limited anonymous searches/, 'The rate-limit message must say how to raise the limit');

  const results = {results: [
    {id: '1', title: 'Portrait', creator: 'A', license: 'by', license_url: 'https://creativecommons.org/licenses/by/4.0/', foreign_landing_url: 'https://example.com/portrait', url: 'https://example.com/portrait.jpg', width: 800, height: 1600, filetype: 'jpg'},
    {id: '2', title: 'Wide orchard', creator: 'B', license: 'by-sa', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', foreign_landing_url: 'https://example.com/orchard', url: 'https://example.com/orchard.jpg', width: 1920, height: 1080, filetype: 'jpg'},
    {id: '3', title: 'Unrecognised', creator: 'C', license: 'bespoke-terms', url: 'https://example.com/odd.jpg', width: 2000, height: 1000, filetype: 'jpg'}
  ]};
  let requestedUrl = null;
  const found = await openverse.searchImage({query: 'orchard rows', fetchImpl: async (url) => { requestedUrl = url; return jsonResponse(results); }});
  assert.equal(found.ok, true);
  assert.equal(found.clip.provider_id, '2', 'A landscape image wide enough for 16:9 must be preferred over a portrait one');
  assert.equal(found.clip.media_kind, 'image');
  assert.equal(found.clip.extension, 'jpg');
  assert.equal(found.clip.duration_seconds, null, 'A still has no duration; the composer decides how long it is held');
  assert.equal(found.clip.rights.basis, 'cc_by_sa');
  assert.match(requestedUrl, /license_type=commercial%2Cmodification/, 'The search must ask only for licences that permit commercial use and modification');
  assert.match(requestedUrl, /mature=false/);

  const attributed = licensing.assessRights(found.clip.rights);
  assert.equal(attributed.state, 'warning');
  assert.match(attributed.attribution, /Wide orchard/);
  assert.match(attributed.attribution, /creativecommons\.org\/licenses\/by-sa/);

  // A result whose licence is not recognised must not become usable material.
  const odd = await openverse.searchImage({query: 'x', fetchImpl: async () => jsonResponse({results: [results.results[2]]})});
  assert.equal(odd.ok, false);
  assert.match(odd.reason, /did not record a licence/);

  const unknownLicenceImage = openverse.rightsFor({license: 'bespoke-terms', url: 'https://e.com/a.jpg'});
  assert.equal(unknownLicenceImage, null);
  console.log('  openverse: commercial+modification filter, landscape preference, unknown licence refused');
}

async function testChain() {
  const calls = [];
  const source = (id, outcome) => ({id, short: id, search: async ({query}) => { calls.push(id + ':' + query); return typeof outcome === 'function' ? outcome() : outcome; }, download: async () => ({path: 'x', bytes: 1})});

  const winner = await createSourcing({sources: [
    source('first', {ok: false, reason: 'nothing matched'}),
    source('second', {ok: true, clip: {provider: 'second', url: 'https://e.com/a.mp4', media_kind: 'video', rights: {basis: 'public_domain', source_url: 'https://e.com/a'}}}),
    source('third', {ok: true, clip: {}})
  ]}).search({query: 'orchard'});
  assert.equal(winner.ok, true);
  assert.equal(winner.provider, 'second', 'The first source that can deliver must win');
  assert.deepEqual(calls, ['first:orchard', 'second:orchard'], 'Sources after the winner must not be asked');
  assert.equal(winner.attempts.length, 1);
  assert.equal(winner.attempts[0].reason, 'nothing matched');

  calls.length = 0;
  const allFailed = await createSourcing({sources: [
    source('a', {ok: false, reason: 'no key'}),
    source('b', {ok: false, reason: 'timed out', retryable: true})
  ]}).search({query: 'q'});
  assert.equal(allFailed.ok, false);
  assert.equal(allFailed.retryable, true, 'A retryable failure anywhere must keep the scene retryable');
  assert.match(allFailed.reason, /a: no key/);
  assert.match(allFailed.reason, /b: timed out/);

  // A throw inside one source must not stop the chain.
  const resilient = await createSourcing({sources: [
    {id: 'boom', short: 'Boom', search: async () => { throw new Error('upstream exploded'); }},
    source('ok', {ok: true, clip: {provider: 'ok', rights: {basis: 'public_domain'}}})
  ]}).search({query: 'q'});
  assert.equal(resilient.ok, true);
  assert.equal(resilient.attempts[0].reason, 'upstream exploded');

  const described = createSourcing({sources: [source('ready', {ok: true, clip: {}})], unavailable: [{id: 'pexels', short: 'Pexels', reason: 'No Pexels API key is configured.'}]}).describe();
  assert.deepEqual(described.ready, true);
  assert.deepEqual(described.sources.map(item => item.id), ['ready']);
  assert.equal(described.unavailable[0].reason, 'No Pexels API key is configured.');

  const nothing = await createSourcing({sources: [], unavailable: [{id: 'pexels', short: 'Pexels', reason: 'No Pexels API key is configured.'}]}).search({query: 'q'});
  assert.equal(nothing.ok, false);
  assert.match(nothing.reason, /No Pexels API key is configured/, 'With no source at all, the missing key must be the stated reason');
  console.log('  chain: order respected, reasons reported, throws contained, disabled sources explained');
}

async function testComposerHandoff() {
  /* A generated still and a generated clip must both arrive at the composer as ordinary files with
     a rights record the gate can judge, whichever source produced them. */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-gate-'));
  try {
    const {downloadFile} = require('../src/providers/download');
    const target = path.join(root, 'scene-001.jpg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const saved = await downloadFile({url: 'https://e.com/a.jpg', targetPath: target, fetchImpl: async () => ({ok: true, status: 200, headers: {get: () => String(bytes.length)}, arrayBuffer: async () => bytes})});
    assert.equal(saved.bytes, bytes.length);
    assert.equal(fs.readFileSync(target).length, bytes.length, 'The downloaded bytes must be written to disk unchanged');

    const oversized = await downloadFile({url: 'https://e.com/big.mp4', targetPath: path.join(root, 'big.mp4'), maxBytes: 4, fetchImpl: async () => ({ok: true, status: 200, headers: {get: () => '999999'}, arrayBuffer: async () => bytes})}).then(() => null, error => error);
    assert.ok(oversized && /unexpectedly large/.test(oversized.message), 'A declared oversized file must be refused before it is read');
    assert.ok(!fs.existsSync(path.join(root, 'big.mp4')), 'A refused download must not leave a partial file');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
  console.log('  shared downloader: real bytes on disk, size ceiling enforced, no partial files');
}

async function testGateScope() {
  /* The gate covers what can reach the video. Getting this wrong in either direction is bad: too
     wide and people learn to click through it, too narrow and unlicensed footage reaches a render. */
  const gated = [
    {kind: 'file', category: 'media', mime: 'video/mp4'},
    {kind: 'file', category: 'knowledge', mime: 'image/png'},
    {kind: 'file', category: 'knowledge', mime: 'audio/mpeg'},
    {kind: 'file', category: 'brand', mime: 'application/octet-stream'},
    {kind: 'file', category: 'media', mime: 'text/plain'}
  ];
  const open = [
    {kind: 'note', category: 'knowledge'},
    {kind: 'url', category: 'knowledge'},
    {kind: 'file', category: 'knowledge', mime: 'text/plain'},
    {kind: 'file', category: 'knowledge', mime: 'application/pdf'}
  ];
  for (const asset of gated) assert.equal(licensing.publishable(asset), true, JSON.stringify(asset) + ' must be gated');
  for (const asset of open) assert.equal(licensing.publishable(asset), false, JSON.stringify(asset) + ' must not be gated');
  assert.equal(licensing.publishable(null), false);
  assert.equal(licensing.publishable(undefined), false);
  console.log('  gate scope: visual and audio material gated, knowledge references left alone');
}

async function testOwnGeneratedMaterial() {
  /* AI-generated output made on the operator's own account is their own work, so it is cleared like
     `own`. Regression guard: an earlier version demanded the tool and the vendor's terms and returned
     a warning, which meant every attached AI-made image had to be declared before it could be used. */
  const bare = licensing.assessRights({basis: 'generated'});
  assert.equal(bare.state, 'cleared', 'AI-generated material you made yourself must not be gated');
  assert.deepEqual(bare.reasons, []);
  assert.deepEqual(bare.warnings, []);
  assert.equal(bare.attribution, null, 'there is nobody else to credit');
  assert.equal(bare.attribution_required, false);
  assert.equal(bare.self_owned, true);

  // Recording the tool and the terms is still allowed; it is provenance, not a condition.
  const recorded = licensing.assessRights({basis: 'generated', holder: 'Leonardo AI', note: 'paid plan, commercial use permitted'});
  assert.equal(recorded.state, 'cleared');
  assert.deepEqual(recorded.warnings, []);

  // Validation must accept a bare record, and must still accept the provenance fields.
  assert.equal(licensing.validateRights({basis: 'generated'}).basis, 'generated');
  assert.equal(licensing.validateRights({basis: 'generated', holder: 'Claude', note: 'my subscription output'}).holder, 'Claude');

  // `own` and `generated` are the two self-owned bases; nothing else is.
  assert.equal(licensing.LICENCES.own.self_owned, true);
  assert.equal(licensing.LICENCES.generated.self_owned, true);
  assert.equal(licensing.LICENCES.stock_licence.self_owned, undefined, 'a stock licence is somebody else\'s work with terms attached');

  // A third party's material is unaffected: the licence checks that matter still bite.
  assert.equal(licensing.assessRights({basis: 'cc_by_nc', title: 'NC', source_url: 'https://example.com/a'}).state, 'blocked');
  assert.equal(licensing.assessRights({basis: 'unknown'}).state, 'blocked');

  // And the gate as a whole renders on an otherwise-unsourced project made only of own AI output.
  const gate = licensing.rightsGate([
    {id: 'scene_1', name: 'Hook', rights: {basis: 'generated'}},
    {id: 'scene_2', name: 'Chart', rights: {basis: 'own'}}
  ]);
  assert.equal(gate.can_render, true, 'a project of your own AI output and own footage must render');
  assert.equal(gate.summary.blocked, 0);
  assert.equal(gate.summary.warnings, 0, 'own material must not carry warnings');
  assert.deepEqual(gate.attributions, [], 'own material produces no credits');
  console.log('  own AI output: cleared like own work, no declaration, no credit, and no gate on it');
}

async function run() {
  await testArchiveLicences();
  await testArchiveFileChoice();
  await testArchiveSearch();
  await testOpenverse();
  await testChain();
  await testComposerHandoff();
  await testGateScope();
  await testOwnGeneratedMaterial();
  console.log('All free-licence sourcing tests passed: Archive.org, Openverse, the chain, the shared downloader and the gate scope (mock network, no real downloads).');
}
run().catch(error => {console.error(error); process.exitCode = 1;});
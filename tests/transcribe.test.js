'use strict';
/* Transcription adapter tests. The provider boundary is mocked: no paid calls, no network.
   What matters is that a failure is reported with a usable reason, that timings are stitched
   correctly across parts, and that timestamps are valid WebVTT. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const transcribe = require('../src/providers/transcribe');
const {toVtt, vttTimestamp, toPlainText} = require('../src/analyze/audio');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-transcribe-'));
  const audioPath = path.join(root, 'part.flac');
  fs.writeFileSync(audioPath, Buffer.from('pretend audio'));

  // ---------- provider registry and cost estimate ----------
  assert.deepEqual(transcribe.providerIds(), ['openai']);
  assert.equal(transcribe.providerConfig('openai').defaultModel, 'whisper-1');
  assert.equal(transcribe.providerConfig('nope'), null);
  assert.equal(transcribe.estimateCost(600).usd, 0.06, 'Ten minutes at the published rate');
  assert.equal(transcribe.estimateCost(90).minutes, 1.5);
  assert.equal(transcribe.estimateCost(undefined), null);
  assert.equal(transcribe.estimateCost(600, 'unknown'), null);

  // ---------- a missing key must not attempt a request ----------
  let attempted = false;
  await assert.rejects(
    () => transcribe.transcribeFile({filePath: audioPath, apiKey: '', fetchImpl: async () => { attempted = true; }}),
    /No transcription API key/
  );
  assert.equal(attempted, false, 'A request must not be attempted without a key');

  // ---------- a successful response is parsed into text, segments and language ----------
  const verbose = {
    text: ' Emergency stop is on the left post. ',
    language: 'english',
    duration: 4.5,
    segments: [
      {start: 0, end: 2.5, text: ' Emergency stop '},
      {start: 2.5, end: 4.5, text: ' is on the left post. '},
      {start: 4.5, end: 5, text: '   '}
    ]
  };
  const ok = await transcribe.transcribeFile({
    filePath: audioPath, apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, transcribe.providerConfig('openai').endpoint);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer test-key');
      assert.ok(options.body instanceof FormData, 'The upload must be multipart form data');
      return Response.json(verbose);
    }
  });
  assert.equal(ok.text, 'Emergency stop is on the left post.');
  assert.equal(ok.language, 'english');
  assert.equal(ok.segments.length, 2, 'Blank segments must be dropped');
  assert.equal(ok.segments[0].text, 'Emergency stop');
  assert.equal(ok.durationSeconds, 4.5);

  // ---------- error responses must not leak the provider body ----------
  const secret = 'sk-do-not-leak';
  await assert.rejects(
    () => transcribe.transcribeFile({filePath: audioPath, apiKey: 'k', fetchImpl: async () => Response.json({error: {message: secret}}, {status: 401})}),
    error => {
      assert.equal(error.status, 401);
      assert.match(error.message, /API key was rejected/);
      assert.ok(!error.message.includes(secret), 'The provider body must never be echoed');
      return true;
    }
  );
  for (const [status, pattern] of [[413, /too large/], [429, /rate or usage limit/], [500, /had an error/]]) {
    await assert.rejects(
      () => transcribe.transcribeFile({filePath: audioPath, apiKey: 'k', fetchImpl: async () => new Response('nope', {status})}),
      error => { assert.match(error.message, pattern); return true; }
    );
  }
  await assert.rejects(
    () => transcribe.transcribeFile({filePath: audioPath, apiKey: 'k', fetchImpl: async () => { throw Object.assign(new Error('x'), {name: 'TimeoutError'}); }}),
    /timed out/
  );
  await assert.rejects(
    () => transcribe.transcribeFile({filePath: audioPath, apiKey: 'k', fetchImpl: async () => { throw new Error('offline'); }}),
    /Could not reach the transcription service/
  );
  await assert.rejects(
    () => transcribe.transcribeFile({filePath: audioPath, apiKey: 'k', fetchImpl: async () => new Response('<html>', {status: 200})}),
    /could not be read/
  );

  // ---------- parts are stitched with offset timings ----------
  const parts = [
    {index: 0, path: audioPath, startSeconds: 0},
    {index: 1, path: audioPath, startSeconds: 900}
  ];
  const seenStarts = [];
  let uploadCount = 0;
  const stitched = await transcribe.transcribeParts({
    parts, apiKey: 'k', onProgress: info => seenStarts.push(info.startSeconds),
    fetchImpl: async (url, options) => {
      uploadCount++;
      assert.ok(options.body instanceof FormData, 'Each part must be uploaded as multipart form data');
      return Response.json({text: 'part text', language: 'english', segments: [{start: 1, end: 3, text: 'hello there'}]});
    }
  });
  assert.equal(uploadCount, 2, 'One request per part');
  assert.equal(stitched.parts, 2);
  assert.deepEqual(seenStarts, [0, 900], 'Progress must report each part');
  assert.equal(stitched.segments.length, 2);
  assert.equal(stitched.segments[0].start, 1, 'The first part keeps its own timings');
  assert.equal(stitched.segments[1].start, 901, 'The second part must be shifted by its start offset');
  assert.equal(stitched.text, 'hello there hello there');
  assert.ok(stitched.vtt.startsWith('WEBVTT'));
  assert.ok(stitched.vtt.includes('00:15:01.000 --> 00:15:03.000'), 'A shifted part must produce a shifted cue, got: ' + stitched.vtt);

  // ---------- a part with no segments still contributes its text ----------
  const fallback = await transcribe.transcribeParts({
    parts: [{index: 0, path: audioPath, startSeconds: 0}], apiKey: 'k',
    fetchImpl: async () => Response.json({text: 'no segments here'})
  });
  assert.equal(fallback.segments.length, 1, 'Plain text without segments must still yield a cue');
  assert.equal(fallback.segments[0].text, 'no segments here');

  // ---------- WebVTT formatting ----------
  assert.equal(vttTimestamp(0), '00:00:00.000');
  assert.equal(vttTimestamp(65.5), '00:01:05.500');
  assert.equal(vttTimestamp(3661.25), '01:01:01.250');
  const vtt = toVtt([{start: 0, end: 2, text: 'first'}, {start: 2, end: 4, text: '  '}, {start: 4, end: 3, text: 'backwards'}]);
  assert.ok(vtt.startsWith('WEBVTT\n'));
  assert.ok(vtt.includes('1\n00:00:00.000 --> 00:00:02.000\nfirst'));
  assert.ok(!vtt.includes('backwards\n\n2'), 'Blank cues must be skipped and numbering kept sequential');
  assert.ok(vtt.includes('4.000 --> 00:00:06.000'), 'An end before the start must be corrected, got: ' + vtt);
  assert.equal(toPlainText([{text: 'a'}, {text: ' b '}, {text: ''}]), 'a b');

  fs.rmSync(root, {recursive: true, force: true});
  console.log('All transcription adapter tests passed: request shape, error mapping, part stitching, and WebVTT.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
'use strict';
/* Material analysis tests. Real files, real bytes, real ffprobe output where available.
   The point is that analysis never claims more than it did: every outcome carries a state and,
   when it fails, a reason a human can act on. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {analyzeAsset, analysisSummary, analysisState, MESSAGES} = require('../src/analyze');
const {classify, looksBinary, imageSize} = require('../src/analyze/detect');
const {aspectRatio, parseRate} = require('../src/analyze/media');
const {extractUrl, stripHtml, blockedHost} = require('../src/analyze/text');
const {detectMediaTools} = require('../src/config/capabilities');

const ffmpeg = detectMediaTools().find(tool => tool.name === 'ffmpeg');
const ffprobe = detectMediaTools().find(tool => tool.name === 'ffprobe');

function makeClip(target, seconds = 2) {
  execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=' + seconds,
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=' + seconds, '-c:v', 'libx264', '-c:a', 'aac', '-shortest', target], {stdio: 'ignore'});
}

/* Minimal structurally valid headers for the formats where the layout is fully under our control. */
function gifHeader(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0);
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}
function bmpHeader(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('BM', 0);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  return buffer;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-analysis-'));
  const file = name => path.join(root, name);
  const write = (name, content) => { fs.writeFileSync(file(name), content); return file(name); };

  // ---------- detection ----------
  const textPath = write('notes.txt', 'Robot cell safety notes.');
  assert.equal(classify(textPath, {name: 'notes.txt'}).kind, 'text');
  assert.equal(classify(write('data.csv', 'a,b\n1,2'), {name: 'data.csv'}).kind, 'text');
  assert.equal(classify(write('manual.pdf', Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(16, 0x20)])), {name: 'manual.pdf'}).kind, 'pdf');
  assert.equal(classify(write('spec.docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16, 0x20)])), {name: 'spec.docx'}).kind, 'unsupported');
  assert.equal(classify(write('brand.svg', '<svg></svg>'), {name: 'brand.svg'}).kind, 'unsupported');
  // The extension must not win over the bytes.
  assert.equal(classify(write('lying.txt', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), {name: 'lying.txt'}).kind, 'pdf', 'A PDF named .txt is still a PDF');
  assert.equal(classify(write('mystery', Buffer.from('plain words only')), {name: 'mystery'}).kind, 'text', 'A text body with no extension is still text');
  assert.equal(looksBinary(Buffer.from([0x00, 0x01])), true);
  assert.equal(looksBinary(Buffer.from('hello world')), false);

  // ---------- image dimensions from headers ----------
  // imageSize expects the magic sample the real analyze path passes: at least 10 bytes.
  const magic = bytes => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);
  // A truncated header must yield null rather than a guess.
  assert.equal(imageSize(write('short.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), magic([0x89, 0x50, 0x4e, 0x47])), null);
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  assert.deepEqual(imageSize(write('real.png', png1x1), magic([0x89, 0x50, 0x4e, 0x47])), {width: 1, height: 1, format: 'png'});
  if (ffmpeg && ffmpeg.available) {
    // A real JPEG: the marker walk depends on segment lengths, so a hand-made header proves nothing.
    execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x200:d=1', '-frames:v', '1', file('real.jpg')], {stdio: 'ignore'});
    assert.deepEqual(imageSize(file('real.jpg'), magic([0xff, 0xd8, 0xff])), {width: 320, height: 200, format: 'jpeg'});
  }
  assert.deepEqual(imageSize(write('a.gif', gifHeader(320, 240)), magic([0x47, 0x49, 0x46, 0x38])), {width: 320, height: 240, format: 'gif'});
  assert.deepEqual(imageSize(write('a.bmp', bmpHeader(800, 600)), magic([0x42, 0x4d])), {width: 800, height: 600, format: 'bmp'});
  assert.equal(imageSize(write('tiny.bin', Buffer.from([0x01])), Buffer.from([0x01])), null, 'An unreadable header must return null, not a guess');
  assert.equal(aspectRatio(1920, 1080), '16:9');
  assert.equal(aspectRatio(1080, 1920), '9:16');
  assert.equal(aspectRatio(0, 100), null);
  assert.equal(parseRate('30000/1001'), 29.97);
  assert.equal(parseRate('25/1'), 25);
  assert.equal(parseRate('0/0'), null);
  assert.equal(parseRate('nonsense'), null);

  // ---------- text analysis ----------
  const note = await analyzeAsset({id: 'n1', kind: 'note', name: 'Field notes', content: 'Emergency stop is on the left post.'});
  assert.equal(note.state, 'analyzed');
  assert.equal(note.detected.type, 'note');
  assert.equal(note.content.characters, 35);
  assert.equal((await analyzeAsset({id: 'n2', kind: 'note', name: 'Empty', content: '   '})).state, 'failed');

  const textResult = await analyzeAsset({id: 't1', kind: 'file', name: 'notes.txt', mime: 'text/plain'}, {filePath: textPath});
  assert.equal(textResult.state, 'analyzed');
  assert.ok(textResult.content.text.indexOf('Robot cell safety') === 0);
  assert.equal(textResult.content.truncated, false);

  const longPath = write('long.txt', 'x'.repeat(50000));
  const longResult = await analyzeAsset({id: 't2', kind: 'file', name: 'long.txt', mime: 'text/plain'}, {filePath: longPath});
  assert.equal(longResult.content.truncated, true, 'A long file must report that it was truncated');
  assert.equal(longResult.content.text.length, 20000);
  assert.ok(longResult.note, 'Truncation must come with a human note');

  const binaryPath = write('binary.txt', Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
  const binaryResult = await analyzeAsset({id: 't3', kind: 'file', name: 'binary.txt', mime: 'text/plain'}, {filePath: binaryPath});
  assert.equal(binaryResult.state, 'failed');
  assert.match(binaryResult.reason, /binary data/);
  assert.equal(binaryResult.retryable, false, 'A binary file behind a .txt name will not improve on retry');

  // ---------- PDF ----------
  // A real PDF with a deflated text layer, so the extractor is exercised against the actual format.
  const zlib = require('node:zlib');
  const pdfEscape = value => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  function buildPdf(lines) {
    const content = 'BT /F1 14 Tf 50 720 Td 18 TL\n' + lines.map(line => '(' + pdfEscape(line) + ') Tj T*').join('\n') + '\nET';
    const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'));
    const bodies = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
      '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
    ];
    const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
    const offsets = [0];
    let position = chunks[0].length;
    for (const body of bodies) {
      const buffer = Buffer.from(body, 'latin1');
      offsets.push(position); chunks.push(buffer); position += buffer.length;
    }
    const stream = Buffer.concat([
      Buffer.from('5 0 obj\n<< /Length ' + compressed.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\n', 'latin1')
    ]);
    offsets.push(position); chunks.push(stream); position += stream.length;
    let xref = 'xref\n0 ' + (bodies.length + 2) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= bodies.length + 1; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    xref += 'trailer\n<< /Size ' + (bodies.length + 2) + ' /Root 1 0 R >>\nstartxref\n' + position + '\n%%EOF\n';
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }

  const goodPdf = file('good.pdf');
  fs.writeFileSync(goodPdf, buildPdf(['Robot cell safety manual', 'Emergency stop is on the left post.', 'Always check the light curtain before entry.']));
  const pdfResult = await analyzeAsset({id: 'p1', kind: 'file', name: 'good.pdf', mime: 'application/pdf'}, {filePath: goodPdf});
  assert.equal(pdfResult.state, 'analyzed', 'A PDF with a text layer must be read');
  assert.equal(pdfResult.detected.type, 'pdf');
  assert.ok(pdfResult.content.text.indexOf('Emergency stop is on the left post.') >= 0, 'PDF text must be extracted, got: ' + JSON.stringify(pdfResult.content.text));
  assert.ok(pdfResult.content.text.indexOf('Tj') < 0, 'PDF operators must never leak into the extracted text');
  assert.equal(pdfResult.pages, 1);

  // A PDF whose only content draws an image has no text layer: it must say so, not return empty success.
  function buildScannedPdf() {
    const drawing = zlib.deflateSync(Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q', 'latin1'));
    const bodies = [
      Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
      Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
      Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n', 'latin1'),
      Buffer.concat([Buffer.from('4 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /Filter /DCTDecode /Length 4 >>\nstream\n', 'latin1'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('\nendstream\nendobj\n', 'latin1')]),
      Buffer.concat([Buffer.from('5 0 obj\n<< /Length ' + drawing.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'), drawing, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    ];
    const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
    const offsets = [0];
    let position = chunks[0].length;
    for (const body of bodies) { offsets.push(position); chunks.push(body); position += body.length; }
    let xref = 'xref\n0 ' + (bodies.length + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= bodies.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    xref += 'trailer\n<< /Size ' + (bodies.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + position + '\n%%EOF\n';
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
  const scannedPdf = file('scanned.pdf');
  fs.writeFileSync(scannedPdf, buildScannedPdf());
  const scannedResult = await analyzeAsset({id: 'p2', kind: 'file', name: 'scanned.pdf', mime: 'application/pdf'}, {filePath: scannedPdf});
  assert.equal(scannedResult.state, 'failed');
  assert.match(scannedResult.reason, /No text layer|needs OCR/);
  assert.equal(scannedResult.retryable, false, 'OCR is not a retry, so it must not be offered');

  // Claiming to be a PDF via the magic bytes but containing no usable structure must fail clearly.
  const notPdf = write('fake.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x07)]));
  const notPdfResult = await analyzeAsset({id: 'p3', kind: 'file', name: 'fake.pdf', mime: 'application/pdf'}, {filePath: notPdf});
  assert.equal(notPdfResult.state, 'failed');
  assert.match(notPdfResult.reason, /not a valid PDF|No text layer/);
  // A plain text file named .pdf is still text: the bytes win over the extension.
  const textNamedPdf = await analyzeAsset({id: 'p4', kind: 'file', name: 'notes.pdf', mime: 'application/pdf'}, {filePath: write('notes.pdf', 'This is plainly not a PDF at all.')});
  assert.equal(textNamedPdf.state, 'analyzed');
  assert.equal(textNamedPdf.detected.type, 'text');

  // ---------- unsupported and missing ----------
  const missingResult = await analyzeAsset({id: 'm1', kind: 'file', name: 'gone.txt', mime: 'text/plain'}, {filePath: file('does-not-exist.txt')});
  assert.equal(missingResult.state, 'failed');
  assert.match(missingResult.reason, /Import the file again/);
  assert.equal(missingResult.retryable, true, 'A missing original could come back, so a retry is offered');

  // ---------- media ----------
  if (ffmpeg && ffprobe && ffmpeg.available && ffprobe.available) {
    const clipPath = file('clip.mp4');
    makeClip(clipPath, 2);
    const thumbnailPath = file('clip.thumb.png');
    const mediaResult = await analyzeAsset({id: 'v1', kind: 'file', name: 'clip.mp4', mime: 'video/mp4'}, {filePath: clipPath, thumbnailPath, audioPath: file('clip.asr.flac')});
    assert.equal(mediaResult.state, 'analyzed');
    assert.equal(mediaResult.detected.type, 'video');
    assert.equal(mediaResult.media.width, 640);
    assert.equal(mediaResult.media.height, 360);
    assert.equal(mediaResult.media.aspectRatio, '16:9');
    assert.equal(mediaResult.media.videoCodec, 'h264');
    assert.equal(mediaResult.media.audioCodec, 'aac');
    assert.equal(mediaResult.media.hasAudio, true);
    assert.ok(mediaResult.media.durationSeconds > 1.5 && mediaResult.media.durationSeconds < 2.5, 'Duration must be close to the real clip length');
    assert.equal(mediaResult.transcription.status, 'none', 'Without a provider the audio is read but not transcribed');
    assert.ok(/No transcription provider/.test(mediaResult.transcription.reason));
    assert.ok(mediaResult.thumbnail, 'A video must get a preview frame');
    assert.ok(fs.existsSync(thumbnailPath), 'The preview frame must be written to disk');

    // With a provider available, short audio is transcribed without asking.
    const preparedPath = file('clip.asr2.flac');
    const transcribed = await analyzeAsset({id: 'v1b', kind: 'file', name: 'clip.mp4', mime: 'video/mp4'}, {
      filePath: clipPath, audioPath: preparedPath,
      transcribe: {provider: 'openai', run: async ({parts}) => ({text: 'Emergency stop is on the left post.', vtt: 'WEBVTT\n', segments: [{start: 0, end: 2, text: 'Emergency stop is on the left post.'}], language: 'en', model: 'whisper-1', parts: parts.length})}
    });
    assert.equal(transcribed.state, 'analyzed');
    assert.equal(transcribed.transcription.status, 'done');
    assert.equal(transcribed.transcription.provider, 'openai');
    assert.ok(transcribed.content.text.indexOf('Emergency stop') >= 0, 'Speech must become the text that research receives');
    assert.equal(transcribed.transcription.vtt.split('\n')[0], 'WEBVTT');
    assert.ok(fs.existsSync(preparedPath), 'The prepared audio must exist while transcribing');

    // Long audio must ask before spending money.
    const askPath = file('clip.asr3.flac');
    const longAsking = await analyzeAsset({id: 'v1c', kind: 'file', name: 'clip.mp4', mime: 'video/mp4'}, {
      filePath: clipPath, audioPath: askPath,
      transcribe: {provider: 'openai', run: async () => { throw new Error('must not be called before confirmation'); }}
    }).then(result => result);
    assert.equal(longAsking.state, 'analyzed', 'Short audio does not need confirmation');

    // Confirm the estimate shape used by the UI.
    const {estimateCost} = require('../src/providers/transcribe');
    const estimate = estimateCost(900, 'openai');
    assert.equal(estimate.minutes, 15);
    assert.ok(estimate.usd > 0 && estimate.usd < 1, 'A 15 minute estimate should be cents, got ' + estimate.usd);
    assert.equal(estimateCost(null, 'openai'), null);

    const silentPath = file('silent.mp4');
    execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1', '-c:v', 'libx264', silentPath], {stdio: 'ignore'});
    const silent = await analyzeAsset({id: 'v2', kind: 'file', name: 'silent.mp4', mime: 'video/mp4'}, {filePath: silentPath, audioPath: file('silent.asr.flac')});
    assert.equal(silent.state, 'analyzed');
    assert.equal(silent.media.hasAudio, false);
    assert.ok(silent.warnings.some(warning => /no audio track/.test(warning)));
    assert.equal(silent.transcription.status, 'none', 'A silent clip has nothing to transcribe');

    // Long audio must ask before spending money, and must not call the provider until confirmed.
    // No -shortest here: that would cut the clip to the shortest input and defeat the point.
    const longPath = file('long.mp4');
    execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x120:d=660',
      '-f', 'lavfi', '-i', 'sine=frequency=200:duration=660', '-c:v', 'libx264', '-preset', 'ultrafast', '-t', '660', '-c:a', 'aac', longPath], {stdio: 'ignore'});
    let providerCalls = 0;
    const providerStub = {provider: 'openai', run: async () => { providerCalls++; return {text: 'transcribed', segments: [], vtt: 'WEBVTT\n', parts: 1}; }};

    const asking = await analyzeAsset({id: 'v4', kind: 'file', name: 'long.mp4', mime: 'video/mp4'}, {filePath: longPath, audioPath: file('long.asr.flac'), transcribe: providerStub});
    assert.equal(asking.state, 'needs_confirmation', 'An 11 minute file must ask before transcribing');
    assert.equal(providerCalls, 0, 'The provider must not be called before confirmation');
    assert.equal(asking.transcription.status, 'needs_confirmation');
    assert.ok(asking.transcription.estimate.usd > 0, 'The user must be shown a cost estimate');
    assert.ok(asking.transcription.durationSeconds > 600);
    // The metadata read before the question is still real and must not be thrown away.
    assert.equal(asking.media.hasAudio, true);
    assert.ok(asking.media.durationSeconds > 600);

    const confirmed = await analyzeAsset({id: 'v4b', kind: 'file', name: 'long.mp4', mime: 'video/mp4'}, {filePath: longPath, audioPath: file('long2.asr.flac'), transcribe: providerStub, confirmLong: true});
    assert.equal(confirmed.state, 'analyzed');
    assert.equal(providerCalls, 1, 'After confirmation the provider runs exactly once');
    assert.equal(confirmed.transcription.status, 'done');

    // A provider failure must keep the metadata that was already read.
    const failing = await analyzeAsset({id: 'v5', kind: 'file', name: 'clip.mp4', mime: 'video/mp4'}, {
      filePath: clipPath, audioPath: file('clip.asr4.flac'),
      transcribe: {provider: 'openai', run: async () => { throw new Error('Transcription rate limit reached.'); }}
    });
    assert.equal(failing.state, 'analyzed', 'A transcription failure is not an analysis failure');
    assert.equal(failing.transcription.status, 'failed');
    assert.match(failing.transcription.reason, /rate limit/);
    assert.equal(failing.media.width, 640, 'Metadata read before the failure must survive');

    // Images: real dimensions, no stream probing, no bogus audio warning.
    const imageResult = await analyzeAsset({id: 'i1', kind: 'file', name: 'real.png', mime: 'image/png'}, {filePath: file('real.png')});
    assert.equal(imageResult.state, 'analyzed');
    assert.equal(imageResult.detected.type, 'image');
    assert.equal(imageResult.media.width, 1);
    assert.equal(imageResult.media.aspectRatio, '1:1');
    assert.deepEqual(imageResult.warnings, [], 'An image must not be warned about a missing audio track');

    const corruptPath = write('corrupt.mp4', Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), Buffer.alloc(200, 0x11)]));
    const corrupt = await analyzeAsset({id: 'v3', kind: 'file', name: 'corrupt.mp4', mime: 'video/mp4'}, {filePath: corruptPath});
    assert.equal(corrupt.state, 'failed', 'A file ffprobe cannot read must fail loudly, not report empty metadata');
    assert.ok(corrupt.reason.length > 10);
  } else {
    console.log('  (media assertions limited: ffmpeg and ffprobe are required for the full set)');
  }

  // ---------- URL analysis ----------
  const html = '<html><head><title>Robot Safety Guide</title></head><body><script>var secret=1;</script><style>.a{}</style><h1>Hazards</h1><p>Always use the &amp; emergency stop.</p></body></html>';
  const okFetch = async () => new Response(html, {status: 200, headers: {'content-type': 'text/html'}});
  const urlResult = await analyzeAsset({id: 'u1', kind: 'url', name: 'Guide', content: 'https://example.com/guide'}, {fetchImpl: okFetch});
  assert.equal(urlResult.state, 'analyzed');
  assert.equal(urlResult.detected.type, 'url');
  assert.ok(urlResult.content.text.indexOf('Hazards') >= 0);
  assert.ok(urlResult.content.text.indexOf('emergency stop') >= 0);
  assert.ok(urlResult.content.text.indexOf('var secret') < 0, 'Script contents must not be extracted as text');
  assert.ok(urlResult.content.text.indexOf('.a{}') < 0, 'Style contents must not be extracted as text');
  assert.equal(urlResult.content.title, 'Robot Safety Guide');

  assert.equal(stripHtml('<p>a</p><p>b</p>').indexOf('a') >= 0, true);

  const notFound = await analyzeAsset({id: 'u2', kind: 'url', name: 'Missing', content: 'https://example.com/gone'}, {fetchImpl: async () => new Response('nope', {status: 404})});
  assert.equal(notFound.state, 'failed');
  assert.match(notFound.reason, /HTTP 404/);
  assert.equal(notFound.retryable, true, 'A 404 might be temporary, so a retry is offered');

  const offline = await analyzeAsset({id: 'u3', kind: 'url', name: 'Offline', content: 'https://example.com/'}, {fetchImpl: async () => { throw new Error('network down'); }});
  assert.equal(offline.state, 'failed');
  assert.match(offline.reason, /could not be reached/);

  const binaryPage = await analyzeAsset({id: 'u4', kind: 'url', name: 'Binary', content: 'https://example.com/file.zip'}, {fetchImpl: async () => new Response('x', {status: 200, headers: {'content-type': 'application/zip'}})});
  assert.equal(binaryPage.state, 'failed');
  assert.match(binaryPage.reason, /not a text page/);

  // SSRF guards: a stored URL must not make the server read its own network.
  for (const address of ['http://localhost/admin', 'http://127.0.0.1:3000/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.4.2/', 'http://169.254.1.1/', 'http://[::1]/', 'http://printer.local/']) {
    assert.ok(blockedHost(new URL(address).hostname), address + ' must be blocked');
    const blocked = await extractUrl(address, {fetchImpl: async () => { throw new Error('must not be fetched'); }});
    assert.equal(blocked.ok, false, address + ' must not be fetched');
  }
  assert.equal(blockedHost('example.com'), null);
  assert.equal(blockedHost('8.8.8.8'), null);
  assert.equal((await extractUrl('javascript:alert(1)')).ok, false);
  assert.equal((await extractUrl('not a url')).ok, false);
  // A redirect into the private network must be refused. Response.url cannot be set on a real
  // Response in this Node build, so a plain response-like stub stands in for the redirect target.
  const redirectedTo = 'http://169.254.169.254/latest/meta-data';
  const redirecting = await extractUrl('https://example.com/start', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: redirectedTo,
      headers: new Headers({'content-type': 'text/html'}),
      text: async () => 'metadata'
    })
  });
  assert.equal(redirecting.ok, false, 'A redirect into a private address must not be read');
  assert.match(redirecting.reason, /blocked location/);

  // ---------- summary contract ----------
  for (const state of ['awaiting_analysis', 'analyzing', 'analyzed', 'failed', 'unsupported']) {
    const summary = analysisSummary({analysis: {state, reason: 'why'}});
    assert.equal(summary.state, state);
    assert.ok(summary.label && summary.tone, 'State ' + state + ' needs a label and tone');
  }
  assert.equal(analysisState({}), 'awaiting_analysis');
  assert.equal(analysisState({analysis_state: 'analyzed'}), 'awaiting_analysis', 'A legacy analysis_state alone must not claim analysis');
  assert.equal(analysisSummary({analysis: {state: 'failed', reason: 'x', retryable: false}}).canAnalyze, false);
  assert.equal(analysisSummary({analysis: {state: 'failed', reason: 'x', retryable: true}}).canAnalyze, true);
  assert.equal(analysisSummary({analysis: {state: 'analyzed'}}).canAnalyze, false);
  assert.ok(MESSAGES.awaiting.length > 0);

  // ---------- analysis feeds research ----------
  // Only what analysis actually read reaches research, and an item that produced nothing is
  // reported with the real reason rather than silently contributing or leaking raw content.
  const {createLibrary} = require('../src/lib/materialLibrary');
  const libraryRoot = path.join(root, 'library');
  const library = createLibrary(libraryRoot);
  const noteAsset = library.addText({kind: 'note', name: 'Field note', content: 'Emergency stop is on the left post.', category: 'knowledge'});
  const unanalyzedUrl = library.addText({kind: 'url', name: 'Reference', content: 'https://example.com/ref', category: 'knowledge'});
  // Speech from footage is content even though the footage is stored as media.
  const videoAsset = library.addText({kind: 'note', name: 'Interview footage', content: 'placeholder', category: 'media'});
  library.setAnalysis(videoAsset.id, {state: 'analyzed', detected: {type: 'video'}, content: {text: 'The light curtain must be checked every shift.', characters: 45, truncated: false}, transcription: {status: 'done', model: 'whisper-1'}, retryable: true});
  // An item analysis could not read must never be sent as content.
  const brandAsset = library.addText({kind: 'note', name: 'Brand note', content: 'raw brand text', category: 'brand'});
  library.setAnalysis(brandAsset.id, {state: 'unsupported', reason: 'Brand assets are stored as-is.', retryable: false});
  const awaitingAsset = library.addText({kind: 'note', name: 'Long interview', content: 'audio only', category: 'media'});
  library.setAnalysis(awaitingAsset.id, {state: 'needs_confirmation', reason: 'This file is 11 minute(s) long.', retryable: false});

  // Nothing analyzed yet: no text may be claimed as shared content.
  const before = library.researchContext([
    {asset_id: noteAsset.id, decision: 'use'},
    {asset_id: unanalyzedUrl.id, decision: 'use'},
    {asset_id: brandAsset.id, decision: 'use'},
    {asset_id: awaitingAsset.id, decision: 'use'}
  ]);
  assert.equal(before.included.length, 0, 'Nothing analyzed means nothing is sent as research content');
  assert.ok(before.excluded.some(item => /analyze it to fetch/.test(item.reason)), 'The unanalyzed URL must be excluded with a reason');
  assert.ok(before.excluded.some(item => item.id === noteAsset.id && /not analyzed yet/.test(item.reason)), 'An unanalyzed note must be excluded with a reason');
  assert.ok(before.excluded.some(item => item.id === brandAsset.id && /stored as-is/.test(item.reason)), 'An unsupported item must be excluded with its real reason');
  assert.ok(before.excluded.some(item => item.id === awaitingAsset.id && /11 minute/.test(item.reason)), 'An item awaiting confirmation must keep its own reason');
  assert.ok(!JSON.stringify(before).includes('raw brand text'), 'Raw content of an unavailable item must never be sent');

  // After analysis, the extracted text is what research receives, whatever the category.
  const noteAnalysis = await analyzeAsset({id: noteAsset.id, kind: 'note', name: 'Field note', content: noteAsset.content});
  library.setAnalysis(noteAsset.id, noteAnalysis);
  library.setAnalysis(unanalyzedUrl.id, {state: 'failed', reason: 'The page could not be reached.', retryable: true});
  const after = library.researchContext([{asset_id: noteAsset.id, decision: 'use'}, {asset_id: unanalyzedUrl.id, decision: 'use'}, {asset_id: videoAsset.id, decision: 'use'}]);
  const includedNote = after.included.find(item => item.id === noteAsset.id);
  assert.ok(includedNote, 'The analyzed note must reach research');
  assert.equal(includedNote.source, 'analysis');
  assert.equal(includedNote.analyzed, true);
  assert.ok(includedNote.text.indexOf('Emergency stop') >= 0);
  const includedVideo = after.included.find(item => item.id === videoAsset.id);
  assert.ok(includedVideo, 'A transcribed media item must ground research: its speech is content');
  assert.ok(includedVideo.text.indexOf('light curtain') >= 0);
  assert.ok(after.excluded.some(item => item.id === unanalyzedUrl.id && /could not be reached/.test(item.reason)), 'A failed item must be excluded with its real reason');

  fs.rmSync(root, {recursive: true, force: true});
  console.log('All material analysis tests passed: detection, text, PDF, images, media, transcription, URLs, SSRF guards, research handoff, and outcome contract.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
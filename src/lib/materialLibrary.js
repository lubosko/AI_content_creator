"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { save, fail } = require('./intakeWorkflow');
const licensing = require('./licensing');
const TYPES = {
  '.mp4': ['video/mp4','media'], '.webm': ['video/webm','media'], '.mov': ['video/quicktime','media'],
  '.png': ['image/png','media'], '.jpg': ['image/jpeg','media'], '.jpeg': ['image/jpeg','media'], '.webp': ['image/webp','media'], '.gif': ['image/gif','media'],
  '.mp3': ['audio/mpeg','media'], '.wav': ['audio/wav','media'], '.m4a': ['audio/mp4','media'], '.ogg': ['audio/ogg','media'],
  '.pdf': ['application/pdf','knowledge'], '.txt': ['text/plain','knowledge'], '.md': ['text/plain','knowledge'], '.csv': ['text/plain','knowledge'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document','knowledge'],
  '.svg': ['application/octet-stream','brand'], '.ttf': ['application/octet-stream','brand'], '.otf': ['application/octet-stream','brand']
};
function createLibrary(root, maxBytes = 100 * 1024 * 1024) {
  function metadataPath(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) fail('Asset not found.', 404);
    return path.join(root, id + '.json');
  }
  function get(id, requireFile = true) {
    const file = metadataPath(id);
    if (!fs.existsSync(file)) fail('Asset not found.', 404);
    const asset = JSON.parse(fs.readFileSync(file,'utf8'));
    if (requireFile && asset.kind === 'file' && !fs.existsSync(path.join(root, asset.id + '.bin'))) fail('Imported file is missing. Import it again.', 404);
    return asset;
  }
  function list() {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
      const asset = JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
      return { ...asset, missing: asset.kind === 'file' && !fs.existsSync(path.join(root,asset.id + '.bin')) };
    }).sort((a,b) => b.created_at.localeCompare(a.created_at));
  }
  function base(name, kind, category) {
    if (!['knowledge','media','brand'].includes(category)) fail('Choose knowledge, media, or brand.');
    if (typeof name !== 'string' || !name.trim() || name.length > 255) fail('A title of 1–255 characters is required.');
    return { id: randomUUID(), name: name.trim(), kind, category, revision: 1, created_at: new Date().toISOString(), analysis_state: 'awaiting_analysis', rights: null };
  }

  /* Rights belong to the library original, not to a project: the same file reused in another video
     has the same provenance. Nothing is assumed. An item with no record is "not confirmed", and the
     rights gate blocks it rather than treating silence as permission. */
  function setRights(id, body) {
    const asset = get(id, false);
    const record = licensing.validateRights(body);
    asset.rights = record.basis === 'unknown' ? null : {...record, recorded_at: new Date().toISOString()};
    save(metadataPath(id), asset);
    return asset;
  }

  function rightsFor(asset) { return licensing.normalise(asset && asset.rights); }

  /* Analysis is stored in the asset's own metadata so a card can render its state without reading
     a second file. analysis_state is kept in step for backwards compatibility. */
  function setAnalysis(id, record) {
    const asset = get(id, false);
    asset.analysis = record ? {...record, updated_at: new Date().toISOString()} : null;
    asset.analysis_state = (record && record.state) || 'awaiting_analysis';
    save(metadataPath(id), asset);
    return asset;
  }

  /* Path of the stored original, or null for items that have no file (notes and URLs). */
  function filePathFor(asset) {
    if (!asset || asset.kind !== 'file') return null;
    return path.join(root, asset.id + '.bin');
  }

  function thumbnailPathFor(asset) {
    if (!asset || asset.kind !== 'file') return null;
    return path.join(root, asset.id + '.thumb.png');
  }

  /* Prepared audio for transcription lives beside the original and can be removed afterwards. */
  function audioPathFor(asset) {
    if (!asset || asset.kind !== 'file') return null;
    return path.join(root, asset.id + '.asr.flac');
  }

  function clearAudio(asset) {
    const file = audioPathFor(asset);
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
    const parts = path.join(root, asset.id + '.asr.parts');
    if (parts && fs.existsSync(parts)) fs.rmSync(parts, {recursive: true, force: true});
  }

  function serveThumbnail(response, id) {
    const asset = get(id, false);
    const file = thumbnailPathFor(asset);
    if (!file || !fs.existsSync(file)) fail('No preview image has been generated for this asset.', 404);
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': fs.statSync(file).size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
  function addText(body) {
    if (!['note','url'].includes(body.kind)) fail('Choose note or URL.');
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 100000) fail('Content must contain 1–100000 characters.');
    const asset = base(body.name, body.kind, body.category || 'knowledge');
    asset.content = body.content.trim();
    if (body.kind === 'url') {
      let url;
      try { url = new URL(asset.content); } catch { fail('Enter a valid HTTP or HTTPS URL.'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP or HTTPS URL without embedded credentials.');
      asset.content = url.href;
    }
    fs.mkdirSync(root,{recursive:true});
    save(metadataPath(asset.id),asset);
    return asset;
  }
  async function upload(request, name, category) {
    if (!name || /[\\/\x00-\x1f]/.test(name)) fail('Invalid filename.');
    const type = TYPES[path.extname(name).toLowerCase()];
    if (!type) fail('Unsupported file type. Use video, image, audio, PDF, DOCX, text, SVG, or font files.',415);
    if (Number(request.headers['content-length']) > maxBytes) fail('File exceeds the upload limit.',413);
    const asset = base(name,'file',category || type[1]);
    asset.mime = type[0];
    let size = 0;
    fs.mkdirSync(root,{recursive:true});
    const temp = path.join(root,asset.id + '.upload');
    const target = path.join(root,asset.id + '.bin');
    // Drain oversized requests while discarding their content, so callers receive a useful HTTP error.
    const limit = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(null, size <= maxBytes ? chunk : undefined);
    }});
    try {
      await pipeline(request,limit,fs.createWriteStream(temp,{flags:'wx'}));
      if (size > maxBytes) fail('File exceeds the upload limit.',413);
      if (!size) fail('Empty files cannot be imported.');
      fs.renameSync(temp,target);
      asset.size = size;
      save(metadataPath(asset.id),asset);
      return asset;
    } catch (error) {
      for (const file of [temp,target]) if (fs.existsSync(file)) fs.unlinkSync(file);
      throw error;
    }
  }
  /* Imports bytes the app produced itself, such as a scene generated through a provider. It takes a
     Buffer rather than an HTTP request, which is the only difference from `upload`: the record shape,
     the `<id>.bin` layout, the size cap and the awaiting-analysis state are deliberately identical, so
     a generated file is an ordinary library asset from here on. */
  function importBytes({name, category = 'media', mime, bytes}) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!name || /[\\/\x00-\x1f]/.test(name)) fail('Invalid filename.');
    const type = TYPES[path.extname(name).toLowerCase()];
    if (!type) fail('Unsupported file type for a generated file: ' + name, 415);
    if (!buffer.length) fail('The generated file was empty.');
    if (buffer.length > maxBytes) fail('The generated file exceeds the import limit.', 413);
    const asset = base(name, 'file', category);
    // The provider states the MIME type; the extension decides what the app will accept, so both
    // have to agree or the file would be filed as something it is not.
    if (mime && String(mime) !== type[0]) {
      fail('The generated file says it is ' + mime + ' but its extension says ' + type[0] + '.', 415);
    }
    asset.mime = type[0];
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, asset.id + '.bin'), buffer);
    asset.size = buffer.length;
    save(metadataPath(asset.id), asset);
    return asset;
  }

  function serve(request,response,id) {
    const asset = get(id);
    if (asset.kind !== 'file') fail('This asset has no file.',404);
    const file = path.join(root,id + '.bin');
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1, status = 200;
    if (request.headers.range) {
      const match = request.headers.range.match(/^bytes=(\d+)-(\d*)$/);
      if (!match) { response.writeHead(416,{'content-range':'bytes */' + size}); response.end(); return; }
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]),end) : end;
      if (start > end || start >= size) { response.writeHead(416,{'content-range':'bytes */' + size}); response.end(); return; }
      status = 206;
    }
    const headers = { 'content-type':asset.mime, 'content-length':end-start+1, 'accept-ranges':'bytes', 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'content-security-policy':"sandbox; default-src 'none'", 'content-disposition': (asset.mime === 'application/octet-stream' ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(asset.name) };
    if (status === 206) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size;
    response.writeHead(status,headers);
    const stream = fs.createReadStream(file,{start,end});
    stream.on('error',() => response.destroy());
    response.on('close',() => stream.destroy());
    stream.pipe(response);
  }
  /* Builds the material context sent to the research provider.
     Every analyzed item marked Use contributes the text that was actually read, whatever category
     it sits in: a transcribed interview is content even though it is stored as media. An item that
     produced no text is reported with the real reason instead of being silently dropped. */
  function researchContext(selections) {
    const included = [], excluded = [];
    let remaining = 30000;
    for (const selection of selections.filter(item => item.decision === 'use')) {
      const asset = get(selection.asset_id);
      if (!remaining) { excluded.push({id:asset.id,name:asset.name,reason:'Material context limit reached'}); continue; }

      const analysis = asset.analysis || {};
      let content = null;
      let source = 'unanalyzed';

      // Nothing that analysis could not read is sent as content, whatever its category.
      if (analysis.state === 'failed' || analysis.state === 'unsupported' || analysis.state === 'needs_confirmation') {
        excluded.push({id:asset.id,name:asset.name,reason:analysis.reason || 'Analysis did not produce text'});
        continue;
      }

      if (analysis.state === 'analyzed' && analysis.content && analysis.content.text) {
        // What analysis actually read, including a transcript.
        content = analysis.content.text;
        source = 'analysis';
      } else if (asset.kind === 'url') {
        // A URL is a reference until it is analyzed. Say so rather than implying it was read.
        excluded.push({id:asset.id,name:asset.name,reason:'URL reference only; analyze it to fetch the page text'});
        continue;
      } else if (asset.kind === 'note') {
        excluded.push({id:asset.id,name:asset.name,reason:'Note not analyzed yet; analyze it to include its text'});
        continue;
      } else if (asset.kind === 'file') {
        if (!['.txt','.md','.csv'].includes(path.extname(asset.name).toLowerCase())) {
          excluded.push({id:asset.id,name:asset.name,reason:'Not analyzed yet, and text extraction is not available for this file type'});
          continue;
        }
        const fd = fs.openSync(path.join(root,asset.id + '.bin'),'r');
        const buffer = Buffer.alloc(Math.min(asset.size,120000));
        try { const count = fs.readSync(fd,buffer,0,buffer.length,0); content = buffer.subarray(0,count).toString('utf8'); } finally { fs.closeSync(fd); }
      }

      const text = String(content || '').slice(0,Math.min(10000,remaining));
      const fullLength = String(content || '').length;
      included.push({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        text,
        source,
        analyzed: analysis.state === 'analyzed',
        truncated: text.length < fullLength || !!(analysis.content && analysis.content.truncated)
      });
      remaining -= text.length;
    }
    return {included,excluded};
  }
  return { get, list, addText, upload, importBytes, serve, serveThumbnail, maxBytes, researchContext, setAnalysis, setRights, rightsFor, filePathFor, thumbnailPathFor, audioPathFor, clearAudio };
}
module.exports = { createLibrary };

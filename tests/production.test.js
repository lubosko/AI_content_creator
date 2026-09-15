'use strict';
/* Asset production tests: narration really produced, stock failures handled, the manifest honest.
   The speech provider is, deliberately, real ffmpeg tone generation rather than stub bytes, so the
   audio files are genuine MP3s and the measured durations are real. No paid calls. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {generateStoryboard, generateAssets} = require('../src/lib/providerStages');
const {generateResearch, generateStrategy, generateScript} = require('../src/lib/providerStages');
const {createProject} = require('../src/lib/projectGenerator');
const intake = require('../src/lib/intakeWorkflow');
const {measuredDuration, narrationText, produceNarration} = require('../src/lib/narration');
const {splitText, resolveModel, estimateCost, messageFor} = require('../src/providers/speech');
const {searchQuery, pickVideoFile} = require('../src/providers/stock');
const {detectMediaTools} = require('../src/config/capabilities');

const ffmpeg = detectMediaTools().find(tool => tool.name === 'ffmpeg');

/* Real audio of a known length, so duration measurement is verified rather than assumed. */
function tone(targetPath, seconds) {
  execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + seconds, '-c:a', 'libmp3lame', '-b:a', '64k', targetPath], {stdio: 'ignore'});
  return {path: targetPath, bytes: fs.statSync(targetPath).size, chunks: 1, characters: 1000, model: 'test-tts', voice: 'alloy'};
}

function providerFor(state) {
  return {
    chat: async ({system, user}) => {
      const prompt = String(user || '');
      if (prompt.includes('Plan the storyboard')) {
        return {text: JSON.stringify({scenes: [
          {id: 'hook', title: 'Hook', narration_section_id: 'hook', seconds: 1, visual_intent: 'Opening', asset_id: null, generation_prompt: 'robot arm factory', shot_type: 'wide'},
          {id: 'body', title: 'Body', narration_section_id: 'body', seconds: 1, visual_intent: 'Detail', asset_id: null, generation_prompt: 'control room', shot_type: 'close'}
        ], total_duration_seconds: 2}), model: 'test-model', warnings: [], sources: [], grounding: 'model_draft'};
      }
      if (prompt.includes('Create the content strategy')) {
        return {text: JSON.stringify({story_promise: 'P', target_audience: 'A', angle: 'X', structure: [{section: 'Hook', seconds: 1}, {section: 'Body', seconds: 1}], hooks: ['h'], retention_moments: [], material_usage: [], short_form_opportunities: [], risks: []}), model: 'test-model', warnings: [], sources: [], grounding: 'model_draft'};
      }
      if (prompt.includes('Write the full narration script')) {
        return {text: JSON.stringify({sections: [
          {id: 'hook', title: 'Hook', narration: 'Opening narration for the test.', seconds: 1},
          {id: 'body', title: 'Body', narration: 'Body narration for the test.', seconds: 1},
          {id: 'silent', title: 'Silent', narration: '', seconds: 1}
        ], estimated_duration_seconds: 3}), model: 'test-model', warnings: [], sources: [], grounding: 'model_draft'};
      }
      return {text: '# Research\n\n## Summary\n\nS\n\n## Key findings\n\n- K\n\n## Claims to verify\n\n- C', model: 'test-model', warnings: [], sources: [], grounding: 'model_draft'};
    }
  };
}

async function run() {
  // ---------- speech adapter units ----------
  assert.deepEqual(splitText('a'.repeat(10), 4000), ['a'.repeat(10)]);
  const long = ('Sentence one. Sentence two. ').repeat(400);
  const chunks = splitText(long, 4000);
  assert.ok(chunks.length > 1, 'Long text must be split');
  assert.ok(chunks.every(chunk => chunk.length <= 4000), 'No chunk may exceed the request limit');
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), long.replace(/\s+/g, ' ').trim(), 'Splitting must not lose text');
  // A transcription model cannot speak, so it must not be sent as a speech model.
  assert.equal(resolveModel('whisper-1'), 'gpt-4o-mini-tts');
  assert.equal(resolveModel('gpt-4o-mini-tts'), 'gpt-4o-mini-tts');
  assert.equal(resolveModel(''), 'gpt-4o-mini-tts');
  assert.ok(estimateCost(10000).usd > 0);
  assert.equal(estimateCost(undefined), null);
  assert.match(messageFor(401), /key was rejected/);

  // ---------- stock adapter units ----------
  assert.equal(searchQuery('A wide shot of a robot arm, in a factory!'), 'A wide shot of a robot arm in', 'Punctuation is stripped and the query is capped at eight words');
  assert.equal(searchQuery(''), 'b roll');
  const video = {duration: 10, video_files: [
    {link: 'sd.mp4', width: 640, height: 360, file_type: 'video/mp4'},
    {link: 'hd.mp4', width: 1920, height: 1080, file_type: 'video/mp4'},
    {link: 'portrait.mp4', width: 1080, height: 1920, file_type: 'video/mp4'}
  ]};
  assert.equal(pickVideoFile(video).link, 'hd.mp4', 'A landscape HD file must be preferred');
  assert.equal(pickVideoFile({video_files: []}), null);

  // ---------- the full creative chain, then production ----------
  assert.ok(ffmpeg && ffmpeg.available, 'ffmpeg is required for this test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-assets-'));
  const projectsRoot = path.join(root, 'projects');
  const created = createProject({outDir: projectsRoot, prompt: 'A video about robot safety for plant managers.'});
  const folder = path.basename(created.projectDirectory);
  const provider = providerFor();

  let ctx = intake.context(projectsRoot, folder);
  intake.confirmBrief(ctx, {...ctx.brief, angle: 'Safety', purpose: 'Reduce risk', revision: ctx.project.workflow.revision});
  ctx = intake.context(projectsRoot, folder);
  intake.confirmMaterials(ctx, {revision: ctx.project.workflow.revision, without_material: true}, () => ({id: 'x'}));

  await generateResearch({projectsRoot, folder, provider, library: null, settings: {web_search: false, include_materials: false}});
  await generateStrategy({projectsRoot, folder, provider, library: null});
  await generateScript({projectsRoot, folder, provider, library: null});
  await generateStoryboard({projectsRoot, folder, provider, library: null});

  // Real speech synthesis, real stock download (the URL is a local file written by ffmpeg).
  const clipPath = path.join(root, 'stock-clip.mp4');
  execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=1920x1080:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', clipPath], {stdio: 'ignore'});
  let searchCalls = 0;
  const speech = ({text, targetPath}) => tone(targetPath, 1);
  const stock = {
    search: async ({query}) => {
      searchCalls++;
      // The second search fails, so one scene is produced and one is reported as failed.
      if (searchCalls === 2) return {ok: false, reason: 'No stock footage matched that description.'};
      return {ok: true, clip: {provider: 'pexels', provider_id: '1', url: clipPath, page_url: 'https://example.com/clip', width: 1920, height: 1080, duration_seconds: 3, author: 'Tester', licence: 'Pexels licence', attribution_required: false, query}};
    },
    download: async ({url, targetPath}) => ({path: (fs.mkdirSync(path.dirname(targetPath), {recursive: true}), fs.copyFileSync(url, targetPath), targetPath), bytes: fs.statSync(targetPath).size})
  };

  const result = await generateAssets({projectsRoot, folder, library: null, speech, stock});
  const manifestPath = path.join(created.projectDirectory, 'generated/asset_manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'The manifest must be written');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Narration: two sections spoken, one empty, and the durations are measured from real files.
  assert.equal(manifest.narration.produced, 2);
  assert.equal(manifest.narration.empty, 1, 'A section with no narration text must be reported, not skipped');
  assert.equal(manifest.narration.failed, 0);
  const spoken = manifest.narration.sections.filter(section => section.status === 'done');
  assert.equal(spoken.length, 2);
  for (const section of spoken) {
    assert.ok(fs.existsSync(path.join(created.projectDirectory, section.path)), 'The audio file must exist: ' + section.path);
    assert.ok(section.duration_seconds > 0.5 && section.duration_seconds < 2, 'The duration must be measured from the file, got ' + section.duration_seconds);
    assert.equal(section.duration_measured, true);
  }
  assert.ok(manifest.narration.total_seconds > 1, 'Total narration seconds must be summed');
  assert.equal(manifest.narration.sections.find(section => section.section_id === 'silent').status, 'empty');

  // Scenes: one produced here, one reported as missing with its reason.
  assert.equal(manifest.counts.produced, 1);
  assert.equal(manifest.counts.still_missing, 1);
  assert.equal(manifest.counts.own_media, 0);
  assert.equal(manifest.status, 'incomplete', 'A project with a missing scene is not complete');
  const producedScene = manifest.scenes.find(scene => scene.status === 'produced');
  assert.ok(fs.existsSync(path.join(created.projectDirectory, producedScene.path)), 'The produced clip must exist on disk');
  assert.equal(producedScene.clip.author, 'Tester', 'Provenance must be recorded');
  assert.ok(producedScene.clip.licence, 'The licence must be recorded');
  const failedScene = manifest.scenes.find(scene => scene.status === 'failed');
  assert.match(failedScene.reason, /No stock footage matched/);
  assert.ok(manifest.warnings.some(warning => /no narration text/.test(warning)), 'Warnings must state the gaps: ' + manifest.warnings.join(' | '));

  // The asset index keeps provenance for the composer and for attribution.
  const index = JSON.parse(fs.readFileSync(path.join(created.projectDirectory, 'analyzed/asset_index.json'), 'utf8'));
  assert.equal(index.generated.length, 1);
  assert.equal(index.generated[0].provider, 'pexels');
  assert.equal(index.generated[0].attribution_required, false);
  assert.equal(index.narration.length, 2);

  // ---------- no providers configured ----------
  // A project must still record what it could not produce, rather than failing silently.
  const bare = await generateAssets({projectsRoot, folder, library: null, speech: null, stock: null});
  const bareManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(bareManifest.narration.produced, 0);
  assert.equal(bareManifest.scenes.every(scene => scene.status !== 'produced'), true);
  assert.ok(bareManifest.warnings.some(warning => /no speech provider/.test(warning)));
  assert.ok(bareManifest.warnings.some(warning => /no stock provider/.test(warning)));
  assert.ok(bare.artifact.warnings.length >= 2);

  // ---------- narration helpers ----------
  assert.equal(narrationText({narration: '  hi  '}), 'hi');
  assert.equal(narrationText({}), '');
  assert.equal(measuredDuration(path.join(root, 'missing.mp3')), null, 'An unreadable file must report no duration, not zero');
  const empty = await produceNarration({sections: [{id: 'a', narration: '   '}], audioDir: path.join(root, 'empty-audio'), speak: async () => { throw new Error('must not be called'); }});
  assert.equal(empty.sections[0].status, 'empty');

  fs.rmSync(root, {recursive: true, force: true});
  console.log('All asset production tests passed: narration with measured durations, stock fill, gap reporting, and provenance.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
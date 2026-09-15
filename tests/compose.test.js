'use strict';
/* The composer end to end: a project with produced assets composes a real master, and QC inspects
   the file that was written. The network is mocked; every file is real, and FFmpeg really runs. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const {createServer} = require('../src/server');
const {detectMediaTools} = require('../src/config/capabilities');
const captions = require('../src/lib/captions');

const FFMPEG = detectMediaTools().find(tool => tool.name === 'ffmpeg');
const FFPROBE = detectMediaTools().find(tool => tool.name === 'ffprobe');
assert.ok(FFMPEG && FFMPEG.available, 'ffmpeg is required to compose');
assert.ok(FFPROBE && FFPROBE.available, 'ffprobe is required to verify the master');

const SECTION_HOOK = 'The robot will not warn you.';
const SECTION_BODY = 'Check the light curtain before entry. Then check it again after lunch.';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port));
  });
}
function close(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

async function api(baseUrl, route, body) {
  const options = body === undefined ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)};
  const response = await fetch(baseUrl + route, options);
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (error) { payload = {raw: text}; }
  return {status: response.status, payload};
}

function probeMaster(file) {
  const raw = execFileSync(FFPROBE.path, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {encoding: 'utf8'});
  const parsed = JSON.parse(raw);
  const video = (parsed.streams || []).find(stream => stream.codec_type === 'video') || {};
  const audio = (parsed.streams || []).find(stream => stream.codec_type === 'audio') || null;
  return {
    duration: Number(parsed.format && parsed.format.duration),
    width: video.width,
    height: video.height,
    rate: video.r_frame_rate,
    codec: video.codec_name,
    hasAudio: !!audio,
    audioCodec: audio ? audio.codec_name : null
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
  const projectsRoot = path.join(root, 'projects');
  const state = {assetId: null, speechCalls: 0};
  // Real narration bytes: the network is mocked, the audio is not.
  const speechPath = path.join(root, 'speech.mp3');
  execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=320:duration=1.5', speechPath], {stdio: 'ignore'});
  const speechBytes = fs.readFileSync(speechPath);

  const providerFetch = async (url, options) => {
    const target = String(url);
    if (target.includes('/audio/speech')) {
      state.speechCalls++;
      assert.equal(JSON.parse(options.body).model, 'gpt-4o-mini-tts', 'A transcription model must never be sent to the speech endpoint');
      return new Response(speechBytes, {status: 200, headers: {'content-type': 'audio/mpeg'}});
    }
    if (!target.startsWith('https://api.anthropic.com')) {
      if (target.includes('advancedsearch')) return Response.json({response: {docs: []}});
      return Response.json({results: []});
    }
    const body = JSON.parse(options.body);
    const prompt = JSON.stringify(body.messages || '');
    let text;
    if (prompt.includes('Create the content strategy')) {
      text = JSON.stringify({story_promise: 'Understand robot safety', target_audience: 'Plant managers', angle: 'Safety first', structure: [{section: 'Hook', purpose: 'Open with the risk', seconds: 20}, {section: 'Body', purpose: 'Explain the rules', seconds: 40}], hooks: ['The robot will not warn you.'], retention_moments: ['the light curtain'], material_usage: [], short_form_opportunities: [], risks: []});
    } else if (prompt.includes('Write the full narration script')) {
      text = JSON.stringify({sections: [
        {id: 'hook', title: 'Hook', narration: SECTION_HOOK, visual_notes: ['factory floor'], seconds: 2, source_refs: ['research'], short_form: true},
        {id: 'body', title: 'Body', narration: SECTION_BODY, visual_notes: ['light curtain'], seconds: 5, source_refs: ['research'], short_form: false}
      ], estimated_duration_seconds: 7});
    } else if (prompt.includes('Plan the storyboard')) {
      /* Three scenes and two sections: the body section spans two scenes, which is how a real
         storyboard is shaped and what forces the narration split to be correct. */
      text = JSON.stringify({scenes: [
        {id: 'scene_one', title: 'Own media', narration_section_id: 'hook', seconds: 2, visual_intent: 'Factory floor at dawn', asset_id: state.assetId, shot_type: 'wide', on_screen_text: '', generation_prompt: '', transition: ''},
        {id: 'scene_two', title: 'Benchmark', narration_section_id: 'body', seconds: 3, visual_intent: 'Two bars race upward', asset_id: null, shot_type: 'graphic', on_screen_text: 'ROS2=100 | Dora-rs=380', graphic_template: 'bar-chart', graphic_data: {bars: [{label: 'ROS2', value: 100}, {label: 'Dora-rs', value: 380}]}, generation_prompt: 'bar chart of the benchmark', transition: ''},
        {id: 'scene_three', title: 'Closing card', narration_section_id: 'body', seconds: 2, visual_intent: 'Large bold text', asset_id: null, shot_type: 'graphic', on_screen_text: 'Ship it', graphic_template: 'text-card', graphic_data: {}, generation_prompt: 'text card', transition: ''}
      ], total_duration_seconds: 7});
    } else {
      text = '# Research\n\n## Summary\n\nRobot safety depends on procedures.\n\n## Key findings\n\n- The emergency stop is on the left post.\n\n## Claims to verify\n\n- Nothing unverified.';
    }
    return Response.json({id: 'msg_1', model: 'test-model', stop_reason: 'end_turn', content: [{type: 'text', text}], usage: {input_tokens: 5, output_tokens: 5}});
  };

  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model', OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'whisper-1'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    providerFetch,
    // Graphics are drawn with FFmpeg here; the real browser renderer is covered by tests/render.test.js.
    renderGraphic: async ({outputPath, seconds, fps}) => {
      fs.mkdirSync(path.dirname(outputPath), {recursive: true});
      // Deliberately not black: QC blocks a video that holds black, and this fixture is meant to pass.
      execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2f6f4f:s=320x180:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outputPath], {stdio: 'ignore'});
      const frames = Math.max(1, Math.round((fps || 24) * seconds));
      return {path: outputPath, template: 'injected', width: 320, height: 180, fps: fps || 24, frameCount: frames, durationSeconds: seconds, bytes: fs.statSync(outputPath).size};
    },
    graphicFps: 4
  });
  const baseUrl = await listen(server);

  try {
    const created = await api(baseUrl, '/api/projects', {prompt: 'A video about robot safety for plant managers.'});
    const folder = created.payload.folder;
    const directory = path.join(projectsRoot, folder);

    let intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
    await api(baseUrl, '/api/projects/' + folder + '/brief', Object.assign({}, intake.payload.brief, {angle: 'Practical guidance', purpose: 'Reduce risk', revision: intake.payload.project.workflow.revision}));

    const mediaPath = path.join(root, 'clip.mp4');
    execFileSync(FFMPEG.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x480:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mediaPath], {stdio: 'ignore'});
    const upload = await fetch(baseUrl + '/api/library/upload?name=clip.mp4&category=media', {method: 'POST', headers: {'content-type': 'application/octet-stream'}, body: fs.readFileSync(mediaPath)});
    state.assetId = (await upload.json()).asset.id;
    await api(baseUrl, '/api/library/rights', {asset_ids: [state.assetId], basis: 'own'});

    intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
    await api(baseUrl, '/api/projects/' + folder + '/materials', {revision: intake.payload.project.workflow.revision, asset_id: state.assetId, decision: 'use'});
    intake = await api(baseUrl, '/api/projects/' + folder + '/intake');
    await api(baseUrl, '/api/projects/' + folder + '/materials-confirm', {revision: intake.payload.project.workflow.revision});

    const approve = async (stage) => {
      const current = await api(baseUrl, '/api/projects/' + folder + '/intake');
      await api(baseUrl, '/api/projects/' + folder + '/approvals/' + stage, {decision: 'approved', revision: current.payload.project.workflow.revision, stage_revision: current.payload.project.workflow.stages[stage].revision});
    };
    await api(baseUrl, '/api/projects/' + folder + '/research', {provider: 'anthropic', web_search: false, include_materials: false});
    await approve('research');
    await api(baseUrl, '/api/projects/' + folder + '/strategy', {provider: 'anthropic'});
    await approve('strategy');
    await api(baseUrl, '/api/projects/' + folder + '/script', {provider: 'anthropic'});
    await approve('script');
    const board = await api(baseUrl, '/api/projects/' + folder + '/storyboard', {provider: 'anthropic'});
    assert.equal(board.status, 200, 'storyboard: ' + JSON.stringify(board.payload).slice(0, 300));
    await approve('storyboard');

    // --- assets ---
    const assets = await api(baseUrl, '/api/projects/' + folder + '/assets', {});
    assert.equal(assets.status, 200, 'assets: ' + JSON.stringify(assets.payload).slice(0, 400));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'generated/asset_manifest.json'), 'utf8'));
    assert.equal(manifest.counts.own_media, 1, 'one scene uses own media');
    assert.equal(manifest.counts.rendered, 2, 'two scenes are drawn locally');
    assert.equal(manifest.counts.still_missing, 0, 'nothing is left unfilled, so the composer needs no placeholder');
    assert.equal(manifest.narration.produced, 2, 'both sections were narrated');
    assert.ok(state.speechCalls >= 2, 'the speech endpoint was called for each section');
    for (const section of manifest.narration.sections) {
      assert.equal(section.status, 'done');
      assert.ok(section.duration_seconds > 0.5, 'the narration duration must be measured from the real file, got ' + section.duration_seconds);
    }

    // --- compose ---
    const render = await api(baseUrl, '/api/projects/' + folder + '/render', {});
    assert.equal(render.status, 200, 'render: ' + JSON.stringify(render.payload).slice(0, 600));
    assert.deepEqual(render.payload.artifact.blocking_issues, [], 'QC must not block a project where every scene is filled');
    assert.equal(render.payload.artifact.can_approve_master, true);
    assert.equal(render.payload.project.status, 'qc_passed');
    assert.equal(render.payload.project.master_video.path, 'final/youtube_master.mp4');
    assert.equal(render.payload.project.master_video.can_approve, true);

    // The master is a real, playable file that matches the plan.
    const masterPath = path.join(directory, 'final/youtube_master.mp4');
    assert.ok(fs.existsSync(masterPath), 'the master must exist');
    const master = probeMaster(masterPath);
    assert.equal(master.codec, 'h264');
    assert.equal(master.width, 1920);
    assert.equal(master.height, 1080);
    assert.equal(master.rate, '24/1');
    assert.equal(master.hasAudio, true, 'the master must carry the narration');
    assert.equal(master.audioCodec, 'aac');
    assert.ok(Math.abs(master.duration - 7) < 1, 'planned 7s, measured ' + master.duration);

    // --- the timeline ---
    const timeline = JSON.parse(fs.readFileSync(path.join(directory, 'compose/timeline.json'), 'utf8'));
    assert.deepEqual(timeline.tracks.map(track => track.id), ['visuals', 'narration', 'captions']);
    const visuals = timeline.tracks[0].clips;
    assert.equal(visuals.length, 3);
    assert.deepEqual(visuals.map(clip => clip.source), ['own_media', 'rendered', 'rendered']);
    assert.deepEqual(visuals.map(clip => clip.start_seconds), [0, 2, 5]);
    assert.equal(timeline.duration_seconds, 7);
    assert.equal(visuals[0].asset_id, state.assetId, 'own media is referenced by asset id, not by a path');
    assert.equal(visuals[0].path, null, 'library media lives outside the project, so it has no project path');
    assert.ok(visuals[0].library_file, 'the library file is named so the composer can be audited');

    // The body section spans two scenes, so its audio is split rather than repeated.
    const narration = timeline.tracks[1].clips;
    const bodyClips = narration.filter(clip => clip.section_id === 'body');
    assert.equal(bodyClips.length, 2, 'two scenes carry the body section');
    assert.equal(bodyClips[0].audio_offset_seconds, 0);
    assert.ok(bodyClips[1].audio_offset_seconds > 0, 'the second scene starts part way into the section, got ' + bodyClips[1].audio_offset_seconds);
    assert.ok(bodyClips[1].audio_span_seconds > 0 && bodyClips[1].audio_span_seconds < bodyClips[0].audio_span_seconds, 'the shorter scene gets the shorter slice');

    // --- captions ---
    const srt = fs.readFileSync(path.join(directory, 'compose/captions.srt'), 'utf8');
    assert.ok(srt.includes('-->'), 'the captions must be a real SRT');
    const captionResult = captions.captionsFor({timeline, script: JSON.parse(fs.readFileSync(path.join(directory, 'script/script.json'), 'utf8'))});
    assert.deepEqual(captions.cueProblems(captionResult.cues, master.duration), [], 'captions must line up with the video');
    const spoken = captionResult.cues.map(cue => cue.text.replace(/\n/g, ' ')).join(' ');
    for (const sentence of [SECTION_HOOK, SECTION_BODY]) {
      const words = sentence.replace(/[.]/g, '').split(' ').filter(Boolean);
      for (const word of words) assert.ok(spoken.includes(word), 'the caption text must contain "' + word + '"');
    }
    assert.equal(spoken.split('Check the light curtain before entry').length - 1, 1, 'a shared section must be captioned once, not once per scene');
    assert.ok(captionResult.cues.some(cue => cue.scene_id === 'scene_two'), 'the first body scene must carry captions');
    assert.ok(captionResult.cues.some(cue => cue.scene_id === 'scene_three'), 'the second body scene must carry captions too');

    // --- QC, the render log and cleanup ---
    const qc = JSON.parse(fs.readFileSync(path.join(directory, 'qc/qc_report.json'), 'utf8'));
    assert.deepEqual(qc.blocking_issues, []);
    assert.equal(qc.can_approve_master, true);
    const ids = qc.checks.map(item => item.id);
    for (const id of ['scenes_have_media', 'rights_cleared', 'master_exists', 'master_readable', 'duration_matches_plan', 'resolution', 'frame_rate', 'has_audio', 'caption_timing', 'script_coverage', 'black_frames', 'loudness']) {
      assert.ok(ids.includes(id), 'QC must include the ' + id + ' check');
    }
    assert.ok(qc.measured.loudness_lufs < 0, 'loudness must be measured, got ' + qc.measured.loudness_lufs);
    assert.ok(fs.readFileSync(path.join(directory, 'qc/qc_report.md'), 'utf8').includes('Status: passed'));

    const log = JSON.parse(fs.readFileSync(path.join(directory, 'compose/render_log.json'), 'utf8'));
    assert.ok(log.commands.length >= 8, 'every FFmpeg command must be recorded, got ' + log.commands.length);
    assert.ok(log.commands.every(entry => entry.command.includes('ffmpeg')), 'the log records real commands');

    assert.ok(!fs.existsSync(path.join(directory, 'compose/segments')), 'the working segments must be cleaned up');

    // The results API serves the composer output.
    const results = await api(baseUrl, '/api/projects/' + folder + '/results/render');
    assert.equal(results.status, 200);
    assert.equal(results.payload.files.length, 5);
    assert.ok(results.payload.files.every(file => typeof file.content === 'string'));

    // Composing again is stable and does not change the plan's shape.
    const again = await api(baseUrl, '/api/projects/' + folder + '/render', {});
    assert.equal(again.status, 200);
    assert.equal(again.payload.artifact.duration_seconds, 7);
    assert.equal(again.payload.artifact.can_approve_master, true);

    console.log('All composer tests passed: real master, split narration, captions, QC and render log.');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await close(server);
    fs.rmSync(root, {recursive: true, force: true});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
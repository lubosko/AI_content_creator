"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServer } = require("../src/server");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  return { response, payload };
}

/* Creative stages are provider-backed now, so the mock answers the Messages API with the shape each
   stage needs: Markdown with the required headings for research, JSON for strategy and script.
   No paid calls are made. */
let storyboardAssetId = null;

const providerResponse = (url, options) => {
  const body = JSON.parse(options.body || '{}');
  const prompt = JSON.stringify(body.messages || '');
  const isStoryboard = prompt.includes('Plan the storyboard');
  const isStrategy = prompt.includes('Create the content strategy');
  const isScript = prompt.includes('Write the full narration script');
  const text = isStoryboard
    ? JSON.stringify({
        scenes: [
          // The first scene selects the project's real asset; the second has none and must be listed as missing.
          {id: 'hook', title: 'Hook', narration_section_id: 'hook', seconds: 20, visual_intent: 'Factory floor', asset_id: storyboardAssetId, shot_type: 'wide', on_screen_text: '', generation_prompt: 'Wide shot of a robot cell at dawn', transition: 'cut'},
          {id: 'body', title: 'Body', narration_section_id: 'body', seconds: 120, visual_intent: 'Light curtain', asset_id: null, shot_type: 'close-up', on_screen_text: 'Check weekly', generation_prompt: 'Close-up of a light curtain', transition: ''}
        ],
        total_duration_seconds: 140
      })
    : isStrategy
      ? JSON.stringify({
          story_promise: 'Understand robot safety basics',
          target_audience: 'Plant managers',
          angle: 'Practical safety first',
          structure: [{section: 'Hook', purpose: 'Open with the risk', seconds: 20}, {section: 'Body', purpose: 'Explain the rules', seconds: 120}],
          hooks: ['The robot will not warn you.'],
          retention_moments: ['the emergency stop'],
          material_usage: [],
          short_form_opportunities: ['the emergency stop'],
          risks: []
        })
      : isScript
        ? JSON.stringify({
            sections: [
              {id: 'hook', title: 'Hook', narration: 'Robots do not warn you.', visual_notes: ['factory floor'], seconds: 20, source_refs: ['research'], short_form: true},
              {id: 'body', title: 'Body', narration: 'Check the light curtain before entry.', visual_notes: ['light curtain'], seconds: 120, source_refs: ['research'], short_form: false}
            ],
            estimated_duration_seconds: 140
          })
        : '# Research\n\n## Summary\n\nRobot safety depends on procedures.\n\n## Key findings\n\n- The emergency stop is on the left post.\n\n## Claims to verify\n\n- Nothing unverified.';
  return Response.json({
    id: 'msg_1', model: 'test-model', stop_reason: 'end_turn',
    content: [{type: 'text', text}],
    usage: {input_tokens: 10, output_tokens: 20}
  });
};

async function withTestServer(testFn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-agent-server-"));
  const projectsRoot = path.join(root, "projects");
  const server = createServer({
    projectsRoot,
    libraryRoot: path.join(root, "library"),
    settingsFile: path.join(root, "settings.json"),
    env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    providerFetch: providerResponse
  });
  const baseUrl = await listen(server);

  try {
    await testFn({ baseUrl, projectsRoot, root });
  } finally {
    await close(server);
  }
}

async function testEmptyProjectListing() {
  await withTestServer(async ({ baseUrl }) => {
    const { response, payload } = await requestJson(baseUrl, "/api/projects");

    assert.equal(response.status, 200);
    assert.deepEqual(payload.projects, []);
  });
}
async function testSuccessfulServerProjectCreation() {
  await withTestServer(async ({ baseUrl, projectsRoot }) => {
    const { response, payload } = await requestJson(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        prompt: "Create a 6-minute YouTube video about robot safety for plant managers.",
        language: "English",
        tone: "Practical and precise",
        targetDurationSeconds: 360,
        targetPlatforms: ["youtube", "tiktok"],
        llmProvider: "openai",
        sceneProvider: "leonardo",
        sequenceProvider: "mootion",
        voiceProvider: "elevenlabs"
      })
    });

    assert.equal(response.status, 201);
    assert.equal(payload.project.project_id, "2026-001");
    assert.equal(payload.project.topic, "Robot Safety");
    assert.equal(payload.project.tone, "Practical and precise");
    assert.equal(payload.project.target_duration_seconds, 360);
    assert.deepEqual(payload.project.target_platforms, ["youtube", "tiktok"]);
    assert.ok(fs.existsSync(path.join(projectsRoot, payload.folder, "project.json")));
  });
}

async function testMissingPrompt() {
  await withTestServer(async ({ baseUrl }) => {
    const { response, payload } = await requestJson(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ prompt: "" })
    });

    assert.equal(response.status, 400);
    assert.equal(payload.error, "A project prompt is required.");
  });
}

async function testDuplicateId() {
  await withTestServer(async ({ baseUrl }) => {
    const body = {
      projectId: "custom-001",
      slug: "same-topic",
      prompt: "Create a video about duplicate project handling."
    };

    const first = await requestJson(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const second = await requestJson(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify(body)
    });

    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 409);
    assert.match(second.payload.error, /Project already exists/u);
  });
}

async function testProjectListing() {
  await withTestServer(async ({ baseUrl }) => {
    await requestJson(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ prompt: "Create a video about listing local projects." })
    });

    const { response, payload } = await requestJson(baseUrl, "/api/projects");
    assert.equal(response.status, 200);
    assert.equal(payload.projects.length, 1);
    assert.equal(payload.projects[0].project_id, "2026-001");
    assert.equal(payload.projects[0].status, "created");
    assert.ok(payload.projects[0].folder.startsWith("2026-001-"));
  });
}

async function testWorkflowGenerationSteps() {
  await withTestServer(async ({ baseUrl, projectsRoot, root }) => {
    const created = await requestJson(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        prompt: "Create a 3-minute video about DORA-rs for robotics developers.",
        targetDurationSeconds: 180
      })
    });
    const folder = created.payload.folder;
    const intakeResponse = await requestJson(baseUrl, `/api/projects/${folder}/intake`);
    const confirmed = await requestJson(baseUrl, `/api/projects/${folder}/brief`, {method:'POST',body:JSON.stringify({ ...intakeResponse.payload.brief, angle:'Practical introduction', purpose:'Understand the system', revision:0 })});
    assert.equal(confirmed.response.status,200);

    // A real piece of own media, analyzed, so the storyboard has something genuine to select.
    // A generated clip avoids the mocked network fetch, so the analysis is real.
    const {execFileSync} = require('node:child_process');
    const {detectMediaTools} = require('../src/config/capabilities');
    const ffmpeg = detectMediaTools().find(tool => tool.name === 'ffmpeg');
    assert.ok(ffmpeg && ffmpeg.available, 'ffmpeg is required to build the storyboard fixture');
    const mediaPath = path.join(root, 'factory-clip.mp4');
    execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', mediaPath], {stdio: 'ignore'});
    const media = await requestJson(baseUrl, '/api/library/upload?name=factory-clip.mp4&category=media', {
      method: 'POST',
      headers: {'content-type': 'application/octet-stream'},
      body: fs.readFileSync(mediaPath)
    });
    storyboardAssetId = media.payload.asset.id;
    assert.equal(media.response.status, 201);
    const analyzed = await requestJson(baseUrl, `/api/library/${storyboardAssetId}/analyze`, {method: 'POST', body: '{}'});
    assert.equal(analyzed.payload.summary.state, 'analyzed', 'The asset must be analyzed before a storyboard can select it: ' + JSON.stringify(analyzed.payload.summary));
    const selected = await requestJson(baseUrl, `/api/projects/${folder}/materials`, {
      method: 'POST',
      body: JSON.stringify({revision: confirmed.payload.project.workflow.revision, asset_id: storyboardAssetId, decision: 'use'})
    });
    assert.equal(selected.response.status, 200);

    // The rights gate: material marked Use with no recorded basis must not be confirmable, because
    // confirming it is what lets the material into research, the storyboard and eventually a render.
    const ungated = await requestJson(baseUrl, `/api/projects/${folder}/materials-confirm`, {method:'POST',body:JSON.stringify({revision:selected.payload.project.workflow.revision})});
    assert.equal(ungated.response.status, 409, 'Confirming material with unrecorded rights must be refused');
    assert.match(ungated.payload.error, /Rights are not confirmed/, 'The refusal must say why: ' + ungated.payload.error);

    // This clip was generated by the test, so its basis is the operator's own work.
    const rights = await requestJson(baseUrl, '/api/library/rights', {method:'POST',body:JSON.stringify({asset_ids:[storyboardAssetId], basis:'own'})});
    assert.equal(rights.response.status, 200);
    assert.equal(rights.payload.assets[0].rights_summary.state, 'cleared', 'Own work must clear the gate');
    assert.equal(rights.payload.assets[0].rights.basis, 'own');

    const materials = await requestJson(baseUrl, `/api/projects/${folder}/materials-confirm`, {method:'POST',body:JSON.stringify({revision:selected.payload.project.workflow.revision})});
    assert.equal(materials.response.status,200);

    // Research is provider-backed and needs its options; the request must also cover approvals.
    const researchOptions = JSON.stringify({provider: 'anthropic', web_search: false, include_materials: false});
    const missingOptions = await requestJson(baseUrl, `/api/projects/${folder}/research`, {method: 'POST', body: JSON.stringify({provider: 'anthropic'})});
    assert.equal(missingOptions.response.status, 400, 'Research must refuse to run without its options');

    const research = await requestJson(baseUrl, `/api/projects/${folder}/research`, {method: 'POST', body: researchOptions});
    assert.equal(research.response.status, 200, 'research failed: ' + JSON.stringify(research.payload));
    assert.equal(research.payload.project.status, "research_ready");
    assert.equal(research.payload.project.workflow.stages.research.state, 'needs_review');
    const researchNotes = fs.readFileSync(path.join(projectsRoot, folder, "research", "research_notes.md"), "utf8");
    assert.ok(researchNotes.includes('## Summary'), 'The provider research must be saved');

    const saved = await requestJson(baseUrl, `/api/projects/${folder}/results/research`);
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.files[0].content, fs.readFileSync(path.join(projectsRoot, folder, 'research/research_notes.md'), 'utf8'));
    assert.equal(saved.payload.files.length, 4);
    assert.equal((await requestJson(baseUrl, '/api/projects/missing/results/research')).response.status, 404);
    assert.equal((await fetch(baseUrl + '/api/projects/' + folder + '/results/unknown')).status, 404);

    // An approval is recorded against the exact revision it reviewed.
    const revisionOf = payload => payload.project.workflow.revision;
    const missingDecision = await requestJson(baseUrl, `/api/projects/${folder}/approvals/research`, {method: 'POST', body: JSON.stringify({revision: 0})});
    assert.equal(missingDecision.response.status, 400, 'A decision must be approved or changes_requested');

    let state = (await requestJson(baseUrl, `/api/projects/${folder}/intake`)).payload;
    const approveResearch = await requestJson(baseUrl, `/api/projects/${folder}/approvals/research`, {
      method: 'POST',
      body: JSON.stringify({decision: 'approved', revision: revisionOf(state), stage_revision: state.project.workflow.stages.research.revision})
    });
    assert.equal(approveResearch.response.status, 200);
    assert.equal(approveResearch.payload.project.workflow.stages.research.state, 'approved');
    assert.equal(approveResearch.payload.project.workflow.stages.strategy.state, 'ready', 'Approving research unlocks strategy');
    const records = approveResearch.payload.project.workflow.approvals;
    const last = records[records.length - 1];
    assert.equal(last.stage, 'research', 'The research decision must be recorded');
    assert.equal(last.decision, 'approved');
    assert.equal(last.revision, state.project.workflow.stages.research.revision, 'The record must name the revision it reviewed');

    const strategy = await requestJson(baseUrl, `/api/projects/${folder}/strategy`, {method: 'POST', body: '{}'});
    assert.equal(strategy.response.status, 200);
    assert.equal(strategy.payload.project.status, 'strategy_ready');
    assert.ok(fs.readFileSync(path.join(projectsRoot, folder, 'strategy', 'content_strategy.md'), 'utf8').includes('Story promise'));

    state = (await requestJson(baseUrl, `/api/projects/${folder}/intake`)).payload;
    const approveStrategy = await requestJson(baseUrl, `/api/projects/${folder}/approvals/strategy`, {
      method: 'POST',
      body: JSON.stringify({decision: 'approved', revision: revisionOf(state), stage_revision: state.project.workflow.stages.strategy.revision})
    });
    assert.equal(approveStrategy.response.status, 200);

    const script = await requestJson(baseUrl, `/api/projects/${folder}/script`, { method: "POST", body: '{}' });
    assert.equal(script.response.status, 200);
    assert.equal(script.payload.project.status, "script_ready");
    assert.ok(fs.readFileSync(path.join(projectsRoot, folder, "script", "script.md"), "utf8").includes("Robots do not warn you"));
    const scriptJson = readJson(path.join(projectsRoot, folder, 'script', 'script.json'));
    assert.equal(scriptJson.sections.length, 2);
    assert.ok(scriptJson.sections[0].source_refs.length, 'Script sections must record what they are based on');

    // A stale approval must be refused rather than silently accepted.
    const stale = await requestJson(baseUrl, `/api/projects/${folder}/approvals/script`, {
      method: 'POST',
      body: JSON.stringify({decision: 'approved', revision: 0, stage_revision: 1})
    });
    assert.equal(stale.response.status, 409, 'An approval for a stale revision must be refused');

    const storyboard = await requestJson(baseUrl, `/api/projects/${folder}/storyboard`, { method: "POST" });
    assert.equal(storyboard.response.status, 200);
    assert.equal(storyboard.payload.project.status, "storyboard_ready");
    const storyboardJson = readJson(path.join(projectsRoot, folder, "storyboard", "storyboard.json"));
    assert.equal(storyboardJson.scenes.length, 2);
    assert.equal(storyboardJson.scenes[0].narration_section_id, 'hook', 'A scene must reference the script section it came from');
    // A scene that selected real own media must keep that selection.
    assert.equal(storyboardJson.scenes[0].asset_id, storyboardAssetId, 'The selected real asset must survive validation');
    assert.deepEqual(storyboardJson.selected_asset_ids, [storyboardAssetId]);
    // A scene with nothing available must be listed as a missing asset with a usable prompt.
    assert.equal(storyboardJson.scenes[1].asset_id, null);
    assert.equal(storyboardJson.missing_assets.length, 1);
    assert.equal(storyboardJson.missing_assets[0].scene_id, 'body');
    assert.match(storyboardJson.missing_assets[0].generation_prompt, /light curtain/i);
    const scenePrompts = readJson(path.join(projectsRoot, folder, 'storyboard', 'scene_prompts.json'));
    assert.equal(scenePrompts.prompts.length, 1, 'Only scenes without an asset need a generation prompt');
    assert.equal(scenePrompts.prompts[0].scene_id, 'body');
    // The storyboard is provider-backed now, so the template notice must be gone.
    assert.equal(storyboard.payload.artifact.template, undefined, 'The storyboard must not report itself as a template');
    assert.equal(storyboard.payload.artifact.missing_assets, 1);

    // The composer needs produced assets, and says so rather than inventing a video from a plan.
    const tooEarly = await requestJson(baseUrl, `/api/projects/${folder}/render`, { method: "POST" });
    assert.equal(tooEarly.response.status, 409, 'Composing before the assets exist must be refused');
    assert.match(tooEarly.payload.error, /needs produced assets first/);
    for (const step of ['research', 'strategy', 'script', 'storyboard']) {
      const result = await requestJson(baseUrl, `/api/projects/${folder}/results/${step}`);
      assert.equal(result.response.status, 200);
      assert.ok(result.payload.files.every(file => typeof file.content === 'string'));
    }
    // An unknown step is not a route at all: there is no template fallback left to fall into.
    const unknown = await fetch(baseUrl + `/api/projects/${folder}/nonsense`, {method: 'POST'});
    assert.equal(unknown.status, 404);
  });
}

async function testWorkflowMissingProject() {
  await withTestServer(async ({ baseUrl }) => {
    const { response, payload } = await requestJson(baseUrl, "/api/projects/missing-project/research", { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal(payload.error, "Project not found.");
  });
}
async function testProjectJsonLoading() {
  await withTestServer(async ({ baseUrl }) => {
    const created = await requestJson(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({ prompt: "Create a video about loading project JSON." })
    });

    const { response, payload } = await requestJson(baseUrl, `/api/projects/${created.payload.folder}/project.json`);
    assert.equal(response.status, 200);
    assert.equal(payload.folder, created.payload.folder);
    assert.deepEqual(payload.project, created.payload.project);
  });
}

async function run() {
  await testEmptyProjectListing();
  await testSuccessfulServerProjectCreation();
  await testMissingPrompt();
  await testDuplicateId();
  await testProjectListing();
  await testWorkflowGenerationSteps();
  await testWorkflowMissingProject();
  await testProjectJsonLoading();
  console.log("All server tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});






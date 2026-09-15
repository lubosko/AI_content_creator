"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const {createClaudeProvider} = require('./providers/claude');
const openaiProvider = require('./providers/openai');
const speechProviderModule = require('./providers/speech');
const stockProviderModule = require('./providers/stock');
const archiveProvider = require('./providers/archive');
const openverseProvider = require('./providers/openverse');
const {createSourcing} = require('./lib/mediaSourcing');
const {generateResearch: generateProviderResearch, generateStrategy: generateProviderStrategy, generateScript: generateProviderScript, generateStoryboard: generateProviderStoryboard, generateAssets: generateProviderAssets} = require('./lib/providerStages');
const providerStages = require('./lib/providerStages');
const comfy = require('./providers/comfy');
const comfyWorkflows = require('./lib/comfyWorkflows');
const comfyGenerate = require('./lib/comfyGenerate');
const pipeline = require('./lib/pipeline');
const sceneAssets = require('./lib/sceneAssets');
const frameRenderer = require('./lib/frameRenderer');
const {createSettingsStore} = require('./config/settings');
const {mediaCapabilities} = require('./config/capabilities');
const {loadEnvironment} = require('./config/environment');
const intake = require('./lib/intakeWorkflow');
const licensing = require('./lib/licensing');
const {createLibrary} = require('./lib/materialLibrary');
const {analyzeAsset, analysisSummary, detectMediaTools} = require('./analyze');
const transcribe = require('./providers/transcribe');
const { createProject } = require("./lib/projectGenerator");
// Every creative stage is implemented, so no deterministic template generator remains.
const { resolveProjectDirectory } = require("./lib/projectPaths");

const RESULT_FILES = {
  research: ['research/research_notes.md', 'research/sources.json', 'research/fact_check.json', 'research/provider_result.json'],
  strategy: ['strategy/content_strategy.md', 'strategy/audience.json', 'strategy/retention_plan.json', 'strategy/material_usage.json'],
  script: ['script/script.md', 'script/script.json', 'script/hooks.md', 'script/shorts_candidates.json'],
  storyboard: ['storyboard/storyboard.json', 'storyboard/storyboard.md', 'storyboard/scene_prompts.json', 'storyboard/scene_prompts.md'],
  assets: ['generated/asset_manifest.json', 'generated/audio/narration_plan.json', 'analyzed/asset_index.json'],
  render: ['qc/qc_report.md', 'qc/qc_report.json', 'compose/timeline.json', 'compose/captions.srt', 'compose/render_log.json'],
  final: ['final/final_check.json', 'final/youtube_metadata.json'],
  exports: ['adaptations/export_manifest.json']
};
const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024;
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_PROJECTS_ROOT = path.join(ROOT_DIR, "projects");
const UI_DIR = path.join(ROOT_DIR, "src", "ui");
const DEFAULT_STATIC_FILE = path.join(UI_DIR, "index.html");
const UI_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* Types the interface plays or previews straight from a project folder. */
const PROJECT_FILE_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(message);
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = '', bytes = 0;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_BODY_BYTES) body += chunk;
    });
    request.on('end', () => {
      if (bytes > MAX_BODY_BYTES) { reject(Object.assign(new Error('Request body is too large.'), {status:413})); return; }
      try {
        const value = body.trim() ? JSON.parse(body) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(Object.assign(new Error('Request body must be a valid JSON object.'), {status:400})); }
    });
    request.on('error', reject);
  });
}

function normalizeFolderName(value) {
  const folderName = String(value || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(folderName)) return null;
  return folderName;
}

function getProjectJsonPath(projectsRoot, folderName) {
  const safeFolderName = normalizeFolderName(folderName);
  if (!safeFolderName) return null;

  const root = path.resolve(projectsRoot);
  const projectJsonPath = path.resolve(root, safeFolderName, "project.json");
  if (!projectJsonPath.startsWith(`${root}${path.sep}`)) return null;
  return projectJsonPath;
}

function readProject(projectJsonPath) {
  return JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
}

/* Serves a generated or written artifact from inside a project, so the interface can play the
   narration and preview produced clips. Only known media and text types are served, and the path
   must resolve inside the project directory. */
function sendProjectFile(request, response, projectDirectory, urlPath) {
  const relative = decodeURIComponent(urlPath.replace(/^\/api\/projects\/[^/]+\/files\//, ''));
  if (!relative || relative.includes('\0')) { sendText(response, 404, 'Not found'); return; }
  const base = path.resolve(projectDirectory);
  const filePath = path.resolve(base, relative);
  if (!filePath.startsWith(base + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(response, 404, 'Not found');
    return;
  }
  const type = PROJECT_FILE_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) { sendText(response, 415, 'That file type is not served.'); return; }

  const size = fs.statSync(filePath).size;
  let start = 0, end = size - 1, status = 200;
  if (request.headers.range) {
    const match = request.headers.range.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) { response.writeHead(416, {'content-range': 'bytes */' + size}); response.end(); return; }
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= size) { response.writeHead(416, {'content-range': 'bytes */' + size}); response.end(); return; }
    status = 206;
  }
  const headers = {
    'content-type': type,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
  if (status === 206) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + size;
  response.writeHead(status, headers);
  const stream = fs.createReadStream(filePath, {start, end});
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

function sendUiFile(response, urlPath) {  const relative = decodeURIComponent(urlPath.replace(/^\/ui\/?/, ""));
  const filePath = path.resolve(UI_DIR, relative);
  if (!filePath.startsWith(`${UI_DIR}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(response, 404, "Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": UI_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  fs.createReadStream(filePath).pipe(response);
}

function listProjects(projectsRoot) {
  if (!fs.existsSync(projectsRoot)) return [];

  return fs.readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const projectJsonPath = path.join(projectsRoot, entry.name, "project.json");
      if (!fs.existsSync(projectJsonPath)) return null;

      const project = readProject(projectJsonPath);
      return {
        folder: entry.name,
        project_id: project.project_id,
        topic: project.topic,
        status: project.status,
        approval_state: project.approval_state,
        target_duration_seconds: project.target_duration_seconds,
        created_at: project.created_at,
        updated_at: project.updated_at
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
}

function createProjectFromBody(body, projectsRoot) {
  return createProject({
    outDir: projectsRoot,
    prompt: body.prompt,
    projectId: body.projectId,
    slug: body.slug,
    topic: body.topic,
    language: body.language,
    tone: body.tone,
    targetDurationSeconds: body.targetDurationSeconds,
    primaryPlatform: body.primaryPlatform,
    targetPlatforms: body.targetPlatforms,
    llmProvider: body.llmProvider,
    llmModel: body.llmModel,
    sceneProvider: body.sceneProvider,
    sequenceProvider: body.sequenceProvider,
    voiceProvider: body.voiceProvider,
    voiceId: body.voiceId
  });
}

function createServer(options = {}) {

  const runningProjects = new Set();
  /* One place decides whether a project is busy, so a background pipeline and a manual stage cannot
     run over each other. A pipeline holds no request, so it cannot hold `runningProjects` itself. */
  const pipelineRunner = pipeline.createPipelineRunner();
  const busy = (folder) => runningProjects.has(folder) || pipelineRunner.isRunning(folder);
  const projectsRoot = path.resolve(options.projectsRoot || process.env.PROJECTS_ROOT || DEFAULT_PROJECTS_ROOT);
  const library = createLibrary(path.resolve(options.libraryRoot || process.env.LIBRARY_ROOT || path.join(projectsRoot, '_library')), options.maxUploadBytes);
  const mediaTools = () => detectMediaTools(options.capabilityOptions || {});

  /* One asset runs through the real analyzers; the thumbnail is written next to the stored original.
     `confirmLong` is the user's explicit agreement to pay for a long transcription. */
  async function analyzeOne(asset, options = {}) {
    library.setAnalysis(asset.id, {state: 'analyzing', startedAt: new Date().toISOString()});
    const credential = settings.credentials('openai');
    const transcription = credential.key && !credential.error
      ? {provider: 'openai', run: parts => transcribe.transcribeParts({
          parts,
          apiKey: credential.key,
          model: credential.model || 'whisper-1',
          fetchImpl: options.providerFetch || fetch
        })}
      : null;
    try {
      const outcome = await analyzeAsset(asset, {
        filePath: library.filePathFor(asset),
        thumbnailPath: library.thumbnailPathFor(asset),
        audioPath: library.audioPathFor(asset),
        fetchImpl: options.providerFetch || fetch,
        tools: mediaTools(),
        transcribe: options.transcribe === false ? null : transcription,
        confirmLong: !!options.confirmLong
      });
      return library.setAnalysis(asset.id, outcome).analysis;
    } finally {
      // The prepared audio is an intermediate: it is not the user's material and must not linger.
      library.clearAudio(asset);
    }
  }
  const settings = createSettingsStore({file:options.settingsFile || path.join(projectsRoot,'_settings','settings.json'),env:options.env || process.env,...(options.vault ? {vault:options.vault} : {})});
  // Probing spawns a process, so detect once per server rather than on every Settings request.
  const capabilities = options.capabilities || mediaCapabilities(options.capabilityOptions || {});
  // What transcription can do right now, so Settings can say so before a file is ever analyzed.
  const transcriptionCapability = () => {
    const credential = settings.credentials('openai');
    return {
      provider: 'openai',
      available: true,
      configured: !credential.error && !!credential.key,
      model: credential.model || 'whisper-1',
      error: credential.error || null,
      confirmOverSeconds: 600
    };
  };
  const claudeCredential = () => { const c=settings.credentials('anthropic'); return {credential:c,provider:()=>createClaudeProvider({env:{ANTHROPIC_API_KEY:c.key,ANTHROPIC_MODEL:c.model},fetchImpl:options.providerFetch || fetch})}; };
  const claude = () => claudeCredential().provider();

  /* Comfy generation. The workflow documents live in projects/_settings/comfy, and the base URL comes
     from the config file with COMFY_BASE_URL overriding it, so a self-hosted instance can be used
     without touching code. A client is built per request because the key can change in Settings. */
  function comfyClient() {
    const credential = settings.credentials('comfy');
    const configured = comfyWorkflows.workflowSummary(projectsRoot);
    const baseUrl = process.env.COMFY_BASE_URL || (configured && configured.base_url) || undefined;
    return comfy.createComfyClient({baseUrl, apiKey: credential.key, fetchImpl: options.providerFetch || fetch});
  }
  const comfyStatus = () => {
    const credential = settings.credentials('comfy');
    const configured = comfyWorkflows.workflowSummary(projectsRoot);
    const baseUrl = process.env.COMFY_BASE_URL || configured.base_url || comfy.DEFAULT_BASE_URL;
    return {
      provider: 'comfy',
      // `configured` is about the credential, which is what Settings acts on. Whether a workflow can
      // actually run is a separate question, answered by `workflow_ready`, because a config file that
      // names a missing workflow is not a working setup.
      configured: !credential.error && !!credential.key,
      workflow_ready: configured.configured === true,
      key_source: credential.source,
      error: credential.error || null,
      base_url: baseUrl,
      workflows: configured.workflows,
      default_workflow: configured.default || null,
      // A missing or broken workflows.json is the operator's next step, so it travels with the status.
      workflow_problem: configured.problem,
      workflow_config_path: configured.path
    };
  };

  // Connection checks for providers that have a real integration. Others store credentials only.
  const connectionTests = {
    anthropic: async () => claudeCredential().provider().test(),
    comfy: async () => {
      const state = comfyStatus();
      if (state.error) return Object.assign({}, state, {connected: false});
      if (!state.configured) return Object.assign({}, state, {connected: false, error: 'No Comfy API key is configured.'});
      const result = await comfyClient().test();
      return Object.assign({}, state, result);
    },
    openai: async () => {
      const credential = settings.credentials('openai');
      if (credential.error) return {provider: 'openai', configured: false, model: credential.model, error: credential.error};
      return openaiProvider.testConnection({apiKey: credential.key, model: credential.model, fetchImpl: options.providerFetch || fetch});
    }
  };
  const staticFile = path.resolve(options.staticFile || DEFAULT_STATIC_FILE);

  /* Narration and stock media are optional: without a key the stage reports what it could not do
     rather than failing the whole run. */
  function speechProvider() {
    const credential = settings.credentials('openai');
    if (credential.error || !credential.key) return null;
    return ({text, targetPath}) => speechProviderModule.speak({
      text,
      targetPath,
      apiKey: credential.key,
      model: credential.model,
      voice: options.voiceId || null,
      fetchImpl: options.providerFetch || fetch
    });
  }
  /* Media sourcing is a chain, not one vendor: Pexels when a key is present, then Archive.org and
     Openverse, which need no key. A source that is not usable is reported with its reason rather
     than silently omitted, so a scene with no footage can explain itself. */  function stockProvider() {
    const unavailable = [];
    const sources = [];
    const pexels = settings.credentials('pexels');
    if (pexels.error) unavailable.push({id: 'pexels', short: 'Pexels', mediaKinds: ['video'], reason: pexels.error});
    else if (!pexels.key) unavailable.push({id: 'pexels', short: 'Pexels', mediaKinds: ['video'], reason: 'No Pexels API key is configured. Add one in Settings to search its video library.'});
    else sources.push({
      id: 'pexels', short: 'Pexels', mediaKinds: ['video'],
      search: ({query, minDurationSeconds}) => stockProviderModule.searchVideo({query, minDurationSeconds, apiKey: pexels.key, fetchImpl: options.providerFetch || fetch}),
      download: ({url, targetPath}) => stockProviderModule.downloadClip({url, targetPath, fetchImpl: options.providerFetch || fetch})
    });

    sources.push({
      id: 'archive', short: 'Archive.org', mediaKinds: ['video'],
      search: ({query, minDurationSeconds}) => archiveProvider.searchVideo({query, minDurationSeconds, fetchImpl: options.providerFetch || fetch}),
      download: ({url, targetPath}) => archiveProvider.downloadClip({url, targetPath, fetchImpl: options.providerFetch || fetch})
    });
    sources.push({
      id: 'openverse', short: 'Openverse', mediaKinds: ['image'],
      search: ({query}) => openverseProvider.searchImage({query, fetchImpl: options.providerFetch || fetch}),
      download: ({url, targetPath}) => openverseProvider.downloadClip({url, targetPath, fetchImpl: options.providerFetch || fetch})
    });

    return createSourcing({sources, unavailable});
  }

  /* Surfaced for diagnostics: tests and operators can tell which fetch the provider path uses. */
  const providerFetch = options.providerFetch || fetch;

  /* What "run to final check" actually calls. Injected so the pipeline owns the sequencing and
     resumability while the server owns provider wiring, and so the pipeline is testable with fakes. */
  const pipelineDeps = (folder) => ({
    comfyReady: () => {
      const credential = settings.credentials('comfy');
      const configured = comfyWorkflows.workflowSummary(projectsRoot);
      return !credential.error && !!credential.key && configured.configured === true;
    },
    comfyUnavailableReason: () => {
      const credential = settings.credentials('comfy');
      const configured = comfyWorkflows.workflowSummary(projectsRoot);
      if (credential.error) return credential.error;
      if (!credential.key) return 'No Comfy API key is configured, so no scene was generated. Add one in Settings, or use the local templates and stock sourcing instead.';
      if (!configured.configured) return configured.problem || 'No Comfy workflow is configured, so no scene was generated.';
      return 'Comfy is not available, so no scene was generated.';
    },
    generateScene: async ({sceneId, prompt, signal, onProgress}) => {
      const client = comfyClient();
      const ctx = intake.context(projectsRoot, folder);
      const record = await comfyGenerate.submitGeneration({ctx, client, projectsRoot, sceneId, prompt});
      const snapshot = await client.waitFor(record.job_id, {signal, onProgress});
      void snapshot;
      const result = await comfyGenerate.pollGeneration({
        directory: ctx.directory, client, library, jobId: record.job_id,
        attach: (assetId, note) => providerStages.attachSceneAsset({
          projectsRoot, folder, library, sceneId, assetId, tool: 'Comfy Cloud', note
        })
      });
      if (!result.attached_asset_id) {
        throw Object.assign(new Error((result.record && result.record.error) || 'The scene could not be generated.'), {status: 502});
      }
      return {asset_id: result.attached_asset_id};
    },
    runAssets: () => providerStages.generateAssets({
      projectsRoot, folder, library,
      speech: speechProvider(), stock: stockProvider(),
      renderGraphic: options.renderGraphic, graphicFps: options.graphicFps
    }),
    runCompose: () => providerStages.composeProject({
      projectsRoot, folder, library,
      tools: options.tools,
      options: {keepSegments: options.keepSegments === true},
      renderPlaceholder: providerStages.placeholderRenderer({width: 1920, height: 1080, fps: 24, ffmpegPath: options.ffmpegPath})
    }),
    runFinal: () => providerStages.runFinalCheck({projectsRoot, folder, tools: options.tools})
  });


  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");

    try {
      if (request.method === 'POST' && requestUrl.pathname.startsWith('/api/settings')) {
        const origin=request.headers.origin;
        if (request.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== 'http://' + request.headers.host) || !String(request.headers['content-type'] || '').startsWith('application/json')) {
          sendJson(response,403,{error:'Settings changes require a same-origin JSON request.'}); return;
        }
      }
      if (requestUrl.pathname === '/api/settings') {
        if (request.method === 'GET') {sendJson(response,200,{...settings.summary(),capabilities,transcription:transcriptionCapability()});return;}
        if (request.method === 'POST') {sendJson(response,200,{...settings.update(await readRequestJson(request)),capabilities,transcription:transcriptionCapability()});return;}
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/settings/test') {
        const body=await readRequestJson(request), snapshot=settings.summary();
        if (body.revision !== snapshot.revision) intake.fail('Reload Settings before testing.',409);
        if (!Object.hasOwn(connectionTests, body.provider)) intake.fail('This provider is saved for a future integration. Connection testing is not implemented yet.',400);
        let outcome;
        try {
          const result = await connectionTests[body.provider]();
          // A key that cannot be decrypted is reported as an error state, not a thrown failure.
          if (result && result.error) outcome = {status:'error',message:result.error};
          else outcome = {status:'verified',message:result.message,model:result.model || null,modelAvailable:result.modelAvailable === undefined ? null : result.modelAvailable};
        } catch(error) { outcome={status:'error',message:error.message}; }
        sendJson(response,200,settings.recordTest(body.provider,snapshot.revision,outcome));return;
      }
      if (request.method === "GET" && requestUrl.pathname.startsWith("/ui/")) {
        sendUiFile(response, requestUrl.pathname);
        return;
      }
      const projectFileMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/files\//);
      if (request.method === 'GET' && projectFileMatch) {
        const folder = decodeURIComponent(projectFileMatch[1]);
        try {
          const directory = resolveProjectDirectory(projectsRoot, folder);
          sendProjectFile(request, response, directory, requestUrl.pathname);
        } catch (error) {
          sendText(response, 404, 'Project not found');
        }
        return;
      }
      if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html")) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        });
        fs.createReadStream(staticFile).pipe(response);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/render/templates') {
        // The vocabulary the interface offers, so it never hard-codes a template name of its own.
        sendJson(response,200,{
          templates: sceneAssets.graphicTemplates(),
          profiles: sceneAssets.toolProfiles(),
          master: {fps: frameRenderer.DEFAULT_FPS, width: frameRenderer.DEFAULT_WIDTH, height: frameRenderer.DEFAULT_HEIGHT},
          preview: {fps: 12, width: 640, height: 360}
        });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/providers/sourcing') {
        // Which media sources are usable right now, and the reason for each one that is not.
        sendJson(response,200,stockProvider().describe()); return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/providers/research') {
        const {credential} = claudeCredential();
        // A saved key that cannot be decrypted is a recoverable state, not a server error.
        if (credential.error) { sendJson(response,200,{provider:'anthropic',configured:false,model:credential.model,error:credential.error}); return; }
        sendJson(response,200,claude().status()); return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/providers/research/test') {
        const {credential,provider} = claudeCredential();
        if (credential.error) { sendJson(response,200,{provider:'anthropic',configured:false,model:credential.model,error:credential.error}); return; }
        sendJson(response,200,await provider().test()); return;
      }
      if (requestUrl.pathname === '/api/library') {
        // The card renders from analysis_summary, so the client never has to interpret raw records.
        // The rights decision is made on the server for the same reason: the browser must not be the
        // thing that decides whether material may be used.
        if (request.method === 'GET') {
          sendJson(response,200,{
            // publishable is the server's answer to "can this item reach the video?", so the browser
            // states the same policy the gate applies instead of inventing a stricter one.
            assets: library.list().map(asset => ({...asset, publishable: licensing.publishable(asset), rights_summary: licensing.assessRights(asset.rights), analysis_summary: analysisSummary(asset)})),
            licences: licensing.licenceIds().map(id => ({id, ...licensing.licenceFor(id)})),
            max_upload_bytes: library.maxBytes
          });
          return;
        }
        if (request.method === 'POST') { sendJson(response,201,{ asset: library.addText(await readRequestJson(request)) }); return; }
      }
      /* Rights can be recorded for one item or many at once: footage shot in one session shares one
         basis, and typing it in per clip would push people towards skipping it. */
      if (request.method === 'POST' && requestUrl.pathname === '/api/library/rights') {
        const body = await readRequestJson(request);
        const ids = Array.isArray(body.asset_ids) ? body.asset_ids : [];
        if (!ids.length) intake.fail('Choose at least one item to record rights for.');
        if (ids.length > 500) intake.fail('Record rights for at most 500 items at a time.');
        for (const id of ids) library.get(id, false);
        const assets = ids.map(id => library.setRights(id, body));
        sendJson(response,200,{updated:assets.length, assets:assets.map(asset => ({id:asset.id, name:asset.name, rights:asset.rights, rights_summary: licensing.assessRights(asset.rights)}))});
        return;
      }
      const rightsMatch = requestUrl.pathname.match(/^\/api\/library\/([a-f0-9-]+)\/rights$/);
      if (request.method === 'POST' && rightsMatch) {
        const asset = library.setRights(rightsMatch[1], await readRequestJson(request));
        sendJson(response,200,{asset:{...asset, rights_summary: licensing.assessRights(asset.rights)}});
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/library/upload') {
        const asset = await library.upload(request, requestUrl.searchParams.get('name'), requestUrl.searchParams.get('category'));
        sendJson(response,201,{asset}); return;
      }
      const fileMatch = requestUrl.pathname.match(/^\/api\/library\/([a-f0-9-]+)\/file$/);
      if (request.method === 'GET' && fileMatch) { library.serve(request,response,fileMatch[1]); return; }
      const thumbMatch = requestUrl.pathname.match(/^\/api\/library\/([a-f0-9-]+)\/thumbnail$/);
      if (request.method === 'GET' && thumbMatch) { library.serveThumbnail(response,thumbMatch[1]); return; }

      // Analysis routes. analyze-pending is matched first so it is not read as an asset id.
      if (request.method === 'POST' && requestUrl.pathname === '/api/library/analyze-pending') {
        const pending = library.list().filter(asset => {
          const record = asset.analysis || {};
          const state = record.state || asset.analysis_state || 'awaiting_analysis';
          // Only retry failures a retry could actually fix, or a sweep would never terminate.
          // needs_confirmation is excluded on purpose: a sweep must never spend money on its own.
          return state === 'awaiting_analysis' || (state === 'failed' && record.retryable !== false) || (state === 'analyzing' && !record.startedAt);
        });
        const results = [];
        for (const asset of pending) {
          try { results.push({asset_id: asset.id, name: asset.name, outcome: (await analyzeOne(asset)).state}); }
          catch (error) { results.push({asset_id: asset.id, name: asset.name, outcome: 'failed', reason: error.message}); }
        }
        const count = state => results.filter(item => item.outcome === state).length;
        sendJson(response,200,{
          analyzed: count('analyzed'),
          failed: count('failed'),
          unsupported: count('unsupported'),
          await_confirmation: count('needs_confirmation'),
          attempted: results.length,
          remaining: library.list().filter(asset => ((asset.analysis || {}).state || asset.analysis_state) === 'awaiting_analysis').length,
          results
        });
        return;
      }
      const analyzeMatch = requestUrl.pathname.match(/^\/api\/library\/([a-f0-9-]+)\/analyze$/);
      if (request.method === 'POST' && analyzeMatch) {
        const body = await readRequestJson(request);
        const asset = library.get(analyzeMatch[1]);
        const record = await analyzeOne(asset, {confirmLong: body.confirm_long === true});
        const fresh = library.get(asset.id, false);
        sendJson(response,200,{asset: fresh, analysis: record, summary: analysisSummary(fresh)});
        return;
      }
      const analysisMatch = requestUrl.pathname.match(/^\/api\/library\/([a-f0-9-]+)\/analysis$/);
      if (request.method === 'GET' && analysisMatch) {
        const asset = library.get(analysisMatch[1], false);
        sendJson(response,200,{asset_id: asset.id, name: asset.name, summary: analysisSummary(asset), analysis: asset.analysis || null});
        return;
      }
      const intakeMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/(intake|brief|materials|materials-confirm)$/);
      if (intakeMatch) {
        const folder = decodeURIComponent(intakeMatch[1]);
        if (request.method === 'GET' && intakeMatch[2] === 'intake') {
          const ctx = intake.context(projectsRoot,folder);
          sendJson(response,200,{folder,project:ctx.project,brief:ctx.brief}); return;
        }
        if (request.method === 'POST') {
          const body = await readRequestJson(request);
          // Reload after awaiting the body to check the latest revision, not a stale snapshot.
          if (busy(folder)) intake.fail('Research is running. Wait before changing this project.',409);
          const ctx = intake.context(projectsRoot,folder);
          if (intakeMatch[2] === 'brief') intake.confirmBrief(ctx,body);
          else if (intakeMatch[2] === 'materials') intake.selectMaterial(ctx,body,library.get(body.asset_id, body.decision !== 'remove'));
          else if (intakeMatch[2] === 'materials-confirm') intake.confirmMaterials(ctx,body,library.get);
          else { sendJson(response,405,{error:'Method not allowed.'}); return; }
          sendJson(response,200,{folder,project:ctx.project,brief:ctx.brief}); return;
        }
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/projects") {
        sendJson(response, 200, { projects: listProjects(projectsRoot) });
        return;
      }

      if (request.method === "GET") {
        /* Run to final check: the record of the last run, plus what a new run would need. The
           preflight is computed here so the interface can disable Start with the real reason. */
        const pipelineMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/pipeline$/u);
        if (pipelineMatch) {
          const folder = decodeURIComponent(pipelineMatch[1]);
          const ctx = intake.context(projectsRoot, folder);
          const board = comfyGenerate.readBoardOrNull(ctx.directory);
          const check = pipeline.preflight(ctx);
          sendJson(response, 200, {
            folder,
            run: pipelineRunner.status(ctx.directory, folder),
            can_start: check.ok,
            problems: check.problems,
            comfy: comfyStatus(),
            plan: {
              scenes_needing_media: pipeline.scenesNeedingMedia(board).length,
              scenes_to_generate: pipeline.generatableScenes(board).length,
              storyboard_approved: (((ctx.project.workflow || {}).stages || {}).storyboard || {}).state === 'approved'
            }
          });
          return;
        }

        /* What has already been generated for one scene, so a reload re-attaches to a job still
           running instead of offering to spend credits on it a second time. */
        const sceneGenerationMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/generation$/u);
        if (sceneGenerationMatch) {
          const folder = decodeURIComponent(sceneGenerationMatch[1]);
          const sceneId = decodeURIComponent(sceneGenerationMatch[2]);
          const ctx = intake.context(projectsRoot, folder);
          sendJson(response, 200, {
            folder, scene_id: sceneId,
            generation: comfyGenerate.sceneGenerationState(ctx.directory, sceneId),
            comfy: comfyStatus()
          });
          return;
        }

        /* Watching a Comfy generation. This polls upstream once and, on the first success, imports
           and attaches the result exactly once, so a repeated poll cannot double-import. */
        const generateStatusMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/generate\/([^/]+)$/u);
        if (generateStatusMatch) {
          const folder = decodeURIComponent(generateStatusMatch[1]);
          const sceneId = decodeURIComponent(generateStatusMatch[2]);
          const jobId = decodeURIComponent(generateStatusMatch[3]);
          const ctx = intake.context(projectsRoot, folder);
          const result = await comfyGenerate.pollGeneration({
            directory: ctx.directory, client: comfyClient(), library, jobId,
            attach: async (assetId, note) => {
              const attached = await providerStages.attachSceneAsset({
                projectsRoot, folder, library, sceneId, assetId, tool: 'Comfy Cloud', note
              });
              return attached;
            }
          });
          sendJson(response, 200, {
            folder, scene_id: sceneId, job: result.record,
            attached_asset_id: result.attached_asset_id || null, done: !!result.done
          });
          return;
        }

        const comfyConfigMatch = requestUrl.pathname.match(/^\/api\/providers\/comfy$/u);
        if (comfyConfigMatch) {
          sendJson(response, 200, comfyStatus());
          return;
        }

        const resultMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/results\/(research|strategy|script|storyboard|assets|render|final|exports)$/u);
        if (resultMatch) {
          const projectPath = getProjectJsonPath(projectsRoot, decodeURIComponent(resultMatch[1]));
          if (!projectPath || !fs.existsSync(projectPath)) {
            sendJson(response, 404, { error: "Project not found." });
            return;
          }
          const files = RESULT_FILES[resultMatch[2]].map((relativePath) => {
            const filePath = path.join(path.dirname(projectPath), relativePath);
            return { path: relativePath, content: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null };
          });
          sendJson(response, 200, { files });
          return;
        }
        const match = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/project\.json$/u);
        if (match) {
          const projectJsonPath = getProjectJsonPath(projectsRoot, decodeURIComponent(match[1]));
          if (!projectJsonPath || !fs.existsSync(projectJsonPath)) {
            sendJson(response, 404, { error: "Project not found." });
            return;
          }

          sendJson(response, 200, {
            folder: path.basename(path.dirname(projectJsonPath)),
            project: readProject(projectJsonPath)
          });
          return;
        }
      }

      if (request.method === "POST") {
        // Approving a specific revision of a creative stage is what gates the next stage.
        const approvalMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/approvals\/(research|strategy|script|storyboard|master_video|platform_adaptations)$/u);
        if (approvalMatch) {
          const folder = decodeURIComponent(approvalMatch[1]);
          const body = await readRequestJson(request);
          const ctx = intake.context(projectsRoot, folder);
          const project = intake.decideStage(ctx, approvalMatch[2], body);
          sendJson(response, 200, {folder, stage: approvalMatch[2], project, approvals: project.workflow.approvals});
          return;
        }

        /* Assigning a local template, attaching a generated file, and drawing a preview. These edit
           the storyboard plan (or, for a preview, deliberately do not), so they share its guard. */
        const sceneGraphicMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/scene-graphic$/u);
        if (sceneGraphicMatch) {
          const folder = decodeURIComponent(sceneGraphicMatch[1]);
          const body = await readRequestJson(request);
          if (busy(folder)) intake.fail('Generation is already running for this project.', 409);
          runningProjects.add(folder);
          try {
            const result = await providerStages.assignGraphic({
              projectsRoot, folder, library,
              sceneId: body.scene_id,
              template: body.template === undefined ? null : body.template,
              data: body.data
            });
            sendJson(response, 200, {folder, project: result.project, artifact: result.artifact});
          } finally { runningProjects.delete(folder); }
          return;
        }

        const sceneAssetMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/asset$/u);
        if (sceneAssetMatch) {
          const folder = decodeURIComponent(sceneAssetMatch[1]);
          const sceneId = decodeURIComponent(sceneAssetMatch[2]);
          const body = await readRequestJson(request);
          if (busy(folder)) intake.fail('Generation is already running for this project.', 409);
          runningProjects.add(folder);
          try {
            const result = await providerStages.attachSceneAsset({
              projectsRoot, folder, library, sceneId,
              assetId: body.asset_id === undefined ? null : body.asset_id,
              tool: body.tool,
              note: body.note
            });
            sendJson(response, 200, {folder, project: result.project, artifact: result.artifact});
          } finally { runningProjects.delete(folder); }
          return;
        }

        /* Starting and cancelling a run to final check. Start returns the record at once; the work
           continues in the background because generating and rendering take minutes. */
        const pipelineCancelMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/pipeline\/cancel$/u);
        if (pipelineCancelMatch) {
          const folder = decodeURIComponent(pipelineCancelMatch[1]);
          const ctx = intake.context(projectsRoot, folder);
          const canceled = pipelineRunner.cancel(folder);
          sendJson(response, 200, {folder, canceled, run: pipelineRunner.status(ctx.directory, folder)});
          return;
        }

        const pipelineStartMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/pipeline$/u);
        if (pipelineStartMatch) {
          const folder = decodeURIComponent(pipelineStartMatch[1]);
          const body = await readRequestJson(request);
          const ctx = intake.context(projectsRoot, folder);
          const check = pipeline.preflight(ctx);
          if (!check.ok) intake.fail('This project is not ready to run to the final check. ' + check.problems.join(' '), 409);
          if (busy(folder)) intake.fail('Generation is already running for this project.', 409);
          const board = comfyGenerate.readBoard(ctx.directory);
          const run = pipelineRunner.start({
            folder, directory: ctx.directory, board,
            stopAfter: body.stop_after,
            deps: pipelineDeps(folder)
          });
          sendJson(response, 202, {folder, run});
          return;
        }

        /* Generating a scene through Comfy. Submitting returns immediately with a job record; the
           interface polls it. Nothing waits on a GPU job inside a request, and the record is on disk
           so a reload re-attaches instead of losing the job. */
        const generateMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/generate$/u);
        if (generateMatch) {
          const folder = decodeURIComponent(generateMatch[1]);
          const sceneId = decodeURIComponent(generateMatch[2]);
          const body = await readRequestJson(request);
          const ctx = intake.context(projectsRoot, folder);
          intake.requireIntake(ctx);
          const record = await comfyGenerate.submitGeneration({
            ctx, client: comfyClient(), projectsRoot, sceneId,
            workflowName: body.workflow,
            prompt: body.prompt
          });
          sendJson(response, 201, {folder, scene_id: sceneId, job: record});
          return;
        }

        const cancelMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/generate\/([^/]+)\/cancel$/u);
        if (cancelMatch) {
          const folder = decodeURIComponent(cancelMatch[1]);
          const ctx = intake.context(projectsRoot, folder);
          const record = await comfyGenerate.cancelGeneration({
            directory: ctx.directory, client: comfyClient(), jobId: decodeURIComponent(cancelMatch[3])
          });
          sendJson(response, 200, {folder, job: record});
          return;
        }

        const previewMatch = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/render-preview$/u);        if (previewMatch) {
          const folder = decodeURIComponent(previewMatch[1]);
          const sceneId = decodeURIComponent(previewMatch[2]);
          const body = await readRequestJson(request);
          // A render holds the project guard, and a preview is a render, just a small one.
          if (busy(folder)) intake.fail('Generation is already running for this project.', 409);
          runningProjects.add(folder);
          try {
            const result = await providerStages.renderPreview({
              projectsRoot, folder, library, sceneId,
              template: body.template,
              data: body.data,
              fps: body.fps,
              width: body.width,
              height: body.height
            });
            sendJson(response, 200, {folder, preview: result});
          } finally { runningProjects.delete(folder); }
          return;
        }

        const match = requestUrl.pathname.match(/^\/api\/projects\/([^/]+)\/(research|strategy|script|storyboard|assets|render|final|exports)$/u);
        if (match) {
          const folder = decodeURIComponent(match[1]);
          const step = match[2];
          // Provider-backed creative stages. There is no offline fallback: a stage that cannot
          // reach a provider fails visibly rather than quietly substituting a template.
          // Named `stageGenerators` so it cannot shadow the providerStages module imported above.
          const stageGenerators = {
            research: generateProviderResearch,
            strategy: generateProviderStrategy,
            script: generateProviderScript,
            storyboard: generateProviderStoryboard,
            assets: generateProviderAssets
          };

          const body = await readRequestJson(request);
          if (busy(folder)) intake.fail('Generation is already running for this project.',409);
          runningProjects.add(folder);
          try {
            const ctx = intake.context(projectsRoot,folder);
            intake.requireIntake(ctx);

            // Every step the route admits is handled below, so there is no fallback path left.
            if (stageGenerators[step] || ['render', 'final', 'exports'].includes(step)) {
              if (step === 'research') {
                if (body.provider && body.provider !== 'anthropic') intake.fail('Choose a supported research provider.');
                if (typeof body.web_search !== 'boolean' || typeof body.include_materials !== 'boolean') intake.fail('Choose web search and material sharing options.');
                const result = await stageGenerators.research({projectsRoot, folder, provider: claude(), library, settings: {provider: 'anthropic', web_search: body.web_search, include_materials: body.include_materials}});
                sendJson(response,200,{folder,step,project:result.project,artifact:result.artifact}); return;
              }
              if (step === 'assets') {
                const result = await stageGenerators.assets({
                  projectsRoot, folder, library,
                  speech: speechProvider(),
                  stock: stockProvider(),
                  // Injectable so the asset stage can be tested without launching a browser; the
                  // renderer itself is covered against real Chrome in tests/render.test.js.
                  renderGraphic: options.renderGraphic,
                  graphicFps: options.graphicFps
                });
                sendJson(response,200,{folder,step,project:result.project,artifact:result.artifact}); return;
              }
              if (step === 'render') {
                // The composer writes a real video. Scenes that all have media need no browser at
                // all; only a scene with nothing to show has its placeholder drawn with one.
                const result = await providerStages.composeProject({
                  projectsRoot, folder, library,
                  tools: options.tools,
                  options: {keepSegments: options.keepSegments === true},
                  renderPlaceholder: providerStages.placeholderRenderer({
                    width: 1920, height: 1080, fps: 24,
                    ffmpegPath: options.ffmpegPath
                  })
                });
                sendJson(response,200,{folder,step,project:result.project,artifact:result.artifact}); return;
              }
              if (step === 'final') {
                const result = await providerStages.runFinalCheck({projectsRoot, folder, tools: options.tools});
                sendJson(response,200,{folder,step,project:result.project,artifact:result.artifact}); return;
              }
              if (step === 'exports') {
                const result = await providerStages.generateExports({projectsRoot, folder, tools: options.tools});
                sendJson(response,200,{folder,step,project:result.project,artifact:result.artifact}); return;
              }
              const result = await stageGenerators[step]({projectsRoot, folder, provider: claude(), library});
              sendJson(response,200,{folder,step,project:result.project,artifact:result.artifact}); return;
            }
            // Unreachable: the route pattern above admits only the steps handled here, and there is
            // no template fallback left to fall into. An unknown step is a 404 from the router.
          } catch (error) {
            if (/Project not found|Invalid project folder/u.test(error.message)) {
              sendJson(response, 404, { error: error.message });
              return;
            }
            throw error;
          } finally { runningProjects.delete(folder); }
          return;
        }
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/projects") {
        const body = await readRequestJson(request);
        if (!body.prompt || !String(body.prompt).trim()) {
          sendJson(response, 400, { error: "A project prompt is required." });
          return;
        }

        try {
          const result = createProjectFromBody(body, projectsRoot);
          sendJson(response, 201, {
            folder: path.basename(result.projectDirectory),
            projectDirectory: result.projectDirectory,
            project: result.project
          });
        } catch (error) {
          if (/Project already exists/u.test(error.message)) {
            sendJson(response, 409, { error: error.message });
            return;
          }
          throw error;
        }
        return;
      }

      sendText(response, 404, "Not found");
    } catch (error) {
      const status = error.status || (/Project not found|Invalid project folder/.test(error.message) ? 404 : 500);
      if (!response.headersSent && !response.destroyed) sendJson(response, status, { error: error.message });
    }
  });
}

function startServer() {
  loadEnvironment(path.join(ROOT_DIR, ".env"));
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const server = createServer();

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`AI Social Content Agent UI running at http://localhost:${actualPort}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  listProjects
};



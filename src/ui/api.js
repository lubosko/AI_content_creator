'use strict';
/* API access. Every server error surfaces as a thrown Error carrying the status and any
   credential or revision guidance the server returned, so views can render it honestly. */
(function (root) {
  function ApiError(message, status, payload) {
    var error = new Error(message);
    error.name = 'ApiError';
    error.status = status;
    error.payload = payload || {};
    return error;
  }

  async function request(url, options) {
    var response;
    try {
      response = await fetch(url, options);
    } catch (cause) {
      throw ApiError('Could not reach the local server. Check that it is still running, then retry.', 0);
    }
    var payload = null;
    var text = '';
    try { text = await response.text(); } catch (cause) { text = ''; }
    if (text) { try { payload = JSON.parse(text); } catch (cause) { payload = null; } }
    if (!response.ok) {
      var message = (payload && payload.error) || ('Request failed with status ' + response.status + '.');
      throw ApiError(message, response.status, payload || {});
    }
    if (payload === null) throw ApiError('The server returned an unexpected response. Restart the local server and retry.', response.status);
    return payload;
  }

  function json(body) {
    return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  function encode(value) { return encodeURIComponent(String(value)); }

  var Api = {
    ApiError: ApiError,
    projects: function () { return request('/api/projects'); },
    createProject: function (body) { return request('/api/projects', json(body)); },
    project: function (folder) { return request('/api/projects/' + encode(folder) + '/project.json'); },
    intake: function (folder) { return request('/api/projects/' + encode(folder) + '/intake'); },
    confirmBrief: function (folder, revision, body) { return request('/api/projects/' + encode(folder) + '/brief', json(Object.assign({}, body, { revision: revision }))); },
    selectMaterial: function (folder, revision, assetId, decision) { return request('/api/projects/' + encode(folder) + '/materials', json({ revision: revision, asset_id: assetId, decision: decision })); },
    confirmMaterials: function (folder, revision, withoutMaterial) { return request('/api/projects/' + encode(folder) + '/materials-confirm', json({ revision: revision, without_material: !!withoutMaterial })); },
    generate: function (folder, step, body) { return request('/api/projects/' + encode(folder) + '/' + step, json(body || {})); },
    decideStage: function (folder, stage, body) { return request('/api/projects/' + encode(folder) + '/approvals/' + encode(stage), json(body)); },
    results: function (folder, step) { return request('/api/projects/' + encode(folder) + '/results/' + step); },
    library: function () { return request('/api/library'); },
    analyzeAsset: function (id, confirmLong) { return request('/api/library/' + encode(id) + '/analyze', json({confirm_long: !!confirmLong})); },
    analyzePending: function () { return request('/api/library/analyze-pending', { method: 'POST' }); },
    analysis: function (id) { return request('/api/library/' + encode(id) + '/analysis'); },
    thumbnailUrl: function (id) { return '/api/library/' + encode(id) + '/thumbnail'; },
    addText: function (body) { return request('/api/library', json(body)); },
    setRights: function (assetIds, body) { return request('/api/library/rights', json(Object.assign({ asset_ids: assetIds }, body))); },
    setAssetRights: function (id, body) { return request('/api/library/' + encode(id) + '/rights', json(body)); },
    upload: function (file, category) { return request('/api/library/upload?name=' + encode(file.name) + '&category=' + encode(category), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }); },
    fileUrl: function (id) { return '/api/library/' + encode(id) + '/file'; },
    projectFileUrl: function (folder, relativePath) { return '/api/projects/' + encode(folder) + '/files/' + String(relativePath).split('/').map(encode).join('/'); },
    settings: function () { return request('/api/settings'); },
    saveSettings: function (revision, body) { return request('/api/settings', json(Object.assign({}, body, { revision: revision }))); },
    testSettings: function (revision, provider) { return request('/api/settings/test', json({ revision: revision, provider: provider })); },
    researchStatus: function () { return request('/api/providers/research'); },
    testResearch: function () { return request('/api/providers/research/test', { method: 'POST' }); },
    renderTemplates: function () { return request('/api/render/templates'); },
    assignGraphic: function (folder, sceneId, template, data) { return request('/api/projects/' + encode(folder) + '/scene-graphic', json({ scene_id: sceneId, template: template, data: data })); },
    attachSceneAsset: function (folder, sceneId, body) { return request('/api/projects/' + encode(folder) + '/scenes/' + encode(sceneId) + '/asset', json(body)); },
    renderPreview: function (folder, sceneId, body) { return request('/api/projects/' + encode(folder) + '/scenes/' + encode(sceneId) + '/render-preview', json(body || {})); },
    // Comfy generation: submit returns a job record at once, then the screen polls it.
    generateScene: function (folder, sceneId, body) { return request('/api/projects/' + encode(folder) + '/scenes/' + encode(sceneId) + '/generate', json(body || {})); },
    generationStatus: function (folder, sceneId, jobId) { return request('/api/projects/' + encode(folder) + '/scenes/' + encode(sceneId) + '/generate/' + encode(jobId)); },
    sceneGeneration: function (folder, sceneId) { return request('/api/projects/' + encode(folder) + '/scenes/' + encode(sceneId) + '/generation'); },
    cancelGeneration: function (folder, sceneId, jobId) { return request('/api/projects/' + encode(folder) + '/scenes/' + encode(sceneId) + '/generate/' + encode(jobId) + '/cancel', { method: 'POST' }); },
    comfyStatus: function () { return request('/api/providers/comfy'); },
    // Run to final check: a project action, not a stage.
    pipeline: function (folder) { return request('/api/projects/' + encode(folder) + '/pipeline'); },
    startPipeline: function (folder, body) { return request('/api/projects/' + encode(folder) + '/pipeline', json(body || {})); },
    cancelPipeline: function (folder) { return request('/api/projects/' + encode(folder) + '/pipeline/cancel', { method: 'POST' }); }
  };

  root.Api = Api;
})(window);
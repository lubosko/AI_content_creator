'use strict';
/* Comfy Cloud generation, against the official Comfy API v2.
   Spec: https://docs.comfy.org/openapi-v2.yaml  (servers: https://cloud.comfy.org,
   http://127.0.0.1:8189 self-hosted, https://{deployment}.run.comfy.app serverless)

   The official @comfyorg/sdk is deliberately NOT used. It would add this repository's first npm
   dependency, and its `client.run()` hides the submit/poll split that lets a multi-minute GPU job
   survive a page reload and be cancelled. The raw API is three calls, so it is not worth the
   dependency. Nothing here speaks HTTP outside this file.

   Two spec details drive the shape of this code:
   - Comfy Cloud answers 204 for every job log, so a failure must be explained from `job.error`.
   - `Idempotency-Key` is single-use and reject-on-duplicate, so a key is minted per submission and
     reused only while retrying that same submission. */

const DEFAULT_BASE_URL = 'https://cloud.comfy.org';
const TERMINAL = ['succeeded', 'canceled', 'failed', 'expired'];
const MEDIA_TYPES = ['image', 'video'];

function fail(message, status = 502) { throw Object.assign(new Error(message), {status}); }

/* Comfy's documented machine-readable codes, turned into something an operator can act on. Keyed by
   `error.code` where the API documents one, and by HTTP status otherwise. */
const ERROR_MESSAGES = {
  unauthorized: 'Comfy rejected the API key. Check the key in Settings, or COMFY_API_KEY in .env.',
  forbidden: 'This Comfy key is not allowed to do that. Check the key permissions in your comfy.org account.',
  insufficient_credits: 'Your comfy.org account is out of credits, so the job was not run. Add credits at comfy.org, then retry.',
  queue_full: 'Comfy queue is full right now. Wait a moment and retry.',
  deployment_not_ready: 'This Comfy deployment is still starting. Wait a moment and retry.',
  deployment_stopped: 'This Comfy deployment is stopped. Start it in your Comfy account, then retry.',
  invalid_workflow: 'Comfy rejected the workflow. The node and input it named are in the message above.',
  workflow_format_ui: 'That file is a ComfyUI editor workflow, not an API workflow. In ComfyUI use Workflow then Export (API) and save that file instead.',
  missing_asset: 'The workflow refers to a file Comfy does not have. Upload it to your Comfy account, or remove that node.',
  idempotency_key_reuse: 'Comfy saw a duplicate submission key. This is a retry of a job that may already exist - check your Comfy jobs rather than resubmitting.',
  not_found: 'Comfy could not find that job. It may have passed its retention deadline.',
  rate_limited: 'Comfy rate-limited this account. Wait a moment and retry.',
  upstream_error: 'Comfy had an internal error. Retry later.'
};

const STATUS_MESSAGES = {
  400: 'Comfy rejected the request.',
  401: ERROR_MESSAGES.unauthorized,
  402: ERROR_MESSAGES.insufficient_credits,
  403: ERROR_MESSAGES.forbidden,
  404: ERROR_MESSAGES.not_found,
  429: 'Comfy is busy or rate-limiting this account. Wait a moment and retry.',
  500: ERROR_MESSAGES.upstream_error
};

function normaliseBaseUrl(value) {
  const text = String(value || '').trim() || DEFAULT_BASE_URL;
  let url;
  try { url = new URL(text); } catch { fail('COMFY_BASE_URL is not a valid address: ' + text, 400); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    fail('COMFY_BASE_URL must be an http or https address without embedded credentials.', 400);
  }
  return url.href.replace(/\/+$/, '');
}

/* The spec says follow the links a job returns, and resolve a host-relative link against the origin
   rather than by pasting it onto a configured base URL that may carry the same mount prefix. */
function resolveLink(baseUrl, link) {
  const text = String(link || '').trim();
  if (!text) return null;
  try { return new URL(text, baseUrl).href; } catch { return null; }
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/* A ComfyUI editor export carries `nodes`/`links`, and each node carries `widgets_values`. An API
   export is a plain map of node id to {class_type, inputs}. Catching this locally means a wrong file
   is refused before a request is spent. */
function isUiFormat(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return false;
  if (Array.isArray(graph.nodes) || Array.isArray(graph.links)) return true;
  for (const key of Object.keys(graph)) {
    const node = graph[key];
    if (node && typeof node === 'object' && (Array.isArray(node.widgets_values) || hasOwn(node, 'pos'))) return true;
  }
  return false;
}

/* Every node id with the class Comfy will run, so a refusal can say what the file actually contains
   instead of only that the configured id was missing. */
function describeNodes(graph) {
  const nodes = [];
  for (const key of Object.keys(graph || {})) {
    const node = graph[key];
    if (!node || typeof node !== 'object' || !node.class_type) continue;
    nodes.push({id: key, class_type: String(node.class_type)});
  }
  return nodes;
}

/* Validates the operator workflow and the prompt target, without touching the original object. */
function validateWorkflow(graph, options = {}) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return {ok: false, problem: 'The workflow file did not contain a JSON object. Export the API workflow from ComfyUI and save that file.'};
  }
  if (isUiFormat(graph)) {
    return {ok: false, problem: ERROR_MESSAGES.workflow_format_ui};
  }
  const nodes = describeNodes(graph);
  if (!nodes.length) {
    return {ok: false, problem: 'The workflow file contains no nodes. Export the API workflow from ComfyUI and save that file.'};
  }

  /* The prompt node is optional. A ComfyUI text-to-image graph nearly always has exactly one text
     encoder, and asking an operator to hunt for its node id is friction for no benefit. The rule is
     deliberately strict: one unambiguous match, or a refusal that names the candidates. Anything
     cleverer would silently write the prompt into the wrong node, which is worse than asking. */
  const field0 = String(options.promptField || 'text');
  let node = String(options.promptNode === undefined || options.promptNode === null ? '' : options.promptNode);
  let autoDetected = false;
  if (!node) {
    const candidates = nodes.filter(item => /textencode|text_encode|cliptext/i.test(item.class_type)
      && graph[item.id] && graph[item.id].inputs && hasOwn(graph[item.id].inputs, field0));
    if (candidates.length === 1) {
      node = candidates[0].id;
      autoDetected = true;
    } else if (candidates.length > 1) {
      return {
        ok: false, nodes,
        problem: 'This workflow has ' + candidates.length + ' text nodes, so the prompt cannot be placed automatically: '
          + candidates.map(item => item.id + ' (' + item.class_type + ')').join(', ')
          + '. Set prompt_node in workflows.json to the positive one.'
      };
    } else {
      return {
        ok: false, nodes,
        problem: 'No prompt node is configured and none could be found automatically. Expected a text-encoding node with an "'
          + field0 + '" input. The workflow contains: ' + nodes.map(item => item.id + ' (' + item.class_type + ')').join(', ')
          + '. Set prompt_node in workflows.json to the node that takes the text.'
      };
    }
  }
  if (!hasOwn(graph, node)) {
    return {
      ok: false,
      nodes,
      problem: 'The workflow has no node "' + node + '", which is where the prompt is meant to go. It contains: '
        + nodes.map(item => item.id + ' (' + item.class_type + ')').join(', ') + '.'
    };
  }
  const field = field0;
  const inputs = graph[node] && graph[node].inputs;
  if (!inputs || typeof inputs !== 'object') {
    return {ok: false, nodes, problem: 'Node "' + node + '" has no inputs object, so the prompt cannot be placed in it.'};
  }
  if (!hasOwn(inputs, field)) {
    return {
      ok: false,
      nodes,
      problem: 'Node "' + node + '" (' + String(graph[node].class_type || 'unknown') + ') has no input "' + field
        + '". It has: ' + Object.keys(inputs).join(', ') + '. Set prompt_field in workflows.json.'
    };
  }
  return {ok: true, nodes, promptNode: node, promptField: field, autoDetected};
}

/* Returns a copy with the prompt in place. The file on disk is never rewritten, so the operator
   workflow stays exactly as they exported it. */
function injectPrompt(graph, {node, field = 'text', text}) {
  const copy = JSON.parse(JSON.stringify(graph));
  copy[node].inputs[field] = String(text === undefined || text === null ? '' : text);
  return copy;
}

/* Which output to keep. `type` is Comfy own normalised kind, so a workflow whose save node the
   operator forgot is refused with the list of what it actually returned. */
function chooseOutput(outputs, options = {}) {
  const list = Array.isArray(outputs) ? outputs.filter(Boolean) : [];
  if (!list.length) return {ok: false, reason: 'Comfy reported the job as succeeded but returned no outputs. The workflow may have no save or preview node.'};
  const preferredNode = options.preferredNode === undefined || options.preferredNode === null ? null : String(options.preferredNode);
  const wanted = options.wantedKind ? String(options.wantedKind) : null;
  const media = list.filter(item => MEDIA_TYPES.includes(String(item.type)));
  if (!media.length) {
    return {
      ok: false,
      reason: 'Comfy returned no image or video. It returned: '
        + [...new Set(list.map(item => String(item.type || 'unknown')))].join(', ')
        + '. Add a Save Image or Save Video node to the workflow.'
    };
  }
  if (preferredNode) {
    const byNode = media.filter(item => String(item.node_id) === preferredNode);
    if (byNode.length) return {ok: true, output: byNode[0], skipped: list.filter(item => item !== byNode[0])};
  }
  if (wanted) {
    const byKind = media.filter(item => String(item.type) === wanted);
    if (byKind.length) return {ok: true, output: byKind[0], skipped: list.filter(item => item !== byKind[0])};
  }
  return {ok: true, output: media[0], skipped: list.filter(item => item !== media[0])};
}

function messageFor(status, code) {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return STATUS_MESSAGES[status] || ('Comfy request failed (HTTP ' + status + '). Retry later.');
}

/* Reads the machine-readable code out of the shared error envelope without echoing the body, which
   can carry request content. */
function errorCode(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const error = payload.error;
  if (!error || typeof error !== 'object') return null;
  return typeof error.code === 'string' ? error.code : null;
}

function errorDetail(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const error = payload.error;
  if (!error || typeof error !== 'object') return null;
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  return message ? message.slice(0, 500) : null;
}

function failedJobReason(job) {
  const error = job && job.error;
  if (!error || typeof error !== 'object') return 'Comfy reported the job as failed without saying why.';
  const parts = [String(error.code || 'failed')];
  if (error.message) parts.push(String(error.message));
  if (error.node_id) parts.push('node ' + error.node_id + (error.class_type ? ' (' + error.class_type + ')' : ''));
  return parts.join(': ').slice(0, 600);
}

function createComfyClient({baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 120000, pollMs = 3000, maxWaitMs = 900000} = {}) {
  const base = normaliseBaseUrl(baseUrl);
  const key = () => String(apiKey || '').trim();

  function status() { return {provider: 'comfy', configured: !!key(), base_url: base}; }

  async function request(path, options = {}) {
    if (!key()) {
      fail('Comfy is not configured. Add your comfy.org API key in Settings, or set COMFY_API_KEY in .env.', 409);
    }
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: options.method || 'GET',
        redirect: options.redirect || 'error',
        headers: Object.assign(
          {'authorization': 'Bearer ' + key(), 'accept': 'application/json'},
          options.body ? {'content-type': 'application/json'} : {},
          options.headers || {}
        ),
        ...(options.body ? {body: JSON.stringify(options.body)} : {}),
        ...(options.signal ? {signal: options.signal} : {signal: AbortSignal.timeout(options.timeoutMs || timeoutMs)})
      });
    } catch (error) {
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        fail('Comfy did not answer in time. Nothing was started. Retry when ready.');
      }
      throw error;
    }
    if (response.status === 204) return null;
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const code = errorCode(payload);
      const detail = errorDetail(payload);
      const message = messageFor(response.status, code) + (detail ? ' Comfy said: ' + detail : '');
      const error = new Error(message);
      /* 429 and 402 are the two a caller can act on differently - back off, or add credits - so they
         keep their own status. Everything else is a provider failure from this app's point of view. */
      const passthrough = [402, 429].includes(response.status) ? response.status : 502;
      error.status = passthrough;
      error.code = code;
      error.retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : 0) || null;
      throw error;
    }
    return payload;
  }

  async function submit({workflow, extraData, idempotencyKey}) {
    const body = {workflow};
    if (extraData && Object.keys(extraData).length) body.extra_data = extraData;
    const headers = idempotencyKey ? {'idempotency-key': String(idempotencyKey)} : {};
    const job = await request('/api/v2/jobs', {method: 'POST', body, headers});
    if (!job || !job.id) fail('Comfy accepted the submission but returned no job id.');
    return job;
  }

  function job(id) { return request('/api/v2/jobs/' + encodeURIComponent(String(id))); }

  async function cancel(id) {
    // Follow the link the job gave us when it is present, per the spec rule to follow links.
    let target = '/api/v2/jobs/' + encodeURIComponent(String(id)) + '/cancel';
    try {
      const current = await job(id);
      if (current && current.status && TERMINAL.includes(current.status)) return current;
      const link = resolveLink(base, current && current.urls && current.urls.cancel);
      if (link) target = link;
    } catch (error) {
      // Cancelling is best effort: the polling loop reports the real state.
    }
    return request(target, {method: 'POST'});
  }

  /* Polls to a terminal state. `onProgress` receives each snapshot. Never abandons a job: a deadline
     or a cancel signal cancels upstream first, so billed GPU seconds stop. */
  async function waitFor(id, options = {}) {
    const deadline = Date.now() + (options.maxWaitMs || maxWaitMs);
    const interval = options.pollMs || pollMs;
    const onProgress = options.onProgress;
    const signal = options.signal;
    for (;;) {
      if (signal && signal.aborted) {
        await cancel(id).catch(() => {});
        const stopped = new Error('Generation was cancelled.');
        stopped.canceled = true;
        throw stopped;
      }
      const current = await job(id);
      if (onProgress) onProgress(current);
      if (current && TERMINAL.includes(current.status)) return current;
      if (Date.now() > deadline) {
        await cancel(id).catch(() => {});
        fail('Comfy did not finish within ' + Math.round((options.maxWaitMs || maxWaitMs) / 60000)
          + ' minutes, so the job was cancelled rather than left running.');
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  /* Downloads an output bytes. The content endpoint answers 302 to a short-lived signed URL on
     Comfy Cloud, so the redirect is handled by hand: following it automatically would forward the
     API key to whatever host the signed URL lives on. */
  async function outputBytes(output) {
    const assetId = output && output.id ? String(output.id) : null;
    if (assetId) {
      if (!key()) fail('Comfy is not configured. Add your comfy.org API key in Settings.', 409);
      const contentUrl = base + '/api/v2/assets/' + encodeURIComponent(assetId) + '/content';
      const response = await fetchImpl(contentUrl, {
        method: 'GET', redirect: 'manual',
        headers: {'authorization': 'Bearer ' + key()},
        signal: AbortSignal.timeout(timeoutMs)
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers && response.headers.get ? response.headers.get('location') : null;
        const signed = location ? new URL(location, base).href : null;
        // The signed URL carries its own authority; sending the bearer token to it would leak the key.
        if (signed) return fetchBytes(signed);
      } else if (response.ok) {
        return Buffer.from(await response.arrayBuffer());
      } else if (response.status !== 404) {
        fail(messageFor(response.status, null));
      }
    }
    const fallback = output && output.url ? String(output.url) : null;
    if (!fallback) fail('Comfy reported an output but gave no way to download it.');
    return fetchBytes(new URL(fallback, base).href);
  }

  async function fetchBytes(url) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      fail('The generated file could not be downloaded.');
    }
    if (!response.ok) fail('The generated file could not be downloaded (HTTP ' + response.status + ').');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) fail('The generated file was empty.');
    return buffer;
  }

  /* A key check that costs nothing and queues nothing: an unknown job id answers 401 for a bad key
     and 404 for a good one. */
  async function test() {
    const probe = (globalThis.crypto && globalThis.crypto.randomUUID)
      ? globalThis.crypto.randomUUID()
      : '00000000-0000-4000-8000-000000000000';
    try {
      await job(probe);
      return Object.assign(status(), {connected: true, message: 'Comfy accepted the API key. No job was submitted.'});
    } catch (error) {
      if (error.code === 'not_found' || error.status === 404) {
        return Object.assign(status(), {connected: true, message: 'Comfy accepted the API key. No job was submitted.'});
      }
      if (/rejected the API key|not configured/i.test(error.message)) {
        return Object.assign(status(), {connected: false, error: error.message});
      }
      throw error;
    }
  }

  /* `apiKeyValue` exists only so a caller can forward the same key in `extra_data.api_key_comfy_org`
     for workflows that declare they use partner/API nodes. It is never exposed over HTTP. */
  return {status, test, submit, job, waitFor, cancel, outputBytes, chooseOutput, apiKeyValue: key, baseUrl: base};
}

module.exports = {
  DEFAULT_BASE_URL, TERMINAL, MEDIA_TYPES, ERROR_MESSAGES,
  createComfyClient, normaliseBaseUrl, resolveLink, isUiFormat, describeNodes,
  validateWorkflow, injectPrompt, chooseOutput, failedJobReason, messageFor, fail
};
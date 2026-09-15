'use strict';
const {researchPrompt} = require('../lib/stagePrompts');
const DEFAULT_MODEL = 'claude-sonnet-5';
function fail(message,status = 502) { throw Object.assign(new Error(message),{status}); }
function safeUrl(value) {
  try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function createClaudeProvider({env = process.env, fetchImpl = fetch, timeoutMs = 120000} = {}) {
  const key = () => String(env.ANTHROPIC_API_KEY || '').trim();
  const model = () => String(env.ANTHROPIC_MODEL || DEFAULT_MODEL).trim();
  function status() { return {provider:'anthropic',configured:!!key(),model:model()}; }
  async function request(route, body, overrideTimeoutMs) {
    if (!key()) fail('Claude is not configured. Add your API key in Settings, or configure ANTHROPIC_API_KEY in .env.',409);
    let response;
    try {
      response = await fetchImpl('https://api.anthropic.com/v1/' + route, {
        method:body ? 'POST':'GET', redirect:'error',
        headers:{'x-api-key':key(),'anthropic-version':'2023-06-01','content-type':'application/json'},
        ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(overrideTimeoutMs || timeoutMs)
      });
    } catch (error) {
      fail(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'Claude timed out. Your previous research is unchanged. Retry when ready.' : 'Could not reach Claude. Check your internet connection and retry.');
    }
    // Do not echo provider error bodies, which may contain request content or credentials.
    if (!response.ok) {
      const messages = {400:'Claude rejected the request. Check your model, API billing, and whether web search is enabled in the Claude Console.',401:'Claude rejected the API key. Check ANTHROPIC_API_KEY and restart the server.',403:'This API key does not have permission. Check your Claude Console access.',404:'Claude model not found. Update ANTHROPIC_MODEL in .env and restart.',429:'Claude rate or usage limit reached. Check API credits and retry later.',529:'Claude is temporarily overloaded. Retry later.'};
      fail(messages[response.status] || 'Claude request failed (HTTP ' + response.status + '). Retry later.');
    }
    try { return await response.json(); } catch { fail('Claude returned an unreadable response. Previous research is unchanged.'); }
  }
  async function test() {
    const result = await request('models/' + encodeURIComponent(model()));
    return { ...status(), connected:true, model:result.id || model(), message:'API key and model access verified. Web search and available credits are checked when generating research.' };
  }
  /* Generic prompt call used by every creative stage. Returns the text, any web citations, and
     warnings, so each stage can decide how to interpret the answer. */
  async function chat({system, user, webSearch = false, maxTokens = 8000, timeoutMs}) {
    const response = await request('messages', {
      model: model(),
      max_tokens: maxTokens,
      system,
      messages: [{role: 'user', content: user}],
      ...(webSearch ? {tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: 5}]} : {})
    }, timeoutMs);
    if (response.stop_reason !== 'end_turn') {
      fail('Claude did not finish (' + String(response.stop_reason || 'unknown') + '). The previous result is unchanged. Try a narrower request.');
    }
    if (!Array.isArray(response.content)) fail('Claude returned no content.');
    const sources = [], warnings = [], blocks = [];
    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && block.content?.type === 'web_search_tool_result_error') warnings.push('A web search failed: ' + String(block.content.error_code || 'unknown'));
      if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) continue;
      const references = [];
      for (const citation of (webSearch ? block.citations || [] : [])) {
        const url = safeUrl(citation.url);
        if (!url) continue;
        let index = sources.findIndex(item => item.url === url);
        if (index < 0) { index = sources.length; sources.push({id: index + 1, url, title: String(citation.title || url), origin: 'claude_web_citation'}); }
        references.push(index + 1);
      }
      blocks.push(block.text + (references.length ? '\n\nSources: ' + [...new Set(references)].map(id => '[' + id + ']').join(', ') : ''));
    }
    if (!blocks.length) fail('Claude returned an empty result. The previous result is unchanged.');
    if (webSearch && !sources.length) warnings.push('No web citations were returned. Treat this as an unsourced model draft.');
    return {text: blocks.join('\n\n'), sources, warnings, grounding: sources.length ? 'web_cited' : 'model_draft', model: response.model || model(), usage: response.usage || {}};
  }

  /* Research keeps its own entry point so existing callers are unaffected. */
  async function generate({brief, materials, webSearch}) {
    const prompt = researchPrompt({brief, materials, webSearch});
    return chat({system: prompt.system, user: prompt.user, webSearch});
  }

  return {status, test, chat, generate};
}
module.exports = {createClaudeProvider, safeUrl};

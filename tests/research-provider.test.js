'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createClaudeProvider} = require('../src/providers/claude');
const {loadEnvironment} = require('../src/config/environment');
const {createServer} = require('../src/server');
const success = {model:'test-model',stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:200},content:[{type:'text',text:'## Summary\nAn overview of orchard management.\n\n## Key findings\nA source-supported example about pruning.\n\n## Claims to verify\n- Whether dormant pruning suits every cultivar.',citations:[{type:'web_search_result_location',url:'https://example.com/evidence',title:'Evidence'},{url:'javascript:alert(1)',title:'Unsafe'}]}]};
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'claude-research-test-'));
  const envFile = path.join(root,'.env');
  fs.writeFileSync(envFile,'ANTHROPIC_API_KEY="example-key"\nANTHROPIC_MODEL=test-model\nOTHER_SETTING=no\n');
  const loaded = {}; loadEnvironment(envFile,loaded); assert.equal(loaded.ANTHROPIC_API_KEY,'example-key'); assert.equal(loaded.OTHER_SETTING,undefined);
  loaded.ANTHROPIC_MODEL='override'; loadEnvironment(envFile,loaded); assert.equal(loaded.ANTHROPIC_MODEL,'override');
  const noKey = createClaudeProvider({env:{},fetchImpl:() => {throw new Error('Must not call network');}});
  await assert.rejects(noKey.test(),/not configured/);
  const rejected = createClaudeProvider({env:loaded,fetchImpl:async () => new Response('secret echo example-key',{status:401})});
  await assert.rejects(rejected.test(),error => error.message.includes('rejected the API key') && !error.message.includes('example-key'));
  const partial = createClaudeProvider({env:loaded,fetchImpl:async () => Response.json({...success,stop_reason:'max_tokens'})});
  await assert.rejects(partial.generate({brief:{},materials:{},webSearch:true}),/did not finish/);
  const warning = createClaudeProvider({env:loaded,fetchImpl:async () => Response.json({stop_reason:'end_turn',content:[{type:'text',text:'Unverified model opinion.'},{type:'web_search_tool_result',content:{type:'web_search_tool_result_error',error_code:'unavailable'}}]})});
  const draft = await warning.generate({brief:{},materials:{},webSearch:true});
  assert.equal(draft.grounding,'model_draft'); assert.equal(draft.warnings.length,2);
  let pendingRelease, providerStarted, mode='success', sent;
  const providerFetch = async (url,options) => {
    assert.ok(url.startsWith('https://api.anthropic.com/v1/'));
    assert.equal(options.headers['x-api-key'],'example-key');
    if (!options.body) return Response.json({id:'test-model'});
    sent = JSON.parse(options.body);
    if (mode === 'delayed') { providerStarted(); await new Promise(resolve => {pendingRelease=resolve;}); }
    if (mode === 'failure') return new Response('Do not expose example-key',{status:429});
    return Response.json(success);
  };
  const projectsRoot = path.join(root,'projects');
  const server = createServer({projectsRoot,env:{ANTHROPIC_API_KEY:'example-key',ANTHROPIC_MODEL:'test-model'},providerFetch});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:'+server.address().port;
  async function api(route,body) {
    const response = await fetch(base+route, body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  }
  try {
    const status = await api('/api/providers/research'); assert.equal(status.configured,true); assert.ok(!JSON.stringify(status).includes('example-key'));
    assert.equal((await api('/api/providers/research/test',{})).connected,true);
    const created = await api('/api/projects',{prompt:'A video about orchard management for growers.'});
    const prefix = '/api/projects/'+created.folder;
    const initial = await api(prefix+'/intake');
    let state = await api(prefix+'/brief',{...initial.brief,angle:'Practical',purpose:'Grow better fruit',revision:0});
    const note = await api('/api/library',{kind:'note',name:'Orchard notes',content:'Prune during dormancy.',category:'knowledge'});
    // Research is grounded in what analysis actually read, so the note must be analyzed first.
    assert.equal((await api('/api/library/'+note.asset.id+'/analyze',{})).summary.state,'analyzed');
    state = await api(prefix+'/materials',{asset_id:note.asset.id,decision:'use',revision:state.project.workflow.revision});
    // A knowledge note is read for research and never published, so it needs no licence basis. Only
    // material that can reach the video is gated.
    state = await api(prefix+'/materials-confirm',{revision:state.project.workflow.revision});
    assert.equal(state.project.workflow.materials.state,'approved','A knowledge note must confirm without a licence basis');
    const options = {provider:'anthropic',web_search:true,include_materials:true};
    mode='delayed';
    const started = new Promise(resolve => {providerStarted=resolve;});
    const pending = api(prefix+'/research',options);
    // Bounded: if the request never reaches the provider, fail with a reason instead of hanging.
    const reached = await Promise.race([started.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 8000))]);
    assert.ok(reached, 'The research request must reach the provider rather than being refused earlier');
    assert.equal((await api(prefix+'/research',options)).status,409);
    assert.equal((await api(prefix+'/brief',{...initial.brief,angle:'Changed',purpose:'Other',revision:state.project.workflow.revision})).status,409);
    pendingRelease();
    const research = await pending;
    assert.equal(research.status,200);
    assert.equal(sent.tools[0].type,'web_search_20250305');
    assert.ok(sent.messages[0].content.includes('Prune during dormancy.'));
    assert.equal(research.artifact.grounding,'web_cited');
    assert.equal(research.project.workflow.stages.research.state,'needs_review');
    const directory = path.join(projectsRoot,created.folder);
    const notesPath = path.join(directory,'research/research_notes.md');
    const previous = fs.readFileSync(notesPath,'utf8');
    assert.match(previous,/Sources: \[1\]/);
    const sources = JSON.parse(fs.readFileSync(path.join(directory,'research/sources.json')));
    assert.equal(sources.sources.length,1);
    assert.ok(!JSON.stringify(await api(prefix+'/project.json')).includes('example-key'));
    assert.ok(fs.readdirSync(path.join(directory,'research/history')).length > 0);
    mode='failure';
    assert.equal((await api(prefix+'/research',options)).status,502);
    assert.equal(fs.readFileSync(notesPath,'utf8'),previous);
    mode='success';
    assert.equal((await api(prefix+'/research',{...options,web_search:false,include_materials:false})).status,200);
    assert.equal(sent.tools,undefined); assert.ok(!sent.messages[0].content.includes('Prune during dormancy.'));
    console.log('All Claude provider and research integration tests passed (mock API, no paid calls).');
  } finally { if (server.closeAllConnections) server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => {console.error(error);process.exitCode=1;});

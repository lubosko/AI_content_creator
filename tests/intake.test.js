'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('../src/server');
async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'content-intake-'));
  const projectsRoot = path.join(root,'projects');
  const libraryRoot = path.join(root,'library');
  let server, base;
  async function start() {
    server = createServer({
      projectsRoot, libraryRoot, maxUploadBytes: 1024,
      settingsFile: path.join(root, 'settings.json'),
      env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model'},
      vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
      // Research is provider-backed now, so this file needs a provider to exercise it.
      providerFetch: async () => Response.json({
        id: 'msg_1', model: 'test-model', stop_reason: 'end_turn',
        content: [{type: 'text', text: '# Research\n\n## Summary\n\nRobot safety intake.\n\n## Key findings\n\n- Check the emergency stop.\n\n## Claims to verify\n\n- None.'}],
        usage: {input_tokens: 5, output_tokens: 5}
      })
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  async function request(route,body) {
    const response = await fetch(base+route,body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  }
  async function upload(name,content,category) {
    const suffix = category ? '&category='+encodeURIComponent(category) : '';
    const response = await fetch(base+'/api/library/upload?name='+encodeURIComponent(name)+suffix,{method:'POST',body:content});
    return {status:response.status,...await response.json()};
  }
  await start();
  try {
    const created = await request('/api/projects',{prompt:'A video about safe robot work for factory managers.'});
    const prefix = '/api/projects/'+created.folder;
    const original = await request(prefix+'/intake');
    assert.equal(original.project.workflow.brief.state,'needs_review');
    assert.equal((await request(prefix+'/research',{})).status,409);
    assert.equal((await request(prefix+'/materials-confirm',{revision:0,without_material:true})).status,409);
    assert.equal((await request(prefix+'/brief',{revision:0})).status,400);
    const briefBody = {...original.brief,angle:'Practical guidance',purpose:'Recognize hazards',revision:0};
    const brief = await request(prefix+'/brief',briefBody);
    assert.equal(brief.status,200);
    assert.equal(brief.project.workflow.brief.state,'approved');
    assert.equal((await request(prefix+'/brief',briefBody)).status,409,'Stale saves must fail');
    const note = await request('/api/library',{kind:'note',name:'Factory notes',content:'Check the emergency stop.',category:'knowledge'});
    const url = await request('/api/library',{kind:'url',name:'Source',content:'https://example.com/reference',category:'knowledge'});
    assert.equal(url.status,201);
    assert.equal((await request('/api/library',{kind:'url',name:'Unsafe',content:'javascript:alert(1)'})).status,400);
    assert.equal((await upload('../escape.txt','bad')).status,400);
    assert.equal((await upload('program.exe','bad')).status,415);
    assert.equal((await upload('empty.txt','')).status,400);
    assert.equal((await upload('too-big.txt',Buffer.alloc(1025))).status,413);
    // Filed as media, so it can reach the video and needs a recorded basis. The note above is
    // knowledge: it is read for research rather than published, so it is deliberately not gated.
    const file = await upload('original.txt','Actual imported bytes.','media');
    assert.equal(file.status,201);
    assert.equal(await (await fetch(base+'/api/library/'+file.asset.id+'/file')).text(),'Actual imported bytes.');
    const range = await fetch(base+'/api/library/'+file.asset.id+'/file',{headers:{range:'bytes=0-5'}});
    assert.equal(range.status,206); assert.equal(await range.text(),'Actual');
    let state = await request(prefix+'/materials',{revision:brief.project.workflow.revision,asset_id:note.asset.id,decision:'maybe'});
    assert.equal(state.status,200);
    assert.equal((await request(prefix+'/materials-confirm',{revision:state.project.workflow.revision})).status,400);
    state = await request(prefix+'/materials',{revision:state.project.workflow.revision,asset_id:note.asset.id,decision:'use'});
    state = await request(prefix+'/materials',{revision:state.project.workflow.revision,asset_id:file.asset.id,decision:'use'});
    assert.equal((await request(prefix+'/materials-confirm',{revision:state.project.workflow.revision,without_material:true})).status,400);
    // The media item is the operator's own work, but nothing may be used until that is recorded.
    const ungated = await request(prefix+'/materials-confirm',{revision:state.project.workflow.revision});
    assert.equal(ungated.status,409,'Material that can reach the video must not be confirmable without rights');
    assert.match(ungated.error,/original\.txt/);
    assert.ok(!/Factory notes/.test(ungated.error),'A knowledge note is not published, so it must not be gated: '+ungated.error);
    const rights = await request('/api/library/rights',{asset_ids:[note.asset.id,file.asset.id],basis:'own'});
    assert.equal(rights.status,200);
    assert.equal(rights.updated,2);
    assert.equal(rights.assets.every(asset => asset.rights_summary.state === 'cleared'),true);
    assert.equal((await request('/api/library/rights',{asset_ids:[],basis:'own'})).status,400);
    assert.equal((await request('/api/library/rights',{asset_ids:[note.asset.id],basis:'not-a-licence'})).status,400);
    assert.equal((await request('/api/library/rights',{asset_ids:[note.asset.id],basis:'cc_by'})).status,400,'A credit-required licence cannot be recorded without its credit details');
    state = await request(prefix+'/materials-confirm',{revision:state.project.workflow.revision});
    assert.equal(state.project.workflow.materials.state,'approved');
    const research = await request(prefix+'/research',{provider:'anthropic',web_search:false,include_materials:false});
    assert.equal(research.status,200);
    const notesFile = path.join(projectsRoot,created.folder,'research/research_notes.md');
    const savedResearch = fs.readFileSync(notesFile,'utf8');
    // Restart the server: all library metadata, selections and approvals must survive.
    await new Promise(resolve => server.close(resolve));
    await start();
    state = await request(prefix+'/intake');
    assert.equal(state.project.workflow.materials.selections.length,2);
    assert.equal(state.project.workflow.materials.state,'approved');
    assert.equal((await request('/api/library')).assets.length,3);
    // Rights are recorded against the library original, so they must survive a restart too.
    const afterRestart = await request('/api/library');
    assert.equal(afterRestart.assets.filter(asset => (asset.rights || {}).basis === 'own').length,2,'Recorded rights must survive a restart');
    assert.equal(afterRestart.licences.length,13,'The interface needs the licence vocabulary to offer it');
    assert.equal(afterRestart.licences[afterRestart.licences.length - 1].id,'unknown','Not confirmed must stay last in the list the operator sees');
    assert.equal(afterRestart.assets.find(asset => asset.id === url.asset.id).rights_summary.state,'blocked','An unrecorded item must report as blocked, not as fine');
    assert.equal(await (await fetch(base+'/api/library/'+file.asset.id+'/file')).text(),'Actual imported bytes.');
    const other = await request('/api/projects',{prompt:'Another video.'});
    assert.equal((await request('/api/projects/'+other.folder+'/intake')).project.workflow.materials.selections.length,0);
    state = await request(prefix+'/brief',{...briefBody,angle:'Updated angle',revision:state.project.workflow.revision});
    assert.equal(state.project.workflow.materials.state,'needs_review');
    assert.equal(state.project.workflow.stages.research.state,'needs_update');
    assert.equal((await request(prefix+'/research',{})).status,409);
    assert.equal(fs.readFileSync(notesFile,'utf8'),savedResearch,'Editing inputs must preserve saved research');
    // Missing files block confirmation but can still be removed from a project.
    fs.unlinkSync(path.join(libraryRoot,file.asset.id+'.bin'));
    assert.equal((await request(prefix+'/materials-confirm',{revision:state.project.workflow.revision})).status,404);
    state = await request(prefix+'/materials',{revision:state.project.workflow.revision,asset_id:file.asset.id,decision:'remove'});
    assert.equal(state.status,200);
    state = await request(prefix+'/materials',{revision:state.project.workflow.revision,asset_id:note.asset.id,decision:'skip'});
    state = await request(prefix+'/materials-confirm',{revision:state.project.workflow.revision,without_material:true});
    assert.equal(state.status,200);
    assert.equal(state.project.workflow.materials.without_material,true);
    assert.equal((await request('/api/library')).assets.length,3,'Project removal must preserve library records');
    // Legacy projects open without fabricated approvals, then migrate on a confirmed write.
    const projectFile = path.join(projectsRoot,other.folder,'project.json');
    const legacy = JSON.parse(fs.readFileSync(projectFile)); delete legacy.workflow;
    fs.writeFileSync(projectFile,JSON.stringify(legacy));
    const loaded = await request('/api/projects/'+other.folder+'/intake');
    assert.equal(loaded.project.workflow.brief.state,'needs_review');
    assert.equal(loaded.project.workflow.approvals.length,0);
    assert.ok(!fs.readdirSync(libraryRoot).some(name => name.endsWith('.upload')));
    console.log('All intake and material persistence tests passed.');
  } finally { await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => {console.error(error);process.exitCode=1;});

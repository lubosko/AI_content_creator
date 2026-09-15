'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createSettingsStore,windowsVault,UNSAVED_CREDENTIAL}=require('../src/config/settings');
const {createServer}=require('../src/server');
async function run(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-settings-'));
 // Round-trip a disposable value through real Windows encryption without printing it.
 if(process.platform==='win32'){const vault=windowsVault();const sealed=vault.seal('disposable-test-value');assert.notEqual(sealed,'disposable-test-value');assert.equal(vault.open(sealed),'disposable-test-value');}
 // A stored secret that cannot be decrypted must degrade, never throw out of unrelated requests.
 let vaultReadable=false;
 const brokenVault={seal:s=>'sealed:'+Buffer.from(s).toString('base64'),open:s=>{if(!vaultReadable)throw new Error('nope');return Buffer.from(s.slice(7),'base64').toString();}};
 const brokenFile=path.join(root,'broken.json');
 fs.writeFileSync(brokenFile,JSON.stringify({version:1,revision:0,providers:{anthropic:{secret:'sealed:AAAA'}},defaults:{web_search:true,include_materials:false}}));
 const broken=createSettingsStore({file:brokenFile,env:{},vault:brokenVault});
 const brokenProvider=broken.summary().providers.find(p=>p.id==='anthropic');
 assert.equal(brokenProvider.status,'error','An unreadable saved key must report an error state');
 assert.equal(brokenProvider.configured,false);
 assert.equal(brokenProvider.credential_error,UNSAVED_CREDENTIAL);
 assert.equal(brokenProvider.source,'settings','An unreadable saved key must not silently fall back to the environment');
 assert.equal(broken.credentials('anthropic').key,'');
 assert.equal(broken.credentials('anthropic').error,UNSAVED_CREDENTIAL);
 // Recovering access to the credential must clear the error without a restart.
 vaultReadable=true;
 assert.equal(broken.summary().providers.find(p=>p.id==='anthropic').status,'configured','Restored credential access must clear the error');
 const vault={seal:s=>'sealed:'+Buffer.from(s).toString('base64'),open:s=>Buffer.from(s.slice(7),'base64').toString()};
 const env={ANTHROPIC_API_KEY:'env-key',ANTHROPIC_MODEL:'env-model'};
 const file=path.join(root,'settings.json');
 const store=createSettingsStore({file,env,vault});
 assert.equal(store.summary().providers[0].source,'environment');
 // revision 0 -> 1
 store.update({revision:0,provider:'anthropic',key_action:'replace',api_key:'saved-key',model:'saved-model'});
 assert.equal(store.credentials('anthropic').key,'saved-key');
 assert.equal(store.credentials('anthropic').error,null);
 assert.ok(!fs.readFileSync(file,'utf8').includes('saved-key'));
 assert.ok(!JSON.stringify(store.summary()).includes('saved-key'));
 assert.throws(()=>store.update({revision:0,defaults:{web_search:false,include_materials:false}}),/changed/);
 // revision 1 -> 2
 store.recordTest('anthropic',1,{status:'verified',message:'ok'});
 assert.equal(store.summary().providers[0].status,'verified');
 // revision 2 -> 3
 store.update({revision:2,provider:'anthropic',key_action:'remove',model:''});
 assert.equal(store.credentials('anthropic').key,'env-key');
 // revision 3 -> 4
 store.recordTest('anthropic',3,{status:'verified',message:'ok'});
 env.ANTHROPIC_API_KEY='changed-env';
 assert.equal(store.summary().providers[0].status,'configured','Changed environment must invalidate verification');
 const restarted=createSettingsStore({file,env,vault});assert.equal(restarted.summary().revision,4);
 let usedKey;
 // Isolated roots: never read or write the developer's real projects, library or settings.
 // The mock answers both provider shapes: Claude returns a model id, OpenAI returns a model list.
 const server=createServer({projectsRoot:path.join(root,'projects'),libraryRoot:path.join(root,'library'),settingsFile:file,env,vault,providerFetch:async(url,options)=>{
   // Only the OpenAI test lists models; Claude requests a single model by id.
   if(String(url).endsWith('/models')){
     assert.match(String(options.headers.authorization||''),/^Bearer /,'The OpenAI test must send a bearer token');
     return Response.json({data:[{id:'whisper-1'},{id:'gpt-4o-mini-transcribe'},{id:'tts-1'}]});
   }
   usedKey=options.headers['x-api-key'];
   return Response.json({id:'env-model'});
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 async function api(route,body,headers={}){const response=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}:{});return {status:response.status,...await response.json()};}
 try{
  let data=await api('/api/providers/research');
  assert.equal(data.status,200);
  assert.equal(data.configured,true);
  assert.equal(data.error,undefined);
  assert.equal((await api('/api/settings',{revision:4,defaults:{web_search:false,include_materials:false}},{origin:'https://foreign.example'})).status,403);
  // revision 4 -> 5
  data=await api('/api/settings',{revision:4,provider:'anthropic',key_action:'replace',api_key:'new-key',model:'env-model'});assert.equal(data.status,200);
  await api('/api/providers/research/test',{});assert.equal(usedKey,'new-key','Saved credentials must take effect without restart');
  data=await api('/api/settings/test',{revision:data.revision,provider:'anthropic'});assert.equal(data.providers[0].status,'verified');
  assert.ok(!JSON.stringify(data).includes('new-key'));
  // OpenAI is a real integration now, so it must be testable and must report the model state.
  data=await api('/api/settings',{revision:data.revision,provider:'openai',key_action:'replace',api_key:'openai-key',model:'whisper-1'});
  assert.equal(data.providers.find(p=>p.id==='openai').available,true,'OpenAI must be marked available for transcription');
  data=await api('/api/settings/test',{revision:data.revision,provider:'openai'});
  const openai=data.providers.find(p=>p.id==='openai');
  assert.equal(openai.status,'verified','A working OpenAI key must verify');
  assert.equal(openai.test.modelAvailable,true,'The configured transcription model must be reported as available');
  assert.match(openai.test.message,/whisper-1/);
  assert.ok(!JSON.stringify(data).includes('openai-key'),'The OpenAI key must never be echoed back');
  data=await api('/api/settings',{revision:data.revision,provider:'elevenlabs',key_action:'replace',api_key:'voice-key',model:''});
  assert.equal(data.providers.find(p=>p.id==='elevenlabs').available,false);
  assert.equal((await api('/api/settings/test',{revision:data.revision,provider:'elevenlabs'})).status,400);
  data=await api('/api/settings',{revision:data.revision,defaults:{web_search:false,include_materials:true}});
  assert.deepEqual(data.defaults,{web_search:false,include_materials:true});
  assert.equal((await api('/api/settings',{revision:data.revision,provider:'unknown',key_action:'keep'})).status,400);
  console.log('All Settings tests passed: encryption, persistence, redaction, precedence, unreadable-key recovery, connection tests, defaults, and stale writes.');
 }finally{await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {save,fail} = require('../lib/intakeWorkflow');
const PROVIDERS = {
  anthropic:{name:'Claude / Anthropic',category:'Research & writing',keyEnv:'ANTHROPIC_API_KEY',modelEnv:'ANTHROPIC_MODEL',defaultModel:'claude-sonnet-5',available:true},
  openai:{name:'OpenAI',category:'Research & writing',keyEnv:'OPENAI_API_KEY',modelEnv:'OPENAI_MODEL',defaultModel:'whisper-1',available:true},
  google:{name:'Google Gemini',category:'Research & writing',keyEnv:'GOOGLE_API_KEY',modelEnv:'GOOGLE_MODEL'},
  elevenlabs:{name:'ElevenLabs',category:'Voice & audio',keyEnv:'ELEVENLABS_API_KEY'},
  leonardo:{name:'Leonardo',category:'Images & video',keyEnv:'LEONARDO_API_KEY'},
  mootion:{name:'Mootion',category:'Images & video',keyEnv:'MOOTION_API_KEY'},
  comfy:{name:'Comfy Cloud (comfy.org)',category:'Images & video',keyEnv:'COMFY_API_KEY',baseUrlEnv:'COMFY_BASE_URL',defaultBaseUrl:'https://cloud.comfy.org',available:true},
  pexels:{name:'Pexels',category:'Images & video',keyEnv:'PEXELS_API_KEY',available:true}
};
const UNSAVED = 'Saved credential could not be read on this Windows account. Enter the API key again, or remove it to fall back to the environment value.';
function windowsVault() {
  function transform(value, decrypt) {
    if (process.platform !== 'win32') fail('Saving credentials currently requires Windows. Use server environment variables on other systems.',400);
    const script = "Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::" + (decrypt ? 'Unprotect' : 'Protect') + "($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))";
    try {
      const output = execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:decrypt ? value : Buffer.from(value,'utf8').toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000,stdio:['pipe','pipe','pipe']}).trim();
      return decrypt ? Buffer.from(output,'base64').toString('utf8') : output;
    } catch { fail('Windows could not access the encrypted credential. Use the same Windows account that saved it, or replace the saved key.',500); }
  }
  return {seal:value=>transform(value,false),open:value=>transform(value,true)};
}
function createSettingsStore({file,env = process.env,vault = windowsVault()}) {
  const empty = () => ({version:1,revision:0,providers:{},defaults:{web_search:true,include_materials:false}});
  // A vault.open failure must never throw out of unrelated requests. Failures are cached so a broken
  // credential costs one decryption attempt, but each read retries once so recovered access self-heals.
  const failures = new Map();
  function read() { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : empty(); }
  function provider(id) { if (!Object.hasOwn(PROVIDERS,id)) fail('Unknown provider.'); return PROVIDERS[id]; }
  function attempt(secret) {
    try { return {key:String(vault.open(secret) || '').trim(),error:null}; }
    catch { return {key:'',error:UNSAVED}; }
  }
  function openSecret(secret) {
    if (!failures.has(secret)) { const result = attempt(secret); if (result.error) failures.set(secret,result); return result; }
    const retried = attempt(secret);
    if (!retried.error) failures.delete(secret);
    return retried;
  }
  function resolve(id,data) {
    const p = provider(id), stored = data.providers[id] || {};
    // A stored secret that cannot be decrypted must NOT silently fall back to an environment key:
    // that would run requests under a credential the user did not intend.
    const key = stored.secret ? openSecret(stored.secret).key : String(env[p.keyEnv] || '').trim();
    return {key,model:String(stored.model || env[p.modelEnv] || p.defaultModel || '').trim(),source:stored.secret ? 'settings' : (env[p.keyEnv] ? 'environment' : 'none')};
  }
  function credentialError(id,data) { const stored = data.providers[id] || {}; return stored.secret ? openSecret(stored.secret).error : null; }
  function fingerprint(id,data,key) {
    const p = provider(id), stored = data.providers[id] || {};
    return createHash('sha256').update(JSON.stringify([key === undefined ? (stored.secret || env[p.keyEnv] || '') : key,stored.model || env[p.modelEnv] || p.defaultModel || ''])).digest('hex');
  }
  function summary() {
    const data = read();
    return {revision:data.revision,defaults:data.defaults,credential_storage:'Windows account encryption (DPAPI)',providers:Object.entries(PROVIDERS).map(([id,p])=>{
      const stored = data.providers[id] || {};
      const error = credentialError(id,data);
      const resolved = resolve(id,data);
      const configured = error ? false : resolved.source !== 'none';
      // Everything the UI needs from a test is carried through, so a model-availability result is
      // not silently dropped on the way to the browser.
      const storedTest = stored.test || {};
      const test = !error && storedTest.fingerprint === fingerprint(id,data,resolved.key)
        ? {status:storedTest.status,message:storedTest.message,at:storedTest.at,model:storedTest.model||null,modelAvailable:storedTest.modelAvailable===undefined?null:storedTest.modelAvailable}
        : null;
      return {id,name:p.name,category:p.category,available:!!p.available,configured,source:resolved.source,model:resolved.model,status:error ? 'error' : (configured ? (test?.status || 'configured') : 'not_configured'),credential_error:error,test};    })};
  }
  function credentials(id) {
    const data = read(), resolved = resolve(id,data);
    return {key:resolved.key,model:resolved.model,error:credentialError(id,data),source:resolved.source};
  }
  function update(body) {
    const data=read();
    if (body.revision !== data.revision) fail('Settings changed in another window. Reload Settings before saving.',409);
    if (body.provider) {
      const p = provider(body.provider);
      if (!['keep','replace','remove'].includes(body.key_action)) fail('Invalid credential action.');
      const stored={...(data.providers[body.provider] || {})};
      if (body.key_action === 'replace') {
        if (typeof body.api_key !== 'string' || !body.api_key.trim() || body.api_key.length>4096 || /[\r\n]/.test(body.api_key)) fail('Enter a valid API key.');
        stored.secret=vault.seal(body.api_key.trim());
      }
      if (body.key_action === 'remove') { delete stored.secret; failures.clear(); }
      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || body.model.length>150 || /[\r\n]/.test(body.model)) fail('Invalid model.');
        stored.model=body.model.trim();
      }
      delete stored.test;
      data.providers[body.provider]=stored;
    } else {
      if (!body.defaults || typeof body.defaults.web_search !== 'boolean' || typeof body.defaults.include_materials !== 'boolean') fail('Invalid research defaults.');
      data.defaults={web_search:body.defaults.web_search,include_materials:body.defaults.include_materials};
    }
    data.revision++;
    fs.mkdirSync(path.dirname(file),{recursive:true}); save(file,data);
    return summary();
  }
  function recordTest(id,revision,result) {
    provider(id); const data=read();
    if (data.revision !== revision) fail('Settings changed during the test. Test the current settings again.',409);
    data.providers[id]={...(data.providers[id] || {}),test:{...result,fingerprint:fingerprint(id,data,resolve(id,data).key),at:new Date().toISOString()}};
    data.revision++; fs.mkdirSync(path.dirname(file),{recursive:true}); save(file,data);
    return summary();
  }
  return {summary,credentials,update,recordTest};
}
module.exports={createSettingsStore,windowsVault,UNSAVED_CREDENTIAL:UNSAVED};

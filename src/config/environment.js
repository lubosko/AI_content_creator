'use strict';
const fs = require('node:fs');
// Read only supported settings; never expose credentials through the API or logs.
function loadEnvironment(file, env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(ANTHROPIC_API_KEY|ANTHROPIC_MODEL|OPENAI_API_KEY|OPENAI_MODEL|GOOGLE_API_KEY|GOOGLE_MODEL|ELEVENLABS_API_KEY|LEONARDO_API_KEY|MOOTION_API_KEY|COMFY_API_KEY|COMFY_BASE_URL|PEXELS_API_KEY)\s*=\s*(.*?)\s*$/);
    if (!match || env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
    else value = value.replace(/\s+#.*$/,'').trim();
    env[match[1]] = value;
  }
}
module.exports = {loadEnvironment};

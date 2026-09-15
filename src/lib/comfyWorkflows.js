'use strict';
/* The operator ComfyUI workflows, and the mapping that says where a scene prompt goes.

   These are documents, not credentials, so they live beside the settings file rather than inside
   the credential store — which holds one secret and one model string and has no room for a workflow
   graph. The directory is:

     projects/_settings/comfy/workflows.json      the mapping
     projects/_settings/comfy/<file>.json         the API-format workflows, verbatim

   Nothing here writes to those files: the operator exports them from ComfyUI and the app reads them. */

const fs = require('node:fs');
const path = require('node:path');
const comfy = require('../providers/comfy');

const OUTPUT_KINDS = ['image', 'video'];

function fail(message, status = 409) { throw Object.assign(new Error(message), {status}); }

function configDirectory(projectsRoot) { return path.join(projectsRoot, '_settings', 'comfy'); }
function configPath(projectsRoot) { return path.join(configDirectory(projectsRoot), 'workflows.json'); }

function readJson(file) {
  try { return {value: JSON.parse(fs.readFileSync(file, 'utf8')), problem: null}; }
  catch (error) { return {value: null, problem: error.message}; }
}

/* Returns a shape the callers can render whatever the state of the directory, so the interface can
   say what is missing rather than showing an empty picker. */
function loadConfig(projectsRoot) {
  const file = configPath(projectsRoot);
  const directory = configDirectory(projectsRoot);
  if (!fs.existsSync(file)) {
    return {
      ok: false, path: file, directory, exists: false, config: null,
      problem: 'No Comfy workflow is configured yet. Create ' + file + ' to point the app at your exported API workflow.'
    };
  }
  const read = readJson(file);
  if (read.problem) {
    return {ok: false, path: file, directory, exists: true, config: null, problem: 'That file is not valid JSON: ' + read.problem};
  }
  const config = read.value;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {ok: false, path: file, directory, exists: true, config: null, problem: 'That file must contain a JSON object.'};
  }
  const workflows = config.workflows;
  if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows) || !Object.keys(workflows).length) {
    return {ok: false, path: file, directory, exists: true, config, problem: 'That file has no "workflows" object. See docs/COMFY_GENERATION.md for the shape.'};
  }
  const entries = [];
  for (const name of Object.keys(workflows)) {
    const entry = workflows[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {ok: false, path: file, directory, exists: true, config, problem: 'Workflow "' + name + '" must be an object.'};
    }
    const output = String(entry.output || 'image');
    if (!OUTPUT_KINDS.includes(output)) {
      return {ok: false, path: file, directory, exists: true, config, problem: 'Workflow "' + name + '" declares output "' + output + '". Choose ' + OUTPUT_KINDS.join(' or ') + '.'};
    }
    const workflowFile = String(entry.file || '').trim();
    if (!workflowFile || /[\\/]/.test(workflowFile) || workflowFile.includes('..')) {
      return {ok: false, path: file, directory, exists: true, config, problem: 'Workflow "' + name + '" needs a plain "file" name inside ' + directory + '.'};
    }
    entries.push({
      name,
      file: workflowFile,
      path: path.join(directory, workflowFile),
      exists: fs.existsSync(path.join(directory, workflowFile)),
      output,
      prompt_node: entry.prompt_node === undefined || entry.prompt_node === null ? null : String(entry.prompt_node),
      prompt_field: String(entry.prompt_field || 'text'),
      output_node: entry.output_node === undefined || entry.output_node === null ? null : String(entry.output_node),
      uses_api_nodes: entry.uses_api_nodes === true
    });
  }
  const fallback = entries.some(item => item.name === 'image') ? 'image' : entries[0].name;
  const chosen = config.default === undefined || config.default === null ? fallback : String(config.default);
  if (!entries.some(item => item.name === chosen)) {
    return {ok: false, path: file, directory, exists: true, config, problem: 'The default workflow "' + chosen + '" is not one of: ' + entries.map(item => item.name).join(', ') + '.'};
  }
  return {ok: true, path: file, directory, exists: true, config, configDirectory: directory, default: chosen, workflows: entries, problem: null};
}

function workflowSummary(projectsRoot) {
  const loaded = loadConfig(projectsRoot);
  if (!loaded.ok) return {configured: false, problem: loaded.problem, path: loaded.path, workflows: [], base_url: null};
  /* A config file is not a workflow. Reporting `configured: true` for one that points at a file which
     does not exist would let the pipeline start and fail at the first scene, and would offer a
     generation the app cannot deliver. So usability is decided by the files, not by the config. */
  const usable = loaded.workflows.filter(item => item.exists);
  const fallback = loaded.workflows.find(item => item.name === loaded.default);
  let problem = null;
  if (!usable.length) {
    problem = 'No exported workflow file was found. Save your ComfyUI export (Workflow then Export (API)) as '
      + loaded.workflows.map(item => item.path).join(' or ') + '.';
  } else if (fallback && !fallback.exists) {
    problem = 'The default workflow "' + loaded.default + '" points at ' + fallback.path
      + ', which is missing. Save your exported workflow there, or change "default" in workflows.json.';
  }
  return {
    configured: usable.length > 0,
    problem,
    path: loaded.path,
    default: loaded.default,
    base_url: (loaded.config && loaded.config.base_url) || null,
    workflows: loaded.workflows.map(item => ({
      name: item.name, output: item.output, file: item.file, exists: item.exists,
      prompt_node: item.prompt_node, prompt_field: item.prompt_field
    }))
  };
}

/* Loads one workflow and prepares the graph for submission: the prompt is injected into a copy, so
   the operator file is never rewritten. Every refusal names the real reason. */
function buildSubmission({projectsRoot, name, prompt}) {
  const loaded = loadConfig(projectsRoot);
  if (!loaded.ok) fail(loaded.problem);
  const chosen = name ? String(name) : loaded.default;
  const entry = loaded.workflows.find(item => item.name === chosen);
  if (!entry) {
    fail('Unknown Comfy workflow "' + chosen + '". Configured workflows: ' + loaded.workflows.map(item => item.name).join(', ') + '.');
  }
  if (!entry.exists) {
    fail('The workflow file ' + entry.path + ' is missing. Export it from ComfyUI with Workflow then Export (API) and save it there.');
  }
  const read = readJson(entry.path);
  if (read.problem) fail('The workflow file ' + entry.path + ' is not valid JSON: ' + read.problem);
  const checked = comfy.validateWorkflow(read.value, {promptNode: entry.prompt_node, promptField: entry.prompt_field});
  if (!checked.ok) fail('The workflow "' + chosen + '" cannot be used. ' + checked.problem);
  const text = String(prompt === undefined || prompt === null ? '' : prompt).trim();
  if (!text) fail('This scene has no generation prompt, so there is nothing to send. Write a prompt on the scene first.');
  return {
    name: chosen,
    entry,
    graph: comfy.injectPrompt(read.value, {node: checked.promptNode, field: checked.promptField, text}),
    prompt: text,
    prompt_node: checked.promptNode,
    prompt_field: checked.promptField,
    uses_api_nodes: entry.uses_api_nodes
  };
}

module.exports = {OUTPUT_KINDS, configDirectory, configPath, loadConfig, workflowSummary, buildSubmission, fail};
#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createProject, parsePlatformList } = require("./lib/projectGenerator");

function printUsage() {
  console.log(`Usage:
  node src/cli.js create "<prompt>" [options]

Options:
  --topic <topic>
  --language <language>
  --duration <seconds>
  --platforms <comma-separated-platforms>
  --primary-platform <platform>
  --out <directory>
  --id <project-id>
  --slug <slug>
  --llm-provider <name>
  --llm-model <model>
  --scene-provider <name>
  --sequence-provider <name>
  --voice-provider <name>
  --voice-id <id>
  --json
`);
}

function readArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, json: false };
  const promptParts = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      promptParts.push(arg);
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    const key = arg.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    index += 1;

    switch (key) {
      case "topic":
        options.topic = value;
        break;
      case "language":
        options.language = value;
        break;
      case "duration":
        options.targetDurationSeconds = Number(value);
        if (!Number.isFinite(options.targetDurationSeconds) || options.targetDurationSeconds <= 0) {
          throw new Error("--duration must be a positive number of seconds");
        }
        break;
      case "platforms":
        options.targetPlatforms = parsePlatformList(value);
        break;
      case "primary-platform":
        options.primaryPlatform = value;
        break;
      case "out":
        options.outDir = value;
        break;
      case "id":
        options.projectId = value;
        break;
      case "slug":
        options.slug = value;
        break;
      case "llm-provider":
        options.llmProvider = value;
        break;
      case "llm-model":
        options.llmModel = value;
        break;
      case "scene-provider":
        options.sceneProvider = value;
        break;
      case "sequence-provider":
        options.sequenceProvider = value;
        break;
      case "voice-provider":
        options.voiceProvider = value;
        break;
      case "voice-id":
        options.voiceId = value;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.prompt = promptParts.join(" ").trim();
  return options;
}

function main() {
  const options = readArgs(process.argv.slice(2));

  if (!options.command || options.command === "help" || options.command === "--help") {
    printUsage();
    return;
  }

  if (options.command !== "create") {
    throw new Error(`Unknown command: ${options.command}`);
  }

  if (!options.prompt) {
    throw new Error("A project prompt is required.");
  }

  const result = createProject(options);

  if (options.json) {
    console.log(JSON.stringify({
      projectDirectory: result.projectDirectory,
      project: result.project
    }, null, 2));
    return;
  }

  console.log("Project created");
  console.log(`Directory: ${result.projectDirectory}`);
  console.log(`Project ID: ${result.project.project_id}`);
  console.log(`Topic: ${result.project.topic}`);
  console.log(`Status: ${result.project.status}`);
  console.log(`Open: ${path.join(result.projectDirectory, "project.json")}`);
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

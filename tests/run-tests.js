"use strict";

const { spawnSync } = require("node:child_process");

for (const testFile of ["tests/generator.test.js", "tests/server.test.js", "tests/intake.test.js", "tests/analysis.test.js", "tests/transcribe.test.js", "tests/stages.test.js", "tests/production.test.js", "tests/sourcing.test.js", "tests/scene-assets.test.js", "tests/comfy.test.js", "tests/render.test.js", "tests/compose.test.js", "tests/pipeline.test.js", "tests/exports.test.js", "tests/walkthrough.test.js", "tests/research-provider.test.js", "tests/settings.test.js", "tests/capabilities.test.js", "tests/ui.test.js", "tests/ui-serve.test.js", "tests/ui-journey.test.js", "tests/ui-scene-fill.test.js", "tests/ui-delivery.test.js", "tests/ui-pipeline.test.js", "tests/ui-render-browser.test.js", "tests/ui-browser.test.js"]) {
  const result = spawnSync(process.execPath, [testFile], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    break;
  }
}

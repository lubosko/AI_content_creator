'use strict';
/* Real-browser smoke test. This is the only test that loads the actual HTML, executes every script
   tag in order, applies the real stylesheet, and renders real pixels. It catches the class of
   failure the fake-DOM tests cannot: a broken module path or a boot-time exception that would
   leave a blank page in a real browser.

   Screenshots are written to test-results/ for visual inspection. They are not assertions. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createServer} = require('../src/server');
const {launch, findBrowser} = require('./helpers/browser');

const SHOTS = path.join(__dirname, '..', 'test-results');

async function run() {
  const browser = findBrowser();
  if (!browser && process.env.ALLOW_SKIP_BROWSER_TESTS === '1') {
    console.log('All browser smoke tests skipped: no Chrome or Edge found, and ALLOW_SKIP_BROWSER_TESTS=1.');
    return;
  }
  assert.ok(browser, 'No Chrome or Edge installation found, so the real-browser checks cannot run. Install one, set CHROME_PATH, or set ALLOW_SKIP_BROWSER_TESTS=1 to skip deliberately.');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-browser-'));
  const server = createServer({
    projectsRoot: path.join(root, 'projects'),
    libraryRoot: path.join(root, 'library'),
    settingsFile: path.join(root, 'settings.json'),
    env: {ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model', OPENAI_API_KEY: 'test-openai-key', OPENAI_MODEL: 'whisper-1'},
    vault: {seal: value => 'sealed:' + value, open: value => String(value).replace(/^sealed:/, '')},
    // No paid calls: the provider boundary is mocked. Research must return the sections the stage
    // validates, so the mock reflects a realistic answer rather than a stub.
    providerFetch: async (url, options) => {
      const body = JSON.parse((options && options.body) || '{}');
      const prompt = JSON.stringify(body.messages || '');
      const text = prompt.includes('Create the content strategy')
        ? JSON.stringify({story_promise: 'Understand safe robot work', target_audience: 'Factory managers', angle: 'Safety first', structure: [{section: 'Hook', purpose: 'Open with the risk', seconds: 20}], hooks: ['The robot will not warn you.'], retention_moments: [], material_usage: [], short_form_opportunities: [], risks: []})
        : prompt.includes('Write the full narration script')
          ? JSON.stringify({sections: [{id: 'hook', title: 'Hook', narration: 'Mocked narration about safe robot work.', visual_notes: [], seconds: 20, source_refs: ['research'], short_form: true}], estimated_duration_seconds: 180})
          : '# Research\n\n## Summary\n\nBrowser smoke findings about safe robot work.\n\n## Key findings\n\n- The emergency stop is on the left post.\n\n## Claims to verify\n\n- Nothing unverified.';
      return Response.json({
        id: 'msg_1', model: 'test-model', stop_reason: 'end_turn',
        content: [{type: 'text', text, citations: [{url: 'https://example.com/source', title: 'Example source'}]}],
        usage: {input_tokens: 10, output_tokens: 20}
      });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  fs.rmSync(SHOTS, {recursive: true, force: true});

  let page = null;
  try {
    page = await launch({width: 1440, height: 900});
    await page.navigate(base + '/');

    // --- the page must actually boot: all modules loaded, shell rendered ---
    await page.waitFor('!!window.App && !!window.Stages && !!window.Components', 'the UI modules to load');
    await page.waitFor('document.querySelectorAll(".stage-link").length > 0', 'the stage rail to render');
    await page.waitFor('document.body.innerText.indexOf("Start with an idea") >= 0', 'the project picker to render');

    const shell = await page.evaluate('return {title: document.title, scripts: document.querySelectorAll("script[src]").length, styles: document.styleSheets.length, railGroups: document.querySelectorAll(".rail-group").length, stages: document.querySelectorAll(".stage-link").length, pipeline: (document.getElementById("goPipeline") || {}).innerText, pipelineDisabled: (document.getElementById("goPipeline") || {}).disabled};');
    assert.equal(shell.scripts, 15, 'Every UI module must load from the shell');
    assert.ok(shell.styles >= 1, 'The stylesheet must load');
    assert.equal(shell.railGroups, 4, 'The rail must group the stages');
    assert.equal(shell.stages, 10, 'The rail must show every agreed stage');
    assert.ok(shell.title.length > 0, 'The page must have a title');
    // The run action is a project action, so it is in the menu and unavailable until a project is open.
    assert.equal(String(shell.pipeline).trim(), 'Run to final check', 'The menu must offer the run action');
    assert.equal(shell.pipelineDisabled, true, 'The run action must be unavailable with no project open');

    // --- the stylesheet must actually apply, not just load ---
    const styled = await page.evaluate('var b = getComputedStyle(document.body); var link = document.querySelector(".stage-link"); return {bg: b.backgroundColor, railWidth: link ? getComputedStyle(link).display : "none", accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()};');
    assert.notEqual(styled.bg, 'rgba(0, 0, 0, 0)', 'The design system must style the page background');
    assert.ok(styled.accent.length > 0, 'Design tokens must be defined');

    // --- the whole rail must fit, or the later stages are unreachable without scrolling ---
    const rail = await page.evaluate('var rail = document.querySelector(".rail"); var links = Array.from(document.querySelectorAll(".stage-link")); var lastBox = links[links.length - 1].getBoundingClientRect(); var railBox = rail.getBoundingClientRect(); return {overflows: rail.scrollHeight > rail.clientHeight + 1, lastBottom: Math.round(lastBox.bottom), railBottom: Math.round(railBox.bottom), clipped: links.filter(function (n) { return n.scrollWidth > n.clientWidth + 1; }).length};');
    assert.equal(rail.overflows, false, 'The stage rail must not scroll at 1440x900; later stages would be hidden');
    assert.ok(rail.lastBottom <= rail.railBottom + 1, 'The last stage must sit inside the rail (last ' + rail.lastBottom + ' vs rail ' + rail.railBottom + ')');
    assert.equal(rail.clipped, 0, 'No stage label may be clipped horizontally');

    // --- the whole workflow is implemented, and the rail must not pretend otherwise ---
    const railText = await page.evaluate('return Array.from(document.querySelectorAll(".stage-link")).map(function (n) { return n.innerText.trim(); }).join(" | ");');
    assert.ok(!/\(planned\)|\(template\)/.test(railText), 'No stage may be labelled planned or template in the real DOM, got: ' + railText);
    for (const label of ['Brief', 'Own material', 'Research', 'Strategy', 'Script', 'Storyboard', 'Assets', 'Composer', 'Final check', 'Exports']) {
      assert.ok(railText.indexOf(label) >= 0, 'The rail must offer ' + label + ', got: ' + railText);
    }

    await page.screenshot(path.join(SHOTS, '01-picker.png'));

    // --- create a project through the real form ---
    await page.evaluate('document.getElementById("prompt").value = "A video about safe robot work for factory managers."; return true;');
    await page.evaluate('Array.from(document.querySelectorAll("button")).filter(function (b) { return b.innerText.trim() === "Start project"; })[0].click(); return true;');
    await page.waitFor('location.hash.indexOf("/project/") >= 0', 'navigation into the new project');
    await page.waitFor('!!document.getElementById("brief-angle")', 'the brief stage to render');
    await page.waitFor('document.getElementById("viewTitle").innerText.trim() === "Brief"', 'the brief view title');
    await page.screenshot(path.join(SHOTS, '02-brief.png'));

    const briefState = await page.evaluate('return {hasInspector: !document.getElementById("inspector").hidden, current: document.querySelectorAll(\'.stage-link[aria-current="step"]\').length, inspectorText: document.getElementById("inspectorBody").innerText.slice(0, 200)};');
    assert.equal(briefState.hasInspector, true, 'The inspector must appear for an open project');
    assert.equal(briefState.current, 1, 'Exactly one stage must be marked current');
    assert.ok(briefState.inspectorText.indexOf('Brief:') >= 0, 'The inspector must report workflow state');

    // --- confirm the brief and land on the material stage ---
    await page.evaluate('document.getElementById("brief-angle").value = "Practical hazard guidance"; document.getElementById("brief-purpose").value = "Recognize and reduce hazards"; return true;');
    await page.evaluate('Array.from(document.querySelectorAll("button")).filter(function (b) { return b.innerText.trim().indexOf("Confirm brief") === 0; })[0].click(); return true;');
    await page.waitFor('!!document.getElementById("materialFiles")', 'the material stage to render');
    await page.screenshot(path.join(SHOTS, '03-material.png'));

    // --- import a real file the way a browser would ---
    const imported = await page.evaluate([
      'var input = document.getElementById("materialFiles");',
      'var file = new File(["Emergency stop procedure for the robot cell."], "safety-notes.txt", {type: "text/plain"});',
      'var transfer = new DataTransfer();',
      'transfer.items.add(file);',
      'input.files = transfer.files;',
      'input.dispatchEvent(new Event("change", {bubbles: true}));',
      'return input.files.length;'
    ].join('\n'));
    assert.equal(imported, 1, 'The file input must accept the constructed file');
    await page.waitFor('document.querySelectorAll(".asset").length >= 1', 'the imported asset card to render', 10000);
    const card = await page.evaluate('var card = document.querySelector(".asset"); return {decision: card.getAttribute("data-decision"), analysis: card.getAttribute("data-analysis"), text: card.innerText.slice(0, 160), preview: !!card.querySelector("a")};');
    assert.equal(card.decision, 'use', 'A freshly imported file must be selected for this project');
    assert.equal(card.analysis, 'awaiting_analysis', 'Imported material must not claim to be analyzed');
    assert.ok(card.text.indexOf('safety-notes.txt') >= 0, 'The card must show the real filename');
    await page.screenshot(path.join(SHOTS, '04-material-imported.png'));

    // --- analyze it in the real browser and read the real result ---
    await page.evaluate('Array.from(document.querySelectorAll(".asset button")).filter(function (b) { return b.innerText.indexOf("Analyze") >= 0; })[0].click(); return true;');
    await page.waitFor('document.querySelector(".asset").getAttribute("data-analysis") === "analyzed"', 'the material to be analyzed', 15000);
    const analyzed = await page.evaluate('return document.querySelector(".asset").innerText;');
    assert.ok(analyzed.indexOf('characters read') >= 0, 'An analyzed text asset must report the extracted length, got: ' + analyzed.slice(0, 200));
    await page.screenshot(path.join(SHOTS, '05-material-analyzed.png'));

    // --- long audio must ask before spending money, in a real browser ---
    // 660 s but deliberately tiny: 32x32 at 1 fps with silence, so the transfer stays small while
    // the duration still crosses the confirmation threshold.
    const {execFileSync} = require('node:child_process');
    const {detectMediaTools} = require('../src/config/capabilities');
    const ffmpeg = detectMediaTools().find(tool => tool.name === 'ffmpeg');
    assert.ok(ffmpeg && ffmpeg.available, 'ffmpeg is required to build the long-audio fixture');
    const longClip = path.join(root, 'long.mp4');
    execFileSync(ffmpeg.path, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=32x32:r=1:d=660',
      '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '660', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '51', '-g', '600', '-c:a', 'aac', '-b:a', '8k', longClip], {stdio: 'ignore'});
    assert.ok(fs.statSync(longClip).size < 2 * 1024 * 1024, 'The fixture must stay small: ' + fs.statSync(longClip).size + ' bytes');
    const base64Clip = fs.readFileSync(longClip).toString('base64');
    await page.evaluate([
      'var binary = atob("' + base64Clip + '");',
      'var bytes = new Uint8Array(binary.length);',
      'for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);',
      'var input = document.getElementById("materialFiles");',
      'var transfer = new DataTransfer();',
      'transfer.items.add(new File([bytes], "long.mp4", {type: "video/mp4"}));',
      'input.files = transfer.files;',
      'input.dispatchEvent(new Event("change", {bubbles: true}));',
      'return input.files.length;'
    ].join('\n'));
    // The upload finishes asynchronously; wait for the card before touching it.
    await page.waitFor('Array.from(document.querySelectorAll(".asset")).some(function (c) { return c.innerText.indexOf("long.mp4") >= 0; })', 'the long clip card', 30000);
    // Analyzing is free and must show the analysis state before any money is discussed.
    await page.evaluate('var card = Array.from(document.querySelectorAll(".asset")).filter(function (c) { return c.innerText.indexOf("long.mp4") >= 0; })[0]; Array.from(card.querySelectorAll("button")).filter(function (b) { return b.innerText.trim() === "Analyze"; })[0].click(); return true;');
    // waitFor wraps its argument in an expression, so it must be a single expression, not statements.
    await page.waitFor('(function () { var card = Array.from(document.querySelectorAll(".asset")).filter(function (c) { return c.innerText.indexOf("long.mp4") >= 0; })[0]; return !!card && card.getAttribute("data-analysis") === "needs_confirmation"; })()', 'the long clip to await confirmation', 60000);
    // The card must offer a priced confirmation, not transcribe on its own.
    const longCard = await page.evaluate('var card = Array.from(document.querySelectorAll(".asset")).filter(function (c) { return c.innerText.indexOf("long.mp4") >= 0; })[0]; return card ? {state: card.getAttribute("data-analysis"), text: card.innerText.slice(0, 260), button: (Array.from(card.querySelectorAll("button")).filter(function (b) { return /Transcribe/.test(b.innerText); })[0] || {}).innerText} : null;');
    assert.ok(longCard, 'The long clip must render a card');
    assert.equal(longCard.state, 'needs_confirmation', 'Long audio must wait for confirmation, got ' + longCard.state);
    assert.match(longCard.button, /\$/, 'The confirmation button must show the estimated cost, got: ' + longCard.button);
    assert.ok(longCard.text.indexOf('minute') >= 0, 'The card must state how long the file is');
    await page.screenshot(path.join(SHOTS, '06-transcribe-pending.png'));

    await page.evaluate('var card = Array.from(document.querySelectorAll(".asset")).filter(function (c) { return c.innerText.indexOf("long.mp4") >= 0; })[0]; Array.from(card.querySelectorAll("button")).filter(function (b) { return /Transcribe/.test(b.innerText); })[0].click(); return true;');
    await page.waitFor('!!document.querySelector(".modal")', 'the cost confirmation dialog');
    const dialog = await page.evaluate('return document.querySelector(".modal").innerText;');
    assert.ok(/costs approximately/.test(dialog), 'The dialog must state the cost, got: ' + dialog);
    assert.ok(/minute/.test(dialog), 'The dialog must state the duration');
    await page.screenshot(path.join(SHOTS, '07-transcribe-confirm.png'));
    // Cancel: nothing is spent and the card stays as it was.
    await page.evaluate('Array.from(document.querySelectorAll(".modal button")).filter(function (b) { return b.innerText.trim() === "Cancel"; })[0].click(); return true;');
    await page.waitFor('!document.querySelector(".modal")', 'the dialog to close');
    const afterCancel = await page.evaluate('var card = Array.from(document.querySelectorAll(".asset")).filter(function (c) { return c.innerText.indexOf("long.mp4") >= 0; })[0]; return card.getAttribute("data-analysis");');
    assert.equal(afterCancel, 'needs_confirmation', 'Cancelling must not transcribe or change the state');

    // --- the rights gate, in a real browser ---
    // Nothing marked Use may be confirmed until its rights are recorded, so the gate is exercised
    // here exactly as an operator would meet it.
    await page.evaluate('Array.from(document.querySelectorAll("button")).filter(function (b) { return b.innerText.trim() === "Record rights"; })[0].click(); return true;');
    await page.waitFor('!!document.getElementById("rightsBasis")', 'the rights dialog');
    const rightsStart = await page.evaluate('return document.querySelector(".modal").innerText;');
    assert.ok(/confirmed basis/.test(rightsStart), 'The dialog must state what an unconfirmed basis means, got: ' + rightsStart);
    await page.evaluate('var s = document.getElementById("rightsBasis"); s.value = "own"; s.dispatchEvent(new Event("change")); return true;');
    await page.waitFor('document.querySelector(".modal").innerText.indexOf("Commercial use allowed") >= 0', 'the licence consequence to update');
    await page.screenshot(path.join(SHOTS, '07b-rights-dialog.png'));
    await page.evaluate('Array.from(document.querySelectorAll(".modal button")).filter(function (b) { return b.innerText.trim() === "Save rights"; })[0].click(); return true;');
    await page.waitFor('!document.querySelector(".modal")', 'the rights dialog to close');
    await page.waitFor('document.body.innerText.indexOf("Rights: Own work") >= 0', 'the card to report cleared rights');

    // --- provider-backed stages expose an approval gate in a real browser ---
    // Confirm material, then run research and check the approval controls appear.
    // The full button list matters: truncating it once hid the very button being asserted on.
    const materialState = await page.evaluate('return {hash: location.hash, buttons: Array.from(document.querySelectorAll("button")).map(function (b) { return b.innerText.trim(); })};');
    assert.ok(materialState.hash.indexOf('/material') >= 0, 'The material stage must still be open, got ' + materialState.hash);
    const confirmMaterial = materialState.buttons.filter(label => label.indexOf('Confirm material') === 0);
    assert.equal(confirmMaterial.length, 1, 'The confirm action must be available, buttons were: ' + materialState.buttons.join(' | '));
    await page.evaluate('Array.from(document.querySelectorAll("button")).filter(function (b) { return b.innerText.trim().indexOf("Confirm material") === 0; })[0].click(); return true;');
    await page.waitFor('location.hash.indexOf("/research") >= 0', 'navigation to the research stage', 15000);
    await page.evaluate('Array.from(document.querySelectorAll("button")).filter(function (b) { return /Generate research/.test(b.innerText); })[0].click(); return true;');
    await page.waitFor('document.body.innerText.indexOf("Approval") >= 0', 'the approval gate to appear', 20000);
    const approval = await page.evaluate('var headers = Array.from(document.querySelectorAll(".panel-head-text h2")).filter(function (h) { return h.innerText.trim() === "Approval"; }); return {panels: headers.length, text: document.body.innerText.slice(document.body.innerText.indexOf("Approval"), document.body.innerText.indexOf("Approval") + 300)};');
    assert.ok(approval.panels >= 1, 'A generated creative stage must show an approval gate');
    assert.ok(/Approve revision \d+/.test(approval.text), 'The approval must name the revision it reviews, got: ' + approval.text);
    assert.ok(/Review needed/.test(approval.text), 'An unapproved result must ask for review');
    await page.evaluate('var btn = Array.from(document.querySelectorAll("button")).filter(function (b) { return /^Approve revision/.test(b.innerText); })[0]; if (btn) btn.scrollIntoView(); return true;');
    await page.screenshot(path.join(SHOTS, '08-approval-gate.png'));

    // Approving records the decision and unlocks the next stage.
    await page.evaluate('Array.from(document.querySelectorAll("button")).filter(function (b) { return /^Approve revision/.test(b.innerText); })[0].click(); return true;');
    await page.waitFor('document.body.innerText.indexOf("Approved at revision") >= 0', 'the approval to be recorded', 15000);
    const railAfter = await page.evaluate('var link = Array.from(document.querySelectorAll(".stage-link")).filter(function (n) { return n.innerText.indexOf("Strategy") >= 0; })[0]; return link ? link.getAttribute("data-state") : null;');
    assert.equal(railAfter, 'ready', 'Approving research must unlock strategy, rail reported ' + railAfter);
    await page.screenshot(path.join(SHOTS, '09-approved.png'));

    // --- the browser console must be clean ---
    assert.deepEqual(page.pageErrors, [], 'The page must not throw: ' + page.pageErrors.join(' | '));
    assert.deepEqual(page.consoleErrors, [], 'The console must be free of errors: ' + page.consoleErrors.join(' | '));

    const shots = fs.readdirSync(SHOTS).sort();
    assert.equal(shots.length, 10, 'Ten screenshots must be captured');
    for (const shot of shots) assert.ok(fs.statSync(path.join(SHOTS, shot)).size > 1000, shot + ' must contain a real image');

    console.log('All browser smoke tests passed: real page boot, applied styles, 15 modules loaded, no console errors.');
    console.log('Browser: ' + page.protocol + ' at ' + browser);
    console.log('Screenshots written to test-results/: ' + shots.join(', '));
  } finally {
    if (page) await page.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
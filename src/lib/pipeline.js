'use strict';
/* Run to final check: one action that takes an approved storyboard to a rendered, QC-inspected
   master and stops there.

   Two properties this deliberately keeps:
   - It never approves anything. Approval is a human decision, and the final check exists precisely
     because the remaining questions ("did you watch it", "are the figures right") are the ones the
     app cannot answer for itself.
   - It never runs the exports stage. "Up to the final check" is the contract.

   The run happens in the background, not inside one HTTP request, because a generation pass plus a
   render is minutes of work. The record lives at generated/pipeline_run.json, so reloading the page
   re-attaches and a server restart is reported as interrupted rather than as a frozen progress bar.

   Every writer here mutates the one in-memory `run` object and then persists it. Reading the record
   back from disk on each write would silently discard whatever the in-memory copy had already
   changed, which is exactly the bug this shape exists to prevent. */

const fs = require('node:fs');
const path = require('node:path');

const RUN_FILE = 'generated/pipeline_run.json';
const STEP_IDS = ['generate', 'assets', 'compose', 'final'];
const STEP_LABELS = {
  generate: 'Generate missing scene media',
  assets: 'Assets: narration, local drawings, stock',
  compose: 'Composer: build the master and inspect it',
  final: 'Final check'
};

function fail(message, status = 409) { throw Object.assign(new Error(message), {status}); }

function runPath(directory) { return path.join(directory, RUN_FILE); }

function readRun(directory) {
  const file = runPath(directory);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

function writeRun(directory, run) {
  const file = runPath(directory);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(run, null, 2) + '\n');
  fs.renameSync(temp, file);
  return run;
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return null; }
}

/* Everything the pipeline refuses to start for, checked before anything is spent. Each problem names
   what to do, not just what is wrong. */
function preflight(ctx) {
  const problems = [];
  const workflow = (ctx.project && ctx.project.workflow) || {};
  if ((workflow.brief || {}).state !== 'approved') problems.push('Confirm the brief first.');
  if ((workflow.materials || {}).state !== 'approved') problems.push('Confirm your material selection first.');
  const stages = workflow.stages || {};
  const storyboard = stages.storyboard || {};
  if (!storyboard.revision) {
    problems.push('Generate the storyboard first. There is nothing to fill yet.');
  } else if (storyboard.state !== 'approved') {
    /* The storyboard gate is not bureaucracy: generating media spends money and takes minutes, and
       doing that against a scene plan nobody has reviewed would spend it on a plan about to change. */
    problems.push('Approve the storyboard first. Generating media costs credits, so it should not run against a plan you have not reviewed.');
  }
  const board = readJsonIfPresent(path.join(ctx.directory, 'storyboard/storyboard.json'));
  if (!board || !Array.isArray(board.scenes) || !board.scenes.length) {
    problems.push('The storyboard has no scenes to work from. Generate it again.');
  }
  return {ok: problems.length === 0, problems};
}

/* Scenes the assets stage still has to fill: no own media, and no local template to draw. */
function scenesNeedingMedia(board) {
  return ((board && board.scenes) || []).filter(scene => !scene.asset_id && !scene.graphic_template);
}

/* The subset worth sending to a generator: it also needs a prompt to send. */
function generatableScenes(board) {
  return scenesNeedingMedia(board).filter(scene => String(scene.generation_prompt || '').trim());
}

function createPipelineRunner() {
  // folder -> {canceled, controller}
  const active = new Map();

  function isRunning(folder) { return active.has(folder); }

  /* A record that says "running" with no task behind it means the server restarted mid-run. Reporting
     that honestly is better than a progress bar that never moves again. */
  function status(directory, folder) {
    const run = readRun(directory);
    if (!run) return null;
    if (run.status === 'running' && !isRunning(folder)) {
      return Object.assign({}, run, {
        status: 'interrupted',
        stop_reason: 'The server stopped while this run was in progress. Nothing was lost: scenes already generated are attached, so starting again continues from there.'
      });
    }
    return Object.assign({}, run, {running: isRunning(folder)});
  }

  /* Persists the in-memory run, never a re-read copy. */
  function patch(directory, run, changes) {
    Object.assign(run, changes);
    return writeRun(directory, run);
  }

  function patchStep(directory, run, stepId, changes) {
    run.steps = run.steps.map(step => step.id === stepId ? Object.assign({}, step, changes) : step);
    return writeRun(directory, run);
  }

  /* Starts a run and returns its record immediately; the work continues in the background. */
  function start({folder, directory, board, stopAfter, deps}) {
    if (isRunning(folder)) fail('A run is already in progress for this project.', 409);
    const run = {
      started_at: new Date().toISOString(),
      stop_after: stopAfter === 'generate' ? 'generate' : 'final_check',
      status: 'running',
      steps: STEP_IDS.map(id => ({id, label: STEP_LABELS[id], status: 'pending', detail: null, started_at: null, finished_at: null})),
      generated: {succeeded: [], failed: [], skipped: [], total: 0},
      last_scene: null,
      last_progress: null,
      stop_reason: null
    };
    writeRun(directory, run);
    const entry = {canceled: false, controller: new AbortController()};
    active.set(folder, entry);
    // Deliberately not awaited: the caller gets the record and the client polls for progress.
    execute({folder, directory, board, run, deps, entry}).catch(() => {}).finally(() => active.delete(folder));
    return run;
  }

  function cancel(folder) {
    const entry = active.get(folder);
    if (!entry) return false;
    entry.canceled = true;
    entry.controller.abort();
    return true;
  }

  function finish(directory, run, status, reason) {
    run.steps = run.steps.map(step => step.status === 'running'
      ? Object.assign({}, step, {status: status === 'canceled' ? 'skipped' : 'failed', detail: step.detail || reason, finished_at: new Date().toISOString()})
      : step);
    return patch(directory, run, {status, stop_reason: reason, finished_at: new Date().toISOString(), last_scene: null, last_progress: null});
  }

  async function execute({folder, directory, board, run, deps, entry}) {
    const stopped = () => entry.canceled;
    try {
      // ---- 1. generate ----------------------------------------------------------------
      const wanted = generatableScenes(board);
      run.generated.total = wanted.length;
      if (stopped()) return finish(directory, run, 'canceled', 'Cancelled before anything was generated.');

      if (!wanted.length) {
        patchStep(directory, run, 'generate', {status: 'skipped', detail: 'No scene needs generating: every scene has own media, a local template, or no prompt.', finished_at: new Date().toISOString()});
      } else if (!deps.comfyReady()) {
        const reason = deps.comfyUnavailableReason();
        run.generated.skipped = wanted.map(scene => ({scene_id: scene.id, reason}));
        patchStep(directory, run, 'generate', {status: 'skipped', detail: reason, finished_at: new Date().toISOString()});
      } else {
        patchStep(directory, run, 'generate', {status: 'running', started_at: new Date().toISOString()});
        for (const scene of wanted) {
          if (stopped()) return finish(directory, run, 'canceled', 'Cancelled during generation. Scenes already generated are attached.');
          patch(directory, run, {last_scene: scene.id});
          try {
            const outcome = await deps.generateScene({
              sceneId: scene.id,
              prompt: scene.generation_prompt,
              signal: entry.controller.signal,
              onProgress: current => patch(directory, run, {last_progress: (current && current.progress) ? current.progress : null})
            });
            run.generated.succeeded.push({scene_id: scene.id, asset_id: (outcome && outcome.asset_id) || null});
          } catch (error) {
            if (error && error.canceled) return finish(directory, run, 'canceled', 'Cancelled during generation. Scenes already generated are attached.');
            run.generated.failed.push({scene_id: scene.id, reason: error.message});
          }
          writeRun(directory, run);
        }
        const failed = run.generated.failed.length;
        patchStep(directory, run, 'generate', {
          status: failed ? 'failed' : 'succeeded',
          detail: run.generated.succeeded.length + ' generated, ' + failed + ' failed.',
          finished_at: new Date().toISOString()
        });
        if (failed) {
          /* Stopping is the honest default: composing now would draw placeholder cards for the failed
             scenes and produce a video QC must block, wasting a render. A re-run only retries what
             failed, because attached scenes are skipped. */
          return finish(directory, run, 'stopped',
            failed + ' scene(s) could not be generated: '
            + run.generated.failed.slice(0, 3).map(item => item.scene_id + ' (' + item.reason + ')').join('; ')
            + (failed > 3 ? ' and ' + (failed - 3) + ' more' : '')
            + '. Scenes already generated are attached, so starting again retries only these.');
        }
      }

      if (run.stop_after === 'generate') {
        return finish(directory, run, 'succeeded', 'Stopped after generating media, as asked. Review the images and clips, then run again to reach the final check.');
      }
      if (stopped()) return finish(directory, run, 'canceled', 'Cancelled before the assets stage.');

      // ---- 2. assets -----------------------------------------------------------------
      patchStep(directory, run, 'assets', {status: 'running', started_at: new Date().toISOString()});
      await deps.runAssets();
      const manifest = readJsonIfPresent(path.join(directory, 'generated/asset_manifest.json'));
      const stillMissing = ((manifest && manifest.counts) || {}).still_missing || 0;
      patchStep(directory, run, 'assets', {
        status: stillMissing ? 'failed' : 'succeeded',
        detail: stillMissing ? stillMissing + ' scene(s) still have no media.' : 'Every scene has media.',
        finished_at: new Date().toISOString()
      });
      if (stillMissing) {
        const names = (((manifest || {}).scenes) || [])
          .filter(scene => !['own_media', 'produced', 'rendered'].includes(scene.status))
          .map(scene => scene.scene_id);
        return finish(directory, run, 'stopped',
          stillMissing + ' scene(s) still have no media, so the render was not started: ' + names.slice(0, 5).join(', ')
          + '. Generate or attach something for each, then run again.');
      }
      if (stopped()) return finish(directory, run, 'canceled', 'Cancelled before the composer.');

      // ---- 3. compose ----------------------------------------------------------------
      patchStep(directory, run, 'compose', {status: 'running', started_at: new Date().toISOString()});
      await deps.runCompose();
      const qc = readJsonIfPresent(path.join(directory, 'qc/qc_report.json'));
      const blocking = ((qc || {}).blocking_issues) || [];
      patchStep(directory, run, 'compose', {
        status: 'succeeded',
        detail: blocking.length ? 'The master was written, and QC found ' + blocking.length + ' blocking issue(s).' : 'The master was written and QC passed.',
        finished_at: new Date().toISOString()
      });

      // ---- 4. final check ------------------------------------------------------------
      // Run even when QC blocked: the final check is where those issues are consolidated and read.
      patchStep(directory, run, 'final', {status: 'running', started_at: new Date().toISOString()});
      await deps.runFinal();
      patchStep(directory, run, 'final', {
        status: 'succeeded',
        detail: blocking.length ? 'Reported, with the QC issues to resolve before approval.' : 'Ready for you to watch and approve.',
        finished_at: new Date().toISOString()
      });
      return finish(directory, run, 'succeeded', blocking.length
        ? 'The video was rendered and the final check run. QC found ' + blocking.length + ' blocking issue(s), so it cannot be approved until those are fixed.'
        : 'The video was rendered and the final check run. Watch it, then approve it.');
    } catch (error) {
      if (error && error.canceled) return finish(directory, run, 'canceled', 'Cancelled.');
      const failedStep = run.steps.find(step => step.status === 'running');
      if (failedStep) patchStep(directory, run, failedStep.id, {status: 'failed', detail: error.message, finished_at: new Date().toISOString()});
      return finish(directory, run, 'failed', error.message);
    }
  }

  return {start, status, cancel, isRunning, activeCount: () => active.size};
}

module.exports = {
  RUN_FILE, STEP_IDS, STEP_LABELS, createPipelineRunner,
  runPath, readRun, writeRun, preflight, scenesNeedingMedia, generatableScenes
};
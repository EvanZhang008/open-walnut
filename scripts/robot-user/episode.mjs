#!/usr/bin/env node
/**
 * Robot-user episode runner.
 *
 * Loop until --minutes elapsed (or --steps reached):
 *   1. inspect hierarchy -> run every oracle -> journal
 *   2. brain picks an action -> run it -> journal
 *   3. screenshot every 5 steps and on every anomaly
 *
 * Everything lands in /tmp/walnut-robot/<epoch>-seed<seed>/:
 *   journal.jsonl, screenshots/, summary.json, replay.yaml (the free repro flow).
 *
 * Exit code: 0 = clean, 2 = anomalies found, 1 = harness error.
 *
 * --dry-run stubs the driver entirely (no simctl, no maestro, no simulator): it proves the
 * action sequence is deterministic for a seed and exercises the oracles against fixture
 * hierarchies. Use it as the unit test for this harness.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ACTIONS, mulberry32 } from './actions.mjs';
import { createDriver, APP_ID, parseHierarchyCsv } from './maestro-driver.mjs';
import { createOracles } from './oracles.mjs';
import { judge, pickAction, pickActionAI } from './brain.mjs';

const JOURNAL_ROOT = '/tmp/walnut-robot';
const SCREENSHOT_EVERY = 5;
const JUDGE_EVERY = 10;

// ─── args ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    device: '', deviceName: '', minutes: 30, seed: 42, driver: 'hybrid',
    server: 'http://localhost:3456', steps: 0, dryRun: false, judge: true,
    extraDeviceNames: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--device' || a === '-d') out.device = next();
    else if (a === '--device-name') out.deviceName = next();
    // A device may upload telemetry under a second name (the name the build was paired with).
    else if (a === '--also-device-name') out.extraDeviceNames.push(next());
    else if (a === '--minutes') out.minutes = Number(next());
    else if (a === '--seed') out.seed = Number(next());
    else if (a === '--driver') out.driver = next();
    else if (a === '--server') out.server = next();
    else if (a === '--steps') out.steps = Number(next());
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-judge') out.judge = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = `Usage: node episode.mjs --device <udid> [--minutes 30] [--seed 42]
                       [--driver hybrid|ai] [--server http://localhost:3456]
                       [--device-name "iPhone 16 Pro"] [--also-device-name sim-stress2]
                       [--steps N] [--no-judge]
       node episode.mjs --dry-run [--seed 1] [--steps 20]`;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve the simulator's display name (used to find its uploaded client log). */
function resolveDeviceName(udid) {
  const res = spawnSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8', timeout: 30_000 });
  if (res.status !== 0) return '';
  try {
    const j = JSON.parse(res.stdout);
    for (const list of Object.values(j.devices || {})) {
      for (const d of list) if (String(d.udid).toLowerCase() === String(udid).toLowerCase()) return d.name;
    }
  } catch { /* ignore */ }
  return '';
}

// ─── dry-run fixtures ────────────────────────────────────────────────────────
// Real CSV shape, captured from inspect-view-hierarchy on this app.

const FIXTURE_CSV = {
  chatWithRows: [
    'element_num,depth,bounds,attributes,parent_num',
    '1,1,"[0,0][402,874]","accessibilityText=Walnut; enabled=true",0',
    '15,15,"[20,66][56,102]","accessibilityText=Clock; resource-id=chat.history; enabled=true",1',
    '35,21,"[16,120][354,160]","accessibilityText=Got all 5 images in the burst. All received fine.; enabled=true",1',
    '38,21,"[43,170][370,200]","accessibilityText=I am recognizing this as a test message with minimal content; enabled=true",1',
    '39,21,"[16,210][335,250]","accessibilityText=Got it — received the blue image.; enabled=true",1',
    '40,21,"[16,260][335,300]","accessibilityText=Here is a short summary of today.; enabled=true",1',
    '41,21,"[16,310][335,350]","accessibilityText=Anything else you want to capture?; enabled=true",1',
    '90,22,"[16,780][60,820]","resource-id=chat.photo; enabled=true",1',
    '91,22,"[70,780][300,820]","resource-id=chat.composer; enabled=true",1',
    '92,22,"[310,780][350,820]","resource-id=chat.mic; enabled=true",1',
    '93,22,"[356,780][396,820]","resource-id=chat.send; enabled=true",1',
  ].join('\n'),

  // Same chat screen, but the timeline rendered nothing — the blank-screen bug class.
  chatBlank: [
    'element_num,depth,bounds,attributes,parent_num',
    '1,1,"[0,0][402,874]","accessibilityText=Walnut; enabled=true",0',
    '90,22,"[16,780][60,820]","resource-id=chat.photo; enabled=true",1',
    '91,22,"[70,780][300,820]","resource-id=chat.composer; enabled=true",1',
    '93,22,"[356,780][396,820]","resource-id=chat.send; enabled=true",1',
  ].join('\n'),

  // The system photo picker sheet: no app ids at all, just a grid of cells.
  photoPicker: [
    'element_num,depth,bounds,attributes,parent_num',
    '1,1,"[0,0][402,874]","accessibilityText=Photos; enabled=true",0',
    '5,4,"[340,120][390,150]","accessibilityText=Done; enabled=true",1',
    '10,6,"[8,220][130,340]","accessibilityText=Photo, October 12; enabled=true",1',
    '11,6,"[136,220][262,340]","accessibilityText=Photo, October 13; enabled=true",1',
    '12,6,"[268,220][394,340]","accessibilityText=Photo, October 14; enabled=true",1',
  ].join('\n'),

  tasksList: [
    'element_num,depth,bounds,attributes,parent_num',
    '1,1,"[0,0][402,874]","accessibilityText=Tasks; enabled=true",0',
    '20,10,"[16,140][386,200]","accessibilityText=session: refactor the parser; enabled=true",1',
    '21,10,"[16,210][386,270]","accessibilityText=session: fix the flaky test; enabled=true",1',
    '22,10,"[16,280][386,340]","accessibilityText=session: write release notes; enabled=true",1',
    '23,10,"[16,350][386,410]","accessibilityText=session: review the diff; enabled=true",1',
  ].join('\n'),

  notesList: [
    'element_num,depth,bounds,attributes,parent_num',
    '1,1,"[0,0][402,874]","accessibilityText=Notes; enabled=true",0',
    '30,10,"[16,140][386,190]","accessibilityText=Weekly plan; enabled=true",1',
    '31,10,"[16,200][386,250]","accessibilityText=Reading list; enabled=true",1',
    '32,10,"[16,260][386,310]","accessibilityText=Groceries; enabled=true",1',
    '33,10,"[16,320][386,370]","accessibilityText=Ideas parking lot; enabled=true",1',
  ].join('\n'),

  // Client believes it is offline while the server is healthy.
  chatOfflineBanner: [
    'element_num,depth,bounds,attributes,parent_num',
    '1,1,"[0,0][402,874]","accessibilityText=Walnut; enabled=true",0',
    '10,5,"[0,110][402,140]","accessibilityText=devbox unreachable — read-only; enabled=true",1',
    '35,21,"[16,160][354,200]","accessibilityText=Last synced transcript line one.; enabled=true",1',
    '36,21,"[16,210][354,250]","accessibilityText=Last synced transcript line two.; enabled=true",1',
    '91,22,"[70,780][300,820]","resource-id=chat.composer; enabled=true",1',
    '93,22,"[356,780][396,820]","resource-id=chat.send; enabled=true",1',
  ].join('\n'),

  // A pending bubble that never resolves.
  chatPending: [
    'element_num,depth,bounds,attributes,parent_num',
    '1,1,"[0,0][402,874]","accessibilityText=Walnut; enabled=true",0',
    '35,21,"[16,160][354,200]","accessibilityText=Waiting for reply…; enabled=true",1',
    '91,22,"[70,780][300,820]","resource-id=chat.composer; enabled=true",1',
    '93,22,"[356,780][396,820]","resource-id=chat.send; enabled=true",1',
  ].join('\n'),
};

const FIXTURES = Object.fromEntries(
  Object.entries(FIXTURE_CSV).map(([k, csv]) => [k, parseHierarchyCsv(csv)]),
);

/** Stub driver: same surface as the maestro driver, zero side effects on a device. */
function createStubDriver({ onFlow, sequence }) {
  let call = 0;
  const okr = (extra = {}) => ({ ok: true, ms: 5, ...extra });
  const flow = (body) => { if (onFlow) onFlow(`appId: ${APP_ID}\n---\n${body}`); return okr({ yaml: body }); };
  const d = {
    kind: 'stub',
    deviceId: 'STUB-DEVICE',
    appId: APP_ID,
    lastHierarchyMs: 5,
    inspectHierarchy() {
      const name = sequence[call++ % sequence.length];
      return { ok: true, ms: 5, rows: FIXTURES[name], fixture: name };
    },
    runFlow: (_dev, body) => flow(body),
    tapId: (id) => flow(`- tapOn:\n    id: ${JSON.stringify(id)}\n`),
    tapPoint: (x, y) => flow(`- tapOn:\n    point: ${Math.round(x)}%, ${Math.round(y)}%\n`),
    inputText: (t) => flow(`- inputText: ${JSON.stringify(t)}\n`),
    swipe: ({ fromX, fromY, toX, toY, durationMs = 400 }) => flow(`- swipe:\n    start: ${Math.round(fromX)}%, ${Math.round(fromY)}%\n    end: ${Math.round(toX)}%, ${Math.round(toY)}%\n    duration: ${Math.round(durationMs)}\n`),
    back: () => flow('- back\n'),
    terminate: () => okr(),
    launch: () => okr(),
    screenshot: (_dev, p) => {
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'stub-screenshot'); } catch { /* ignore */ }
      return okr({ path: p });
    },
  };
  return d;
}

// ─── the runner ──────────────────────────────────────────────────────────────

/**
 * @param {object} opts parsed args, plus { journal?: boolean } for shadow runs
 * @returns {Promise<{ exitCode:number, sequence:string[], anomalies:object[], journalDir:string|null, steps:number }>}
 */
export async function runEpisode(opts) {
  const {
    device, deviceName, minutes, seed, driver: driverKind, server,
    steps: maxSteps, dryRun, judge: judgeEnabled, journal = true,
  } = opts;

  const startedAt = Date.now();
  const prng = mulberry32(seed);
  const sleep = dryRun ? async () => {} : sleepReal;

  const journalDir = journal ? path.join(JOURNAL_ROOT, `${startedAt}-seed${seed}`) : null;
  const shotsDir = journalDir ? path.join(journalDir, 'screenshots') : null;
  if (journalDir) {
    fs.mkdirSync(shotsDir, { recursive: true });
  }
  const journalPath = journalDir ? path.join(journalDir, 'journal.jsonl') : null;
  const write = (rec) => {
    if (!journalPath) return;
    try { fs.appendFileSync(journalPath, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch { /* ignore */ }
  };

  // replay.yaml = every flow we actually executed, concatenated under one appId header.
  const replayBodies = [];
  const onFlow = (yaml) => { replayBodies.push(yaml.replace(/^appId:[^\n]*\n---\n/, '')); };

  const drv = dryRun
    ? createStubDriver({
      onFlow,
      // A deterministic screen rotation that also parks the robot on a blank chat.
      sequence: ['chatWithRows', 'chatWithRows', 'chatBlank', 'chatWithRows', 'tasksList', 'notesList', 'chatPending', 'chatWithRows'],
    })
    : createDriver({ deviceId: device, appId: APP_ID, onFlow });

  const oracleDirs = dryRun
    ? { logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'robot-logs-')), reportsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'robot-reports-')) }
    : {};
  const oracles = createOracles({
    deviceName: deviceName || device,
    // One simulator uploads telemetry under several names (its simctl display name and the
    // name the build was paired with), so hand the oracle every alias we can derive.
    extraDeviceNames: [opts.extraDeviceNames, device].flat().filter(Boolean),
    serverUrl: server,
    startedAt,
    ...oracleDirs,
    ...(dryRun ? { fetchImpl: async () => ({ status: 200 }) } : {}),
  });

  const state = { tab: 'Chat', step: 0 };
  const anomalies = [];
  const sequence = [];
  const deadline = startedAt + Math.max(0, minutes) * 60_000;

  let stopRequested = false;
  const onSignal = () => { stopRequested = true; };
  if (journal) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }

  let lastAction = null;
  let step = 0;

  write({ event: 'episode:start', seed, device: dryRun ? 'STUB-DEVICE' : device, deviceName, driver: driverKind, minutes, dryRun });

  // ── calibrate the responsiveness oracle to THIS rig ──
  // The maestro CLI costs seconds per read (runner spawn + MCP roundtrip) before the app is
  // even consulted, and that cost varies by machine and load. Measure the idle floor first so
  // "slow" means slow relative to this rig, not slower than a hardcoded guess.
  const baselineSamples = [];
  for (let i = 0; i < 3; i++) {
    const probe = await drv.inspectHierarchy();
    baselineSamples.push(probe.ms);
    // Prime the log offsets during the idle window too, so pre-existing telemetry is excluded
    // before the first action can be blamed for it.
    if (i === 0) oracles.primeLogOffsets();
    await sleep(300);
  }
  const sorted = [...baselineSamples].sort((a, b) => a - b);
  const baselineMs = sorted[Math.floor(sorted.length / 2)];
  oracles.setBaseline(baselineMs);
  const responsivenessThreshold = oracles.responsivenessThreshold();
  write({ event: 'baseline', samples: baselineSamples, baselineMs, responsivenessThreshold });

  while (!stopRequested) {
    if (maxSteps > 0 && step >= maxSteps) break;
    if (maxSteps <= 0 && Date.now() >= deadline) break;
    step += 1;
    state.step = step;

    // 1. observe + oracles
    const h = await drv.inspectHierarchy();
    const rows = h.rows || [];
    write({ event: 'observe', step, ok: h.ok, ms: h.ms, rows: rows.length, fixture: h.fixture, error: h.error });

    const results = await oracles.runAll({ rows, hierarchyMs: h.ms, lastAction, state });
    for (const r of results) {
      write({ event: 'oracle', step, name: r.name, ok: r.ok, detail: r.detail });
      if (!r.ok) {
        const anomaly = { step, oracle: r.name, detail: r.detail, ts: new Date().toISOString() };
        // Capture evidence for the anomaly: screenshot + raw hierarchy.
        if (shotsDir) {
          const shot = path.join(shotsDir, `step${String(step).padStart(4, '0')}-${r.name}.png`);
          const s = drv.screenshot(drv.deviceId, shot);
          if (s.ok) anomaly.screenshot = shot;
          try {
            fs.writeFileSync(path.join(shotsDir, `step${String(step).padStart(4, '0')}-${r.name}.hierarchy.json`), JSON.stringify(rows, null, 2));
          } catch { /* ignore */ }
          if (!dryRun && judgeEnabled && anomaly.screenshot) {
            const v = judge(anomaly.screenshot);
            anomaly.judge = v;
            write({ event: 'judge', step, trigger: `oracle:${r.name}`, ...v });
          }
        }
        anomalies.push(anomaly);
        write({ event: 'anomaly', ...anomaly });
      }
    }

    // 2. decide + act
    const decision = driverKind === 'ai' && !dryRun
      ? pickActionAI(prng, rows, state)
      : { action: pickAction(prng, rows, state), source: 'hybrid' };
    const action = decision.action;
    sequence.push(action.name);

    const t0 = Date.now();
    let outcome;
    try {
      outcome = await action.run(drv, { prng, state, sleep, driver: drv });
    } catch (e) {
      outcome = { error: String(e && e.message).slice(0, 300) };
    }
    const ms = Date.now() - t0;
    const substeps = (outcome && outcome.steps) || [];
    const failed = substeps.filter((s) => s && s.ok === false);
    lastAction = failed.length > 0 ? failed[failed.length - 1] : { ok: !outcome || !outcome.error };
    write({
      event: 'action', step, action: action.name, source: decision.source, ok: failed.length === 0 && !(outcome && outcome.error),
      ms, skipped: outcome && outcome.skipped, detail: outcome && outcome.detail,
      failures: failed.map((f) => String(f.error || '').slice(0, 200)),
      fallbackReason: decision.reason,
    });

    // 3. periodic evidence
    if (shotsDir && step % SCREENSHOT_EVERY === 0) {
      const shot = path.join(shotsDir, `step${String(step).padStart(4, '0')}.png`);
      const s = drv.screenshot(drv.deviceId, shot);
      write({ event: 'screenshot', step, ok: s.ok, path: s.ok ? shot : null, error: s.error });
      if (!dryRun && judgeEnabled && s.ok && step % JUDGE_EVERY === 0) {
        const v = judge(shot);
        write({ event: 'judge', step, trigger: 'periodic', ...v });
        if (v.broken) {
          const anomaly = { step, oracle: 'visualJudge', detail: { reason: v.reason }, screenshot: shot, ts: new Date().toISOString() };
          anomalies.push(anomaly);
          write({ event: 'anomaly', ...anomaly });
        }
      }
    }
  }

  if (journal) { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }

  const summary = {
    steps: step,
    anomalies,
    durationMs: Date.now() - startedAt,
    seed,
    device: dryRun ? 'STUB-DEVICE' : device,
    deviceName: deviceName || null,
    // Calibration for the responsiveness oracle — without it, a slow-CLI rig looks like a
    // frozen app. Keep it in the summary so a verdict can always be re-read in context.
    baseline: { samples: baselineSamples, baselineMs, responsivenessThreshold },
    logFilesWatched: oracles.candidateLogPaths(),
    driver: driverKind,
    dryRun: !!dryRun,
    stoppedBySignal: stopRequested,
    actionCounts: sequence.reduce((m, n) => ({ ...m, [n]: (m[n] || 0) + 1 }), {}),
  };
  if (journalDir) {
    fs.writeFileSync(path.join(journalDir, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(
      path.join(journalDir, 'replay.yaml'),
      `# Robot user replay — seed ${seed}, ${step} steps. Run with:\n` +
      `#   maestro (mcp-as-cli) run-flow-files, or: maestro test replay.yaml\n` +
      `appId: ${APP_ID}\n---\n${replayBodies.join('')}`,
    );
    write({ event: 'episode:end', steps: step, anomalies: anomalies.length });
  }

  return { exitCode: anomalies.length > 0 ? 2 : 0, sequence, anomalies, journalDir, steps: step, summary };
}

// ─── dry-run self-check ──────────────────────────────────────────────────────

async function dryRunSelfCheck(args) {
  const failures = [];
  const say = (s) => process.stdout.write(s + '\n');

  say('== robot-user dry run (stubbed driver, no simulator) ==');

  const a = await runEpisode({ ...args, dryRun: true, journal: true });
  say(`run A: ${a.steps} steps, ${a.anomalies.length} anomalies, journal ${a.journalDir}`);
  say(`  sequence: ${a.sequence.join(' ')}`);

  // 1. determinism for a seed (shadow run, no journal)
  const b = await runEpisode({ ...args, dryRun: true, journal: false });
  const deterministic = a.sequence.join(',') === b.sequence.join(',');
  say(`determinism for seed ${args.seed}: ${deterministic ? 'PASS' : 'FAIL'}`);
  if (!deterministic) failures.push('action sequence not deterministic for a fixed seed');

  // A different seed must produce a different walk, otherwise the seed does nothing.
  const c = await runEpisode({ ...args, seed: args.seed + 1, dryRun: true, journal: false });
  const seedMatters = c.sequence.join(',') !== a.sequence.join(',');
  say(`seed sensitivity: ${seedMatters ? 'PASS' : 'FAIL'} (seed ${args.seed + 1} -> ${c.sequence.slice(0, 6).join(' ')} ...)`);
  if (!seedMatters) failures.push('different seeds produce the same sequence');

  // 2. every action must be reachable in a random walk AND runnable against the stub.
  const covered = new Set([...a.sequence, ...b.sequence, ...c.sequence]);
  const uncovered = ACTIONS.map((x) => x.name).filter((n) => !covered.has(n));
  say(`action coverage (random walks): ${covered.size}/${ACTIONS.length}${uncovered.length ? ` (low-weight, not sampled: ${uncovered.join(', ')})` : ''}`);

  {
    // Direct exercise so every run() body is executed at least once, low weight or not.
    // Each action sees the fixture sequence its happy path needs.
    const perAction = {
      attachPhotoAndSend: ['photoPicker'],
      openSessionAndRead: ['tasksList'],
      notesEdit: ['notesList'],
    };
    const exPrng = mulberry32(7);
    for (const act of ACTIONS) {
      const exerciseDriver = createStubDriver({ sequence: perAction[act.name] || ['chatWithRows'] });
      let res;
      try {
        res = await act.run(exerciseDriver, { prng: exPrng, state: { tab: 'Chat', step: 0 }, sleep: async () => {}, driver: exerciseDriver });
      } catch (e) {
        failures.push(`action ${act.name} threw: ${e && e.message}`);
        say(`  FAIL action run ${act.name} threw: ${e && e.message}`);
        continue;
      }
      const bodyOk = res && (Array.isArray(res.steps) || typeof res.skipped === 'string');
      say(`  ${bodyOk ? 'PASS' : 'FAIL'} action run ${act.name}${res && res.skipped ? ` (skipped: ${res.skipped})` : ''}`);
      if (!bodyOk) failures.push(`action ${act.name} returned an unexpected shape`);
    }
  }

  // 3. oracles against fixtures — each case states the expected verdict
  const tmpLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-fixlogs-'));
  const tmpReports = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-fixreports-'));
  const mk = () => createOracles({
    deviceName: 'Robot Fixture Device', startedAt: Date.now() - 1000,
    logDir: tmpLogs, reportsDir: tmpReports, fetchImpl: async () => ({ status: 200 }),
  });

  const cases = [];

  // blankTimeline: must NOT flag a healthy chat, MUST flag the blank one after rows were seen.
  {
    const o = mk();
    const healthy = o.blankTimeline(FIXTURES.chatWithRows, { tab: 'Chat' });
    const blank = o.blankTimeline(FIXTURES.chatBlank, { tab: 'Chat' });
    cases.push({ name: 'blankTimeline/healthy-chat', flagged: !healthy.ok, expect: false, detail: healthy.detail });
    cases.push({ name: 'blankTimeline/blank-after-rows', flagged: !blank.ok, expect: true, detail: blank.detail });
    // A blank chat we have never seen populated is NOT an anomaly (fresh install / empty convo).
    const fresh = mk().blankTimeline(FIXTURES.chatBlank, { tab: 'Chat' });
    cases.push({ name: 'blankTimeline/blank-never-populated', flagged: !fresh.ok, expect: false, detail: fresh.detail });
  }

  // offlineWhileHealthy: banner + server 200 must flag.
  {
    const o = mk();
    const r = await o.offlineWhileHealthy(FIXTURES.chatOfflineBanner);
    cases.push({ name: 'offlineWhileHealthy/banner-vs-200', flagged: !r.ok, expect: true, detail: r.detail });
    const r2 = await mk().offlineWhileHealthy(FIXTURES.chatWithRows);
    cases.push({ name: 'offlineWhileHealthy/no-banner', flagged: !r2.ok, expect: false, detail: r2.detail });
  }

  // stuckPending: 6 checks are tolerated, the 7th flags.
  {
    const o = mk();
    let last;
    for (let i = 0; i < 7; i++) last = o.stuckPending(FIXTURES.chatPending);
    cases.push({ name: 'stuckPending/7-consecutive', flagged: !last.ok, expect: true, detail: last.detail });
    const o2 = mk();
    o2.stuckPending(FIXTURES.chatPending);
    const cleared = o2.stuckPending(FIXTURES.chatWithRows);
    cases.push({ name: 'stuckPending/clears', flagged: !cleared.ok, expect: false, detail: cleared.detail });
  }

  // responsiveness: slow hierarchy, and two consecutive timeouts.
  {
    const o = mk();
    const slow = o.responsiveness(4200, { ok: true });
    cases.push({ name: 'responsiveness/slow-hierarchy-uncalibrated', flagged: !slow.ok, expect: true, detail: slow.detail });
    const o2 = mk();
    o2.responsiveness(100, { ok: false, error: 'run-flow: timed out' });
    const twice = o2.responsiveness(100, { ok: false, error: 'run-flow: timed out' });
    cases.push({ name: 'responsiveness/two-timeouts', flagged: !twice.ok, expect: true, detail: twice.detail });
  }

  // responsiveness CALIBRATION — regression guard for pilot 1, where a fixed 3000ms flagged
  // 17/17 steps on a rig whose maestro CLI floor was ~3.4s and the app was healthy throughout.
  {
    const o = mk();
    o.setBaseline(3500);                       // this rig's measured idle floor
    say(`  (calibrated threshold for baseline 3500ms = ${o.responsivenessThreshold()}ms)`);
    // Real pilot-1 observations that must now be quiet: the steady-state 3.3-4.2s reads.
    for (const ms of [3352, 3800, 4194, 4250, 8000]) {
      const r = o.responsiveness(ms, { ok: true });
      cases.push({ name: `responsiveness/calibrated-quiet-${ms}ms`, flagged: !r.ok, expect: false, detail: r.detail });
    }
    // A genuinely anomalous read (well past 2.5x the floor) must still flag.
    for (const ms of [9000, 20719]) {
      const r = o.responsiveness(ms, { ok: true });
      cases.push({ name: `responsiveness/calibrated-flags-${ms}ms`, flagged: !r.ok, expect: true, detail: r.detail });
    }
    // A fast rig must not get a threshold below the 3000ms floor.
    const fast = mk();
    fast.setBaseline(200);
    const fastThresholdOk = fast.responsivenessThreshold() === 3000;
    cases.push({ name: 'responsiveness/floor-never-below-3000', flagged: !fastThresholdOk, expect: false, detail: { threshold: fast.responsivenessThreshold() } });
  }

  // freezeTelemetry: only NEW lines count, so prime first, then append a freeze line.
  {
    const o = mk();
    const day = new Date();
    const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const logFile = path.join(tmpLogs, `Robot-Fixture-Device-${stamp}.log`);
    fs.writeFileSync(logFile, JSON.stringify({ subsystem: 'sse', message: 'old line', ts: '2026-01-01T00:00:00Z' }) + '\n');
    const before = o.freezeTelemetry();
    cases.push({ name: 'freezeTelemetry/primed-quiet', flagged: !before.ok, expect: false, detail: before.detail });
    fs.appendFileSync(logFile, JSON.stringify({ subsystem: 'freeze', level: 'error', message: 'main thread unresponsive', m_stalledSeconds: '6.0', ts: new Date().toISOString() }) + '\n');
    const after = o.freezeTelemetry();
    cases.push({ name: 'freezeTelemetry/new-freeze-line', flagged: !after.ok, expect: true, detail: after.detail });
  }

  // freezeTelemetry REGRESSION for pilot 1: the device logs under a UTC-dated filename while
  // the harness predicted a LOCAL-dated one, so the real file was never primed; when local
  // midnight rolled over it entered the candidate list at offset 0 and a 05:10Z freeze was
  // replayed as new by an episode that started at 06:48Z. Now the dir is globbed and any
  // newly-appearing file starts at EOF.
  {
    const utcLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-utclogs-'));
    const started = Date.now();
    const o = createOracles({
      deviceName: 'iPhone 16 Pro Stress2', extraDeviceNames: ['sim-stress2'],
      startedAt: started, logDir: utcLogs, reportsDir: tmpReports, fetchImpl: async () => ({ status: 200 }),
    });
    o.primeLogOffsets();   // step 0: the dir is empty, nothing to prime
    const stale = JSON.stringify({ device: 'iPhone 16 Pro Stress2', subsystem: 'freeze', level: 'error', message: 'main thread unresponsive', m_stalledSeconds: '6.0', ts: '2026-07-25T05:10:01Z' });
    // A file with a DIFFERENT (UTC) date than the one a local-date predictor would build,
    // appearing mid-run, already containing the whole day of history.
    const utcFile = path.join(utcLogs, 'iPhone-16-Pro-Stress2-2026-07-25.log');
    fs.writeFileSync(utcFile, stale + '\n');
    const midRun = o.freezeTelemetry();
    cases.push({ name: 'freezeTelemetry/late-appearing-file-not-replayed', flagged: !midRun.ok, expect: false, detail: midRun.detail });
    // The alias name must be watched too (same simulator, second upload name).
    const aliasFile = path.join(utcLogs, 'sim-stress2-2026-07-25.log');
    fs.writeFileSync(aliasFile, JSON.stringify({ subsystem: 'sse', message: 'hello', ts: new Date().toISOString() }) + '\n');
    o.freezeTelemetry();   // discovers + primes the alias file
    const watched = o.candidateLogPaths();
    const watchesBoth = watched.some((p) => p.includes('iPhone-16-Pro-Stress2-')) && watched.some((p) => p.includes('sim-stress2-'));
    cases.push({ name: 'freezeTelemetry/watches-both-device-names', flagged: !watchesBoth, expect: false, detail: { watched: watched.map((p) => path.basename(p)) } });
    // A genuinely new freeze appended to that same alias file must still be caught.
    fs.appendFileSync(aliasFile, JSON.stringify({ subsystem: 'freeze', level: 'error', message: 'main thread unresponsive', m_stalledSeconds: '8.2', ts: new Date().toISOString() }) + '\n');
    const live = o.freezeTelemetry();
    cases.push({ name: 'freezeTelemetry/real-freeze-still-caught', flagged: !live.ok, expect: true, detail: live.detail });
    // The ts filter is the independent second line of defence: the client can APPEND telemetry
    // for a stall it detected before this episode began (buffered upload / previous launch).
    // Such a line is genuinely new bytes, so offsets cannot reject it — only its ts can.
    fs.appendFileSync(aliasFile, JSON.stringify({ subsystem: 'freeze', level: 'error', message: 'main thread unresponsive', m_stalledSeconds: '6.0', ts: '2026-07-25T05:10:01Z' }) + '\n');
    const tsOnly = o.freezeTelemetry();
    const rejectedByTs = tsOnly.ok && tsOnly.detail && tsOnly.detail.staleSkipped === 1;
    cases.push({ name: 'freezeTelemetry/ts-filter-rejects-late-uploaded-stale', flagged: !rejectedByTs, expect: false, detail: tsOnly.detail });
  }

  // crashArtifacts: a fresh *Walnut* report must be picked up exactly once.
  {
    const o = mk();
    fs.writeFileSync(path.join(tmpReports, 'Walnut-fixture-crash.ips'), '{}');
    const first = o.crashArtifacts();
    const second = o.crashArtifacts();
    cases.push({ name: 'crashArtifacts/new-report', flagged: !first.ok, expect: true, detail: first.detail });
    cases.push({ name: 'crashArtifacts/not-double-reported', flagged: !second.ok, expect: false, detail: second.detail });
  }

  say('oracle fixture checks:');
  for (const c of cases) {
    const pass = c.flagged === c.expect;
    say(`  ${pass ? 'PASS' : 'FAIL'} ${c.name} -> flagged=${c.flagged} expected=${c.expect}${pass ? '' : ` detail=${JSON.stringify(c.detail)}`}`);
    if (!pass) failures.push(`oracle case ${c.name}: flagged=${c.flagged} expected=${c.expect}`);
  }

  // 4. journal artifacts exist and replay.yaml is a plausible flow
  const files = ['journal.jsonl', 'summary.json', 'replay.yaml'];
  for (const f of files) {
    const p = path.join(a.journalDir, f);
    const okFile = fs.existsSync(p) && fs.statSync(p).size > 0;
    say(`  ${okFile ? 'PASS' : 'FAIL'} artifact ${f}`);
    if (!okFile) failures.push(`missing/empty artifact ${f}`);
  }
  const replay = fs.readFileSync(path.join(a.journalDir, 'replay.yaml'), 'utf8');
  const replayOk = replay.includes(`appId: ${APP_ID}`) && /- (tapOn|inputText|swipe|back)/.test(replay);
  say(`  ${replayOk ? 'PASS' : 'FAIL'} replay.yaml contains a runnable flow (${replay.split('\n').length} lines)`);
  if (!replayOk) failures.push('replay.yaml does not look like a runnable flow');

  // The dry run walks onto the blank-chat fixture, so the live loop should have flagged it too.
  const loopFlaggedBlank = a.anomalies.some((x) => x.oracle === 'blankTimeline');
  say(`  ${loopFlaggedBlank ? 'PASS' : 'INFO'} live loop flagged blankTimeline: ${loopFlaggedBlank}`);

  say(failures.length === 0 ? '\nDRY RUN: ALL CHECKS PASSED' : `\nDRY RUN: ${failures.length} CHECK(S) FAILED`);
  for (const f of failures) say(`  - ${f}`);
  return failures.length === 0 ? 0 : 2;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); return 0; }

  if (args.dryRun) {
    if (!args.steps) args.steps = 20;
    return dryRunSelfCheck(args);
  }

  if (!args.device) { process.stderr.write('error: --device <udid> is required\n' + USAGE + '\n'); return 1; }
  if (!args.deviceName) args.deviceName = resolveDeviceName(args.device);

  const res = await runEpisode(args);
  process.stdout.write(`journal: ${res.journalDir}\n`);
  process.stdout.write(res.anomalies.length === 0
    ? `verdict: CLEAN (${res.steps} steps)\n`
    : `verdict: ${res.anomalies.length} anomalies in ${res.steps} steps\n`);
  for (const a of res.anomalies.slice(0, 20)) {
    process.stdout.write(`  step ${a.step} ${a.oracle}: ${JSON.stringify(a.detail).slice(0, 200)}\n`);
  }
  return res.exitCode;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`robot episode crashed: ${e && e.stack}\n`);
    process.exit(1);
  });
}

export { FIXTURES, parseArgs, createStubDriver };

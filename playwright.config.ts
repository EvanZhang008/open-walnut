import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { perRunWorkers } from './tests/e2e/browser/pw-concurrency.js'
import { engageGate } from './tests/e2e/browser/pw-gate.js'
// Every test browser is silent: an init script in every frame, and Chromium's own mute.
import { CHROMIUM_SILENT } from './tests/e2e/browser/pw-silence.js'
// Proof videos: recorded at the page's own size, with a pointer, encoded to MP4.
import { VIDEO_USE, withVideoReporter } from './tests/e2e/browser/pw-video.js'
// Linux WebKit paints on the CPU: its GL painting threads crash the page on software GL.
import './tests/e2e/browser/pw-webkit-paint.js'
import { sideConfigSpecs } from './tests/e2e/browser/side-config-specs.js'
import { HOST_FIXTURE_CALL, SIGN_IN_CALL, specsCalling } from './tests/e2e/browser/one-at-a-time-specs.js'
import { returningVisitorStorage } from './tests/e2e/browser/pw-storage.js'
import { bunCommand } from './tests/helpers/bun-runtime.js'

const testPort = Number(process.env.PW_TEST_PORT ?? 3457)

// Machine-wide admission control. MUST run here, at config load: Playwright boots
// the webServer plugin before globalSetup, so this is the only hook early enough
// to queue behind a concurrent run and to reap an orphaned fixture server before
// `reuseExistingServer` silently attaches to it. See tests/e2e/browser/pw-gate.ts.
engageGate(testPort)

// Specs that change something the fixture server has only one of race each other when
// two workers run them at once (tests/e2e/browser/one-at-a-time-specs.ts): the specs that
// swap its host fixture, and the specs that drive its tunnel or sign browsers in. Each
// group runs in a project of its own, one at a time, while every other spec stays parallel.
// Found by what they call, so a new one joins its group by itself.
const browserDir = path.join(import.meta.dirname, 'tests/e2e/browser')
const hostFixtureSpecs = specsCalling(browserDir, HOST_FIXTURE_CALL)
const signInSpecs = specsCalling(browserDir, SIGN_IN_CALL).filter((s) => !hostFixtureSpecs.includes(s))
// Specs with their own config and fixture (replica, cloud host, host alone, ...).
// Every project names them again: a project's testIgnore replaces the top-level one.
// A `*.local.spec.ts` is a person's own walk-through (a demo video, a one-off check) and stays
// out of git (.gitignore); a CI run never runs one, a file committed by mistake included
// (2026-11-13: zz-approval-demo.local.spec.ts, swept into a commit, ran its 240 s demo to a
// timeout on every CI run).
const localSpecs = process.env.CI ? ['**/*.local.spec.ts'] : []
const sideSpecs = [...sideConfigSpecs(browserDir), ...localSpecs]

export default defineConfig({
  testDir: 'tests/e2e/browser',
  // Their own fixture and config (tests/e2e/browser/side-config-specs.ts); the main
  // config runs replica-smoke.spec.ts for the replica path instead.
  testIgnore: sideSpecs,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // `undefined` here used to mean "half the cores" (7 on this Mac) — 28 chromium
  // processes and ~2.7 GB per run, with nothing coordinating concurrent runs.
  // Overrides: PW_WORKERS (per run), PW_NO_GATE=1 (skip the port lease).
  workers: perRunWorkers(),
  reporter: withVideoReporter('list'),
  // A CI runner has 4 cores and runs 4 workers: one cold load of the dev mode fixture
  // (about 1,700 module requests) took 12 to 14 s there, so a test that loads the app
  // twice ran out of 30 s with nothing wrong (2026-11-01: about 9 of 21 failures of one
  // shard). Assertions keep their own timeouts; this is only the test's ceiling.
  timeout: process.env.CI ? 60_000 : 30_000,
  // The assertions' own window scales the same way: on the runner a save round trip, a drop or
  // a reload takes several times as long as on the machines the specs were written on, and 30 of
  // the 74 failures only CI showed were a default 5 s assertion running out (2026-11-13, run
  // 43379795380). Explicit timeouts stay as they are.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },

  use: {
    baseURL: `http://localhost:${testPort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // PW_VIDEO=1 records every test (demo/verification clips) at the page's own size, and
    // the reporter writes video.mp4 beside each video.webm (pw-video.ts); pair with
    // `--output <dir>` outside test-results/, which peer runs wipe.
    video: VIDEO_USE,
    // The task panel opens Flat (web/src/components/tasks/panel-design.ts), its status
    // sections and no list. The specs written against the list remember By project, in
    // every page's storage, so a spec that serves its own ui-prefs keeps it too; a spec
    // about Flat presets it (status-section-helpers.ts presetPanelDesign).
    // A first visit folds the board; every page starts as a returning visitor (pw-storage.ts).
    storageState: returningVisitorStorage(`http://localhost:${testPort}`, [{ name: 'walnut-todo-panel-design', value: 'project' }]),
  },

  projects: [
    // Chromium mutes itself headless; `--mute-audio` keeps a headed run (--headed, a
    // debug session) silent too. WebKit has no such switch: pw-silence.ts silences
    // every frame of every context (2026-11-08).
    // The sign-in specs come first, so a sharded run starts their one-at-a-time chain at the
    // start of its first shard. Named `chromium` too: `--project=chromium` selects both
    // (Playwright matches projects by name and gives each its own worker limit).
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_SILENT } },
      testMatch: signInSpecs,
      testIgnore: [...sideSpecs, ...hostFixtureSpecs],
      workers: 1,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_SILENT } },
      testIgnore: [...sideSpecs, ...hostFixtureSpecs, ...signInSpecs],
    },
    {
      name: 'chromium-host-fixture',
      use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_SILENT } },
      testMatch: hostFixtureSpecs,
      testIgnore: sideSpecs,
      workers: 1,
    },
    // The desktop app is a WKWebView, so a desktop-only scroll/paint bug needs a
    // WebKit run to count as verified. Opt in: PW_WEBKIT=1 … --project webkit
    // The replica smoke is one chromium spec (its WebKit runs are replica.config.ts's).
    // The host fixture specs run one at a time there too, as on chromium-host-fixture
    // (2026-11-06: with 2 workers, BP-C58's fixture hosts reached BP-C49's page and
    // BP-C68's fixture was swapped under it, on every commit). Both projects are named
    // `webkit`, so `--project webkit` keeps selecting every WebKit spec (Playwright
    // matches projects by name and gives each its own id and worker limit).
    ...(process.env.PW_WEBKIT ? [
      { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: signInSpecs, testIgnore: [...sideSpecs, ...hostFixtureSpecs], workers: 1 },
      { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: [...sideSpecs, ...hostFixtureSpecs, ...signInSpecs, '**/replica-smoke.spec.ts'] },
      { name: 'webkit', use: { ...devices['Desktop Safari'] }, testMatch: hostFixtureSpecs, testIgnore: sideSpecs, workers: 1 },
    ] : []),
  ],

  webServer: {
    // The fixture server runs on bun (tests/helpers/bun-runtime.ts), which runs
    // its TypeScript as it is; only this runner stays on Node. Never `npx`: its
    // registry resolution alone once took 88s here, past the whole boot budget.
    command: `${bunCommand()} tests/e2e/browser/test-server.ts`,
    url: `http://localhost:${testPort}/api/dashboard`,
    reuseExistingServer: !process.env.CI,
    // Cold boot of the fixture (real server + vite + isolated daemon) measured at
    // ~20s on an idle Mac; under load it blew past the old 30s ceiling and the run
    // died with "Timed out waiting 30000ms from config.webServer" — which reads
    // like an app bug but is just a starved machine. 120s absorbs that.
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // Without this Playwright ends EVERY run with SIGKILL on the fixture's process
    // group (playwright-core processLauncher), so test-server.ts's SIGTERM handler
    // — the only thing that stops its isolated daemon and removes its tmpdir —
    // never ran, and each run left a `walnut-pw-<ts>` dir behind (401 of them on
    // 2026-09-13). SIGTERM first; SIGKILL still follows if the handler hangs.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
})

// A stand-in `walnut web` for tests/commands/web-restart.test.ts: it registers the real
// restart handler (src/commands/web-restart.ts) with a stub teardown, then asks a live
// updater holding an installed version to restart.
import fs from 'node:fs'
import { takeRestartSupervised } from '../../../src/core/self-update/restart-supervisor.js'

if (process.argv.includes('--version')) {
  process.stdout.write('9.9.9\n')
  process.exit(0)
}
const log = process.env.RESTART_HANDLER_LOG!
const note = (what: string, extra: Record<string, unknown> = {}) => fs.appendFileSync(log, `${JSON.stringify({ what, pid: process.pid, ...extra })}\n`)
const supervised = takeRestartSupervised()
note('start', { supervised, applied: process.env.WALNUT_UPDATE_APPLIED ?? null, leaked: process.env.WALNUT_RESTART_SUPERVISED ?? null })

const { registerLiveRestart } = await import('../../../src/commands/web-restart.js')
const { LiveUpdater } = await import('../../../src/core/self-update/live-update.js')
let tearing = false
await registerLiveRestart({
  supervised, bailMs: 5_000, exitTraceFile: () => `${log}.exit`,
  stopServer: async () => { note('teardown') },
  beginTeardown: () => { if (tearing) return false; tearing = true; return true },
})
const status = {
  enabled: false, install: { kind: 'source', sourceDir: null, packageRoot: null, manager: null, updateCommand: null },
  current: '0.0.1', channel: 'stable', latest: '9.9.9', tags: { latest: '9.9.9', nightly: null }, available: true,
  checkedAt: null, error: null, checking: false, packageUrl: '',
} as const
const updater = new LiveUpdater({
  now: Date.now, status: () => status as never, configAuto: async () => undefined, env: {},
  canSelfInstall: () => true, held: () => null, busy: async () => null, install: async () => ({ from: null }),
  markUnverified: () => {}, noteInstalled: () => {}, installedLater: () => '9.9.9', turnsRunning: async () => 0,
  onChange: () => {}, log: () => {}, restartDelayMs: 10,
})
await updater.start()
note('asked', updater.restartNow('asked'))
// Not supervised: no handler, so nothing restarts and this process goes on serving (here: ends).
if (!supervised) process.exit(0)
// The handler ends this process (exit 75, or as the loop's parent with the child's code).
setInterval(() => {}, 1_000)

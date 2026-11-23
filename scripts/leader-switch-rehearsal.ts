/**
 * The leader-switch rehearsal on one Linux dev box (docs/reference/leader-switch.md,
 * "Rehearsal"): real servers on synthetic homes, three local witnesses, the real
 * `walnut leader switch` command. Prints one line per check; exits 1 when one fails.
 *
 *   bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--stops] [--trials] [--flag-off (also: on with no witnesses)] [--restarts] [--paths] [--console [--as-installed] [--away-seconds N]] [--all] [--keep]
 *
 * Without a scenario flag it runs the main one: A leads, a standby copy to B, load through
 * A's API, the switch to B, every check, A started again by hand (online and offline), writes
 * on B, the switch back; then a home moved to another HOME prefix (`--paths` runs only that). `--gb N` puts N GB of filler in A's home first (the downtime of a
 * real-sized home; the first standby batch of 20 GB takes about 20 minutes). `--kills` kills
 * the command at each step and resumes it (`--no-back`: no switch back, for a large home on a full disk); `--trials` breaks the copy three ways.
 * `--stops` runs the switch stop's cases (leader-switch/stop-rehearsal.ts): a writer after the first final batch, a
 * signal and a kill during it, the old leader's own cancel when no stop comes, a launcher that restarts the home, `--status`.
 * `--console` runs the old leader's console after the switch (leader-switch/console-rehearsal.ts):
 * the Mac app's handling replayed the whole time, B cut off for `--away-seconds` (default 60),
 * A's home checked by its manifest classes; `--as-installed` keeps A's daemon state where an
 * installed one does (inside the home). It needs the built app (`bun run build`). Everything
 * stays inside <work dir>; nothing reads ~/.open-walnut or uses :3456.
 */
import fs from 'node:fs'
import path from 'node:path'
import { rehearseConsole } from './leader-switch/console-rehearsal.js'
import { rehearseLateWriter, rehearseLauncherRace, rehearseServerKilledInFinalBatch, rehearseSignalInFinalBatch, rehearseStopWait } from './leader-switch/stop-rehearsal.js'
import { KILL_POINTS, TRIAL_FAILURES, rehearseCancel, rehearseCancelAfterCommit, rehearseFlagOff, rehearseHomePrefix, rehearseNoWitnesses, rehearseRestart, rehearseLedgerControl, rehearseKill, rehearseSwitchAndBack, rehearseTrialFailure, type Check } from './leader-switch/rehearsal.js'

const args = process.argv.slice(2)
const root = args[0]
if (!root || root.startsWith('--')) {
  console.error('usage: bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--stops] [--trials] [--flag-off] [--restarts] [--paths] [--console] [--all] [--no-back] [--port-base N] [--keep]')
  process.exit(2)
}
const has = (f: string) => args.includes(f)
const gbAt = args.indexOf('--gb')
const gb = gbAt >= 0 ? Number(args[gbAt + 1]) : 0
const all = has('--all')
const work = path.resolve(root, new Date().toISOString().replace(/[:.]/g, '-'))
fs.mkdirSync(work, { recursive: true })

let failed = 0
const print = (c: Check) => {
  if (!c.ok) failed++
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
}
const log = (s: string) => { if (process.env.REHEARSAL_VERBOSE) console.log(s) }

const baseAt = args.indexOf('--port-base')
let port = baseAt >= 0 ? Number(args[baseAt + 1]) : 4800
const ports = () => { port += 2; return { portA: port, portB: port + 1 } }

const main = !has('--kills') && !has('--stops') && !has('--trials') && !has('--flag-off') && !has('--restarts') && !has('--paths') && !has('--console')
if (main || all) {
  await rehearseLedgerControl(path.join(work, 'ledger-control'), print, ports())
  const r = await rehearseSwitchAndBack(path.join(work, 'main'), print, { ...ports(), fillerGb: gb, noBack: has('--no-back'), log })
  console.log(`DOWNTIME  switch ${r.downtimeMs !== undefined ? (r.downtimeMs / 1000).toFixed(1) : '?'} s, back ${r.backDowntimeMs !== undefined ? (r.backDowntimeMs / 1000).toFixed(1) : '?'} s${gb ? ` (home with ${gb} GB filler)` : ''}`)
}
if (main || all || has('--paths')) await rehearseHomePrefix(path.join(work, 'home-prefix'), print, ports())
if (has('--kills') || all) {
  for (const p of KILL_POINTS) await rehearseKill(path.join(work, `kill-${p}`), p, print, ports())
  await rehearseCancel(path.join(work, 'cancel'), print, ports())
  await rehearseCancelAfterCommit(path.join(work, 'cancel-after-commit'), print, ports())
}
if (has('--stops') || all) {
  await rehearseLateWriter(path.join(work, 'late-writer'), print, ports())
  await rehearseSignalInFinalBatch(path.join(work, 'signal-in-final-batch'), print, ports())
  await rehearseServerKilledInFinalBatch(path.join(work, 'server-killed-in-final-batch'), print, ports())
  await rehearseStopWait(path.join(work, 'stop-wait'), print, ports())
  await rehearseLauncherRace(path.join(work, 'launcher-race'), print, ports())
}
if (has('--trials') || all) for (const k of TRIAL_FAILURES) await rehearseTrialFailure(path.join(work, `trial-${k}`), k, print, ports())
if (has('--restarts') || all) {
  const r = await rehearseRestart(path.join(work, 'restarts'), print, ports())
  console.log(`DOORS CLOSED  planned restart ${r.plannedMs !== undefined ? (r.plannedMs / 1000).toFixed(1) : '?'} s, crash ${r.crashMs !== undefined ? (r.crashMs / 1000).toFixed(1) : '?'} s`)
}
if (has('--console') || all) {
  const awayAt = args.indexOf('--away-seconds')
  const dir = path.join(work, has('--as-installed') ? 'console-as-installed' : 'console')
  await rehearseConsole(dir, print, { ...ports(), asInstalled: has('--as-installed'), awaySeconds: awayAt >= 0 ? Number(args[awayAt + 1]) : 60, log, ...(await consoleExtras(dir)) })
}
if (has('--flag-off') || all) {
  await rehearseFlagOff(path.join(work, 'flag-off'), print, ports())
  await rehearseNoWitnesses(path.join(work, 'no-witnesses'), print, ports())
}
// The standby copies and the promoted homes are read-only on purpose (src/core/standby/), so a
// plain `rm -rf` of the work dir fails and leaves gigabytes behind: make the tree writable again,
// and drop it when every check passed (--keep keeps it); a failed run keeps it as evidence.
makeWritable(work)
if (!failed && !has('--keep')) fs.rmSync(work, { recursive: true, force: true })
console.log(failed ? `${failed} check(s) FAILED; evidence in ${work} (writable, remove it with rm -rf)` : `all checks passed; ${has('--keep') ? `evidence in ${work}` : `work dir ${work} removed (--keep keeps it)`}`)
process.exit(failed ? 1 : 0)

/**
 * `--browser`: a person's browser on A's console the whole time (console-browser.ts), recorded;
 * `--scale`: A's home at a real density first, and the worst load of `/` and of a session page,
 * five times each at the console and at the leader (console-scale.ts).
 */
async function consoleExtras(dir: string): Promise<Partial<Parameters<typeof rehearseConsole>[2]>> {
  if (!has('--browser') && !has('--scale')) return {}
  const { ConsoleBrowser, makeWalkData } = await import('./leader-switch/console-browser.js')
  const { SCALE, measureLoads, seedLargeHome } = await import('./leader-switch/console-scale.js')
  let b: InstanceType<typeof ConsoleBrowser> | null = null
  let data: Awaited<ReturnType<typeof makeWalkData>> | null = null
  let kept: string | null = null
  return {
    ...(has('--scale') ? { seedHome: (home: string, env: Record<string, string>) => seedLargeHome(home, env, dir) } : {}),
    online: async (cw, c) => {
      data = await makeWalkData(cw)
      if (has('--scale')) {
        for (const r of await measureLoads(cw, { id: data.board.id, answer: 'echo: hello from the leader' }, path.join(dir, 'loads'))) {
          console.log(`LOAD  ${r.where}, ${r.page}: worst ${r.worst} ms of ${r.ms.join(', ')} (home: ${SCALE.tasks} tasks, ${SCALE.sessions} sessions, ${SCALE.notes} notes)`)
          c.add(`load at scale: ${r.where}, ${r.page}, ${r.ms.length} of 5 loads`, !r.error && r.ms.length === 5, r.error ?? `worst ${r.worst} ms`)
        }
      }
      if (!has('--browser')) return
      b = new ConsoleBrowser(cw, path.join(dir, 'browser'), data)
      await b.open()
      await b.checkOnLeader(c, await b.walkOnline(c))
    },
    away: async (_cw, c) => { if (b) kept = (await b.walkAway(c)).keptTitle },
    back: async (_cw, c) => {
      if (!b) return
      await b.afterBack(c, kept)
      const errors = b.errors.filter((e) => !/ResizeObserver/.test(e))
      c.add('browser: no page error the whole time', errors.length === 0, errors.slice(0, 3).join(' | '))
      const video = await b.close()
      console.log(`VIDEO  ${video ?? 'none'}`)
    },
  }
}

function makeWritable(dir: string): void {
  try { fs.chmodSync(dir, fs.statSync(dir).mode | 0o700) } catch { return }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) makeWritable(p)
    else if (e.isFile()) { try { fs.chmodSync(p, fs.statSync(p).mode | 0o600) } catch { /* gone */ } }
  }
}

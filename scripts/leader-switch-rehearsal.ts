/**
 * The leader-switch rehearsal on one Linux dev box (docs/reference/leader-switch.md,
 * "Rehearsal"): real servers on synthetic homes, three local witnesses, the real
 * `walnut leader switch` command. Prints one line per check; exits 1 when one fails.
 *
 *   bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--trials] [--flag-off (also: on with no witnesses)] [--restarts] [--all]
 *
 * Without a scenario flag it runs the main one: A leads, a standby copy to B, load through
 * A's API, the switch to B, every check, A started again by hand (online and offline), writes
 * on B, the switch back. `--gb N` puts N GB of filler in A's home first (the downtime of a
 * real-sized home; the first standby batch of 20 GB takes about 20 minutes). `--kills` kills
 * the command at each step and resumes it (`--no-back`: no switch back, for a large home on a full disk); `--trials` breaks the copy three ways. Everything
 * stays inside <work dir>; nothing reads ~/.open-walnut or uses :3456.
 */
import fs from 'node:fs'
import path from 'node:path'
import { KILL_POINTS, TRIAL_FAILURES, rehearseCancel, rehearseCancelAfterCommit, rehearseFlagOff, rehearseNoWitnesses, rehearseRestart, rehearseLedgerControl, rehearseKill, rehearseSwitchAndBack, rehearseTrialFailure, type Check } from './leader-switch/rehearsal.js'

const args = process.argv.slice(2)
const root = args[0]
if (!root || root.startsWith('--')) {
  console.error('usage: bun scripts/leader-switch-rehearsal.ts <work dir> [--gb N] [--kills] [--trials] [--flag-off] [--restarts] [--all] [--no-back] [--port-base N]')
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

const main = !has('--kills') && !has('--trials') && !has('--flag-off') && !has('--restarts')
if (main || all) {
  await rehearseLedgerControl(path.join(work, 'ledger-control'), print, ports())
  const r = await rehearseSwitchAndBack(path.join(work, 'main'), print, { ...ports(), fillerGb: gb, noBack: has('--no-back'), log })
  console.log(`DOWNTIME  switch ${r.downtimeMs !== undefined ? (r.downtimeMs / 1000).toFixed(1) : '?'} s, back ${r.backDowntimeMs !== undefined ? (r.backDowntimeMs / 1000).toFixed(1) : '?'} s${gb ? ` (home with ${gb} GB filler)` : ''}`)
}
if (has('--kills') || all) {
  for (const p of KILL_POINTS) await rehearseKill(path.join(work, `kill-${p}`), p, print, ports())
  await rehearseCancel(path.join(work, 'cancel'), print, ports())
  await rehearseCancelAfterCommit(path.join(work, 'cancel-after-commit'), print, ports())
}
if (has('--trials') || all) for (const k of TRIAL_FAILURES) await rehearseTrialFailure(path.join(work, `trial-${k}`), k, print, ports())
if (has('--restarts') || all) {
  const r = await rehearseRestart(path.join(work, 'restarts'), print, ports())
  console.log(`DOORS CLOSED  planned restart ${r.plannedMs !== undefined ? (r.plannedMs / 1000).toFixed(1) : '?'} s, crash ${r.crashMs !== undefined ? (r.crashMs / 1000).toFixed(1) : '?'} s`)
}
if (has('--flag-off') || all) {
  await rehearseFlagOff(path.join(work, 'flag-off'), print, ports())
  await rehearseNoWitnesses(path.join(work, 'no-witnesses'), print, ports())
}
console.log(failed ? `${failed} check(s) FAILED; evidence in ${work}` : `all checks passed; evidence in ${work}`)
process.exit(failed ? 1 : 0)

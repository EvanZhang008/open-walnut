/**
 * The one read of the write permission's record number for the session channel (channel.ts
 * PermitPair): every leader-side place that tells a host its standing (the channel's resume, the
 * door's welcome, an issued credential, a doors update) reads it here, and nowhere else reads
 * `record.number` for the channel (tests/core/session-channel/leader-permit.test.ts).
 *
 * The number: the running permit's record number while it has one; else (the permit system off
 * after it was on, or a permit still waiting for its record) the highest number this Walnut ever
 * told a host, kept in leader data (`cache/leader-permit-number.json`, the home manifest's
 * `cache.leader-permit-number`), so a host that saw (n, e) never sees (0, e') from the same Walnut,
 * and the standby copy carries the number to the machine a switch moves the leader to. 0 only for a
 * Walnut that never told a host a permit number. Every number a host ever saw went through this
 * function, so keeping it here, when it is told, is enough. A number that could not be kept is
 * still told: a later lower one is refused by the host (stale_permit), which delays it, never lets
 * a wrong leader in. A write that failed is tried again only after KEEP_RETRY_MS (each call would
 * otherwise do it on the event loop), and a temp file a crash left beside it is swept at the next
 * write. A forged higher number in the file (it needs write access to the home) only raises the
 * floor the hosts hold: they refuse this Walnut's lower numbers until the permit passes it, a
 * liveness cost, never a second leader let in (a host still checks each record's holder).
 *
 * The switch's modules load only when the permit really runs
 * (tests/core/leader/switch/flag-off-imports.test.ts, the rehearsal's no-witness check), so neither
 * this file nor the leader side (leader-boot.ts) imports any of them: the server hands this file the
 * switch's own reader once the permit booted (web/server.ts, beside leaderPermitAtBoot).
 */
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import type { currentLeaderPermit } from '../leader/switch/boot.js'

let read: typeof currentLeaderPermit | null = null

/** The leader side's wiring (and tests): where the running permit is read from; null: none. */
export function setLeaderPermitReader(fn: typeof currentLeaderPermit | null): void {
  read = fn
}

/** The running permit, or null while none runs (the system off, or no witnesses set). */
export function runningLeaderPermit(): ReturnType<typeof currentLeaderPermit> {
  return read?.() ?? null
}

/** Where the last number told to hosts is kept (leader data: it travels with the home). */
export function keptPermitNumberFile(home: string = WALNUT_HOME): string {
  return path.join(home, 'cache', 'leader-permit-number.json')
}

let keptHome: string | null = null
let kept: { file: string; number: number } | null = null
/** A write of the kept number failed at this time (ms): none tried again before KEEP_RETRY_MS. */
let keepFailedAt = 0
const KEEP_RETRY_MS = 30_000

/** Tests: the home whose kept number is read and written (null: WALNUT_HOME), and the cache forgotten. */
export function _setKeptPermitHomeForTesting(home: string | null): void {
  keptHome = home
  kept = null
  keepFailedAt = 0
}

function keptNumber(file: string): number {
  if (kept?.file === file) return kept.number
  let n = 0
  try {
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { number?: unknown } | null)?.number
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) n = v
  } catch { /* none kept yet, or torn: 0 */ }
  kept = { file, number: n }
  return n
}

function keepNumber(file: string, n: number): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  // A temp file an earlier process left (it crashed between the write and the rename) goes.
  const base = path.basename(file)
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${base}.`) && f.endsWith('.tmp') && f !== `${base}.${process.pid}.tmp`) fs.rmSync(path.join(dir, f), { force: true })
  }
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, number: n, at: new Date().toISOString() }))
    fs.renameSync(tmp, file)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  kept = { file, number: n }
}

export function leaderPermitNumberForHosts(): number {
  const file = keptPermitNumberFile(keptHome ?? WALNUT_HOME)
  const last = keptNumber(file)
  const permit = runningLeaderPermit()
  const running = permit?.runtime.status().record?.number
  if (typeof running !== 'number' || !Number.isSafeInteger(running) || running <= 0) return last
  // A switch's trial start writes nothing into the home it tries.
  if (running > last && !permit!.trial && Date.now() - keepFailedAt >= KEEP_RETRY_MS) {
    try { keepNumber(file, running); keepFailedAt = 0 } catch { keepFailedAt = Date.now() /* told anyway: see the header */ }
  }
  return running
}

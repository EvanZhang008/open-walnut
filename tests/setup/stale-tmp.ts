/**
 * Reclaim temp directories left behind by test processes that never got to
 * clean up after themselves.
 *
 * Two shapes of leak share one cause: the process that owned the directory was
 * SIGKILLed (a vitest fork torn down, a Playwright webServer killed as a process
 * group, an agent session timing out), so its exit-time `rm` never ran.
 * 2026-09-13: 52,000 such directories (26k `open-walnut-test-runtime-<pid>`,
 * 600 Slack fixtures, 400 Playwright fixtures) sat in $TMPDIR; the disk filled.
 *
 * The owner is identified one of two ways:
 *   - `name`:  the pid is the numeric suffix of the directory name
 *              (`open-walnut-test-runtime-<pid>` and its `-streams` sibling).
 *   - `owner-file`: the process wrote its pid to `<dir>/owner.pid` right after
 *              mkdir (Playwright / plugin fixture servers, whose names carry a
 *              timestamp, not a pid).
 *
 * A directory is stale when its owner pid is dead. One that has no owner file
 * yet is left alone unless it is older than `orphanAgeMs`: a server that just
 * ran mkdir and has not written owner.pid is milliseconds old, a leaked one is
 * hours old.
 *
 * A third kind, `age`, has no owner to ask (mock homes a spawned child wrote
 * into after the worker's reaper removed them) and is stale by age alone; it
 * needs a full-name pattern and relies on vitest runs being serialized.
 *
 * Scope is deliberately narrow: only immediate children of `tmpdir` that match a
 * rule's prefix and name pattern are ever removed; a rule with neither matches
 * nothing. Nothing here walks upward or follows a caller-supplied path.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const OWNER_FILE = 'owner.pid'

export type StaleTmpRule = {
  /** Basename prefix of the directories this rule owns, e.g. `walnut-pw-`. */
  prefix: string
  /**
   * Full-basename pattern, when the prefix alone is too loose. `walnut-pw-` is
   * also the prefix of the shared lease dir `walnut-pw-lease`, which has no
   * owner and must never be swept; `/^walnut-pw-\d+$/` says exactly which dirs
   * are fixture homes.
   */
  name?: RegExp
  /**
   * Where the owner pid lives. `age` means there is no owner to ask: the entry
   * is stale purely by being older than `orphanAgeMs`. Only for names whose
   * makers are known to be short-lived AND serialized machine-wide (vitest runs
   * queue behind tests/setup/test-gate.ts), so at sweep time nothing live can
   * own an old one. Requires `name`.
   */
  pidFrom: 'name' | 'owner-file' | 'age'
  /** `owner-file` / `age`: a dir with no owner is stale once older than this (default 2h). */
  orphanAgeMs?: number
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: alive but another uid's. Only ESRCH proves it is gone.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** Record this process as the owner of `dir` so a later sweep can tell it is live. */
export function writeOwnerPid(dir: string, pid = process.pid): void {
  fs.writeFileSync(path.join(dir, OWNER_FILE), String(pid))
}

function ownerPidOf(dir: string, rule: StaleTmpRule, base: string): number | null {
  if (rule.pidFrom === 'age') return null
  if (rule.pidFrom === 'name') {
    const m = new RegExp(`^${escapeRegExp(rule.prefix)}(\\d+)(?:-streams)?$`).exec(base)
    return m ? Number(m[1]) : null
  }
  try {
    const n = Number(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim())
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isStale(dir: string, rule: StaleTmpRule, base: string, now: number): boolean {
  const pid = ownerPidOf(dir, rule, base)
  if (pid !== null) return !pidAlive(pid)
  if (rule.pidFrom === 'name') return false // suffix is not a pid: not ours to judge
  let mtime: number
  try {
    mtime = fs.statSync(dir).mtimeMs
  } catch {
    return false
  }
  return now - mtime > (rule.orphanAgeMs ?? 2 * 60 * 60_000)
}

/** A rule owns `base` when its prefix matches and, if it has one, its full-name pattern too. An `age` rule must have the pattern. */
function matches(r: StaleTmpRule, base: string): boolean {
  if (r.pidFrom === 'age' && !r.name) return false
  if (r.prefix.length === 0 && !r.name) return false
  return base.startsWith(r.prefix) && (!r.name || r.name.test(base))
}

/**
 * Remove every stale directory the rules describe. Returns the paths removed.
 * Never throws: a sweep is housekeeping and must not fail the run that asked.
 */
export function sweepStaleTmpDirs(rules: StaleTmpRule[], tmpdir = os.tmpdir(), now = Date.now()): string[] {
  const removed: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(tmpdir, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const base = entry.name
    const rule = rules.find((r) => matches(r, base))
    if (!rule) continue
    const dir = path.join(tmpdir, base)
    if (!isStale(dir, rule, base, now)) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      /* another sweep got it, or a file is pinned open; next run retries */
    }
  }
  return removed
}

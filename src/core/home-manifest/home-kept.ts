/**
 * Whether a data home stayed as it was, by the manifest's classes: the check for a home that
 * handed the leader over (docs/reference/leader-switch.md; the switch's rehearsals and its own
 * checks use this one, never a list of their own).
 *
 *   leader-data, machine     must not change by a byte (added, removed or changed)
 *   rebuildable              skipped
 *   daemon state             skipped: this machine's daemon writes there as it runs, whichever
 *                            home leads (HomeEntry.daemonState)
 *
 * Every skipped change is listed, so a reader sees what was not held to the rule. A snapshot
 * reads every file of the home (sha256 of its bytes; modes and times are not counted), off the
 * event loop's critical path (fs/promises), for a script, a test or the switch's command, never
 * for a request.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { classifyHomePath, UNKNOWN_HOME_PATH_CLASS } from './index.js'
import type { DataClass } from './types.js'

export interface KeptPath { cls: DataClass; daemonState: boolean; sum: string }

/** Every path of a home ('dir/' for a folder), its class, its mark and its bytes' hash. */
export type HomeSnapshot = Map<string, KeptPath>

export interface HomeChange { path: string; cls: DataClass; how: 'added' | 'removed' | 'changed' }

export interface KeptVerdict {
  /** No leader-data or machine path (other than daemon state) changed. */
  ok: boolean
  /** The changes that break it. */
  changed: HomeChange[]
  /** The changes the rule does not hold, by why. */
  skipped: { rebuildable: HomeChange[]; daemonState: HomeChange[] }
}

async function sumOf(file: string): Promise<string> {
  const h = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve()).on('error', reject)
  })
  return h.digest('hex')
}

function placed(rel: string): Pick<KeptPath, 'cls' | 'daemonState'> {
  const entry = classifyHomePath(rel)
  return { cls: entry?.class ?? UNKNOWN_HOME_PATH_CLASS, daemonState: entry?.daemonState === true }
}

export async function snapshotHome(home: string): Promise<HomeSnapshot> {
  const out: HomeSnapshot = new Map()
  const walk = async (rel: string): Promise<void> => {
    const entries = await fsp.readdir(rel ? path.join(home, rel) : home, { withFileTypes: true })
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      const where = placed(p)
      if (e.isDirectory()) { out.set(`${p}/`, { ...where, sum: 'dir' }); await walk(p) }
      else if (e.isSymbolicLink()) out.set(p, { ...where, sum: `link ${await fsp.readlink(path.join(home, p))}` })
      else if (e.isFile()) out.set(p, { ...where, sum: await sumOf(path.join(home, p)) })
      else out.set(p, { ...where, sum: 'other' })
    }
  }
  await walk('')
  return out
}

/** What differs between two snapshots of one home, judged by the rule above. */
export function compareKept(before: HomeSnapshot, after: HomeSnapshot): KeptVerdict {
  const all: Array<HomeChange & { daemonState: boolean }> = []
  for (const [p, e] of after) {
    const b = before.get(p)
    if (!b) all.push({ path: p, cls: e.cls, daemonState: e.daemonState, how: 'added' })
    else if (b.sum !== e.sum) all.push({ path: p, cls: e.cls, daemonState: e.daemonState, how: 'changed' })
  }
  for (const [p, e] of before) if (!after.has(p)) all.push({ path: p, cls: e.cls, daemonState: e.daemonState, how: 'removed' })
  all.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  const plain = ({ daemonState: _d, ...c }: HomeChange & { daemonState: boolean }): HomeChange => c
  const changed = all.filter((c) => c.cls !== 'rebuildable' && !c.daemonState).map(plain)
  return {
    ok: changed.length === 0,
    changed,
    skipped: {
      rebuildable: all.filter((c) => c.cls === 'rebuildable').map(plain),
      daemonState: all.filter((c) => c.cls !== 'rebuildable' && c.daemonState).map(plain),
    },
  }
}

/** One line for a log or a check: what broke the rule, then what was skipped and why. */
export function describeKept(v: KeptVerdict, max = 8): string {
  const list = (cs: HomeChange[]) => cs.length ? `${cs.slice(0, max).map((c) => `${c.how} ${c.path}${c.cls === 'rebuildable' ? '' : ` (${c.cls})`}`).join(', ')}${cs.length > max ? `, and ${cs.length - max} more` : ''}` : 'none'
  return `${v.changed.length} kept path(s) changed${v.changed.length ? `: ${list(v.changed)}` : ''}; skipped as daemon state: ${list(v.skipped.daemonState)}; skipped as rebuildable: ${list(v.skipped.rebuildable)}`
}

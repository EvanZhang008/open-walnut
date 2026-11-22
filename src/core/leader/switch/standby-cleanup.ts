/**
 * After a switch the new leader's machine keeps, in its own standby folder (its `standby_dir`
 * in leader_switch.machines, where the old leader's batches landed), every chunk and manifest of
 * the final batch it was promoted from: as large as the home, and nothing sends there any more
 * (the new leader's batches go to the old machine's folder). Its `copy/` became the home.
 *
 * It is kept while the switch is young: through the switch-back window (`back_window_hours`,
 * 168 h by default, flow.ts) it is the old leader's last state, for a person to look at should
 * the new home turn out wrong, and a switch back finds the old leader sending into a folder that
 * already holds most chunks. Past the window it is removed (StandbyTarget.discard: the folder
 * stays, empty, a valid target for a later sender) when all of these hold:
 *
 *   - this home leads because of a switch: its last history.json entry, promoted.json 'led' by
 *     that same switch, no switch from this home under way, and no handed-over marker;
 *   - `back_window_hours` passed since that switch committed;
 *   - this home's own standby took a complete batch after the commit (the caller: the standby
 *     runner, right after one), so the data has a second copy elsewhere before this one goes;
 *   - the folder's last batch was committed before the switch committed: nobody sent to it
 *     since. A later batch (the old machine leads again and sends here) means it is live: kept;
 *   - the folder is a standby target (standby.json of the format) that neither holds nor sits in
 *     this home or this home's own standby target (a local one: with `standby.host` that target is
 *     on another host and its path is not compared), as written and with links resolved.
 * Nothing outside that folder is touched: a top-level entry of it (chunks/, copy/, ...) that is a
 * link is left as it is, and a link deeper inside (in copy/, say) is removed as a link, never
 * followed.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StandbyTarget } from '../../standby/index.js'
import { pathInside } from '../../standby/target-files.js'
import { readHistory, readMarker, readPromoted, switchDir } from './records.js'
import { machineByHome, readHomeConfigRaw, readHomeSwitchConfig } from './settings.js'

export type StandbyCleanupOutcome =
  | { removed: true; dir: string; switchId: string; bytes: number; refused: string[] }
  | { removed: false; why: string; dir?: string; switchId?: string; notBefore?: number }

export interface StandbyCleanupInput {
  home: string
  /** When this home's own latest complete standby batch was taken (ISO): it must be after the commit. */
  ownBatchTakenAt: string | null
  now?: number
}

const inside = pathInside

async function real(p: string): Promise<string> {
  try { return await fsp.realpath(p) } catch { return path.resolve(p) }
}

/** A switch from this home that has not ended (flow.ts SwitchState, read without loading the flow). */
function switchUnderWay(home: string): boolean {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(switchDir(home), 'switch-state.json'), 'utf8')) as { step?: string }
    return st.step !== 'done' && st.step !== 'rolled-back'
  } catch { return false }
}

export async function cleanSwitchedStandby(input: StandbyCleanupInput): Promise<StandbyCleanupOutcome> {
  const home = path.resolve(input.home)
  const now = input.now ?? Date.now()
  const cfg = readHomeSwitchConfig(home)
  if (!cfg.flag || !cfg.settings) return { removed: false, why: 'the leader switch is not set up in this home' }
  const me = machineByHome(cfg.settings, home)
  if (!me) return { removed: false, why: 'this home is not the home of any machine in leader_switch.machines' }
  const last = readHistory(home).at(-1)
  if (!last) return { removed: false, why: 'no switch made this home the leader' }
  const promoted = readPromoted(home)
  if (promoted?.switchId !== last.switchId || promoted.state !== 'led') return { removed: false, why: `switch ${last.switchId} has not finished here`, switchId: last.switchId }
  if (switchUnderWay(home)) return { removed: false, why: 'a switch from this home is under way', switchId: last.switchId }
  // A home handed over since (its standby server runs on it): the other machine leads and sends here.
  if (readMarker(home)) return { removed: false, why: 'this home was handed over: it does not lead', switchId: last.switchId }
  const committedAt = Date.parse(last.committedAt)
  const notBefore = committedAt + cfg.settings.backWindowHours * 3_600_000
  if (!Number.isFinite(committedAt) || now < notBefore) return { removed: false, why: 'the switch-back window has not passed', switchId: last.switchId, notBefore }
  if (!input.ownBatchTakenAt || !(Date.parse(input.ownBatchTakenAt) > committedAt)) return { removed: false, why: 'this home\'s own standby has no complete batch since the switch', switchId: last.switchId }

  const dir = me.standbyDir
  const out = (why: string): StandbyCleanupOutcome => ({ removed: false, why, dir, switchId: last.switchId })
  const realDir = await real(dir)
  // This home's own standby target is a path here only without `standby.host`. With a host, it
  // is a folder on that host (a path there says nothing about the folders here), so it is not
  // compared: what keeps the folder here safe is its own state and lock, read below (a sender
  // here, a daemon's receive of a host leader, commits through the same StandbyTarget lock and
  // standby.json), and the home is still compared.
  const standby = readHomeConfigRaw(home).standby as { host?: unknown } | undefined
  const ownHere = typeof standby?.host === 'string' && standby.host ? undefined : cfg.standbyDir
  for (const [label, other] of [['this home', home], ['this home\'s own standby target', ownHere]] as const) {
    if (!other) continue
    for (const [d, o] of [[path.resolve(dir), path.resolve(other)], [realDir, await real(other)]]) {
      if (inside(d, o) || inside(o, d)) return out(`the folder and ${label} (${other}) contain each other`)
    }
  }
  const target = new StandbyTarget(dir)
  if (!fs.existsSync(target.t.state)) {
    // Already empty, or what a discard that failed or was killed partway left: its .discard-*
    // folder, and the batch entries it had not moved yet (finishDiscard; none without that folder).
    await target.finishDiscard().catch(() => false)
    return out('the folder holds no standby copy')
  }
  const r = await target.discard((s) => {
    if (!s.current) return 'the folder holds no complete batch'
    if (!(Date.parse(s.current.committedAt) < committedAt)) return `the folder took batch ${s.current.batch} after the switch: a standby sends to it`
    return null
  }).catch((err) => ({ ok: false as const, why: (err as Error).message }))
  if (!r.ok) return out(r.why)
  return { removed: true, dir, switchId: last.switchId, bytes: r.bytes, refused: r.refused }
}

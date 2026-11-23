/**
 * After a leader switch, the hosts follow the new leader: it declares the previous holder's data
 * dir as where this Walnut moved from (src/core/home-move.ts), and each host makes its own data dir
 * an alias of the Walnut's first home there (walnut-scope-core.ts declareMove). Everything a host
 * keyed under the old path (trigger epoch, seq and seen, plugin jobs, detached records, copies,
 * the host server and the bridge) is then the new leader's, one set, and the old path is refused
 * for good there (`walnut_home_busy`), so nothing keeps firing for a leader that left.
 *
 * Declared only when ALL hold:
 *   - the permit guards this process (experiment switchable_leader with a leader_switch section)
 *     and it is not the switch's trial start;
 *   - this home carries no handed-over marker (a home that handed the lead away never speaks for
 *     this Walnut: it runs as a standby that opens no host link, handed-over.ts);
 *   - its promotion record (`local/leader-switch/promoted.json`) names this machine as the one
 *     the lead went to and carries the previous holder's data dir as its server spelled it;
 *   - the switch committed: the record is `led` (the switch command wrote it after it saw the
 *     new holder's record on a witness majority), or this process is the commit start and its own
 *     record, above the switch's handover, now stands on a majority (state `leading`).
 * Before the commit stands this waits: a host that heard this Walnut from here first would keep a
 * record of its own for the new path, and the move could never be taken there (`own_record_same`).
 *
 * Where the old path comes from: the old leader's own server says it (GET /api/leader/status,
 * `homeOnHosts`: the path it sends to its hosts and the former homes its record keeps), the switch
 * keeps it in its state at the preflight and writes it into the promotion record before the
 * commit start. Not the `leader_switch.machines` entry (a person's spelling, resolved: a host keys
 * the exact string), and not the handover record at the witnesses (the next renew replaces it).
 */
import { leaderPermitActive } from './doors.js'
import { readMarker, readPromoted, type PromotedRecord } from './records.js'
import { HomeMoveHeld, type SwitchedFrom } from '../../home-move.js'
import { DEFAULT_PERMIT_PARAMS, type PermitParams } from '../permit/types.js'
import type { RuntimeState } from './runtime.js'

/** What this process knows of its permit (boot.ts currentLeaderPermit). */
export interface PermitView {
  machine: string
  trial: boolean
  status(): { state: RuntimeState; record: { number: number; holder?: string } | null }
}

/**
 * `booting`: the permit's runtime runs but boot.ts has not named it yet. Its first witness rounds
 * may open host links (remote witnesses) before then, and those must not describe this Walnut.
 */
export type PermitSeen = PermitView | 'booting' | null

export type SwitchedVerdict = { kind: 'none'; why: string } | { kind: 'wait'; why: string } | { kind: 'declare'; switched: SwitchedFrom }

/** The rule, pure: what a start on `home` declares of a leader switch. */
export function judgeSwitchedHere(input: { promoted: PromotedRecord | null; handedOver: boolean; permit: PermitSeen }): SwitchedVerdict {
  const { promoted: p, permit } = input
  if (input.handedOver) return { kind: 'none', why: 'this home handed the lead away' }
  if (!p || p.torn || !p.switchId) return { kind: 'none', why: 'no leader switch made this home' }
  if (typeof p.fromHomeOnHosts !== 'string' || !p.fromHomeOnHosts) return { kind: 'none', why: `switch ${p.switchId} does not say where the previous holder was on its hosts` }
  if (!permit) return { kind: 'none', why: 'no permit guards this process' }
  if (permit === 'booting') return { kind: 'wait', why: 'the permit is still booting' }
  if (permit.trial) return { kind: 'none', why: 'a trial start speaks to no host' }
  if (p.to !== permit.machine) return { kind: 'none', why: `switch ${p.switchId} named machine ${p.to ?? '?'}, not this one (${permit.machine})` }
  const switched: SwitchedFrom = {
    switchId: p.switchId,
    home: p.fromHomeOnHosts,
    formerHomes: Array.isArray(p.fromFormerHomes) ? p.fromFormerHomes.filter((h): h is string => typeof h === 'string' && !!h) : [],
  }
  if (p.state === 'led') return { kind: 'declare', switched }
  const st = permit.status()
  const above = typeof p.handover === 'number' ? p.handover : Infinity
  if (st.state === 'leading' && st.record && st.record.holder === permit.machine && st.record.number > above) return { kind: 'declare', switched }
  return { kind: 'wait', why: `switch ${p.switchId} has not committed in this process yet (${st.state})` }
}

/** How often a commit start looks again whether its commit stood: first quickly, then at most every 5 s. */
const COMMIT_LOOK_MS = 250
const COMMIT_LOOK_MAX_MS = 5_000

/**
 * How long one wait for the commit may take: twice the longest a commit can take when nothing is
 * wrong. That longest is an earlier record of this machine running out at the witnesses before it
 * may grant (validMs + witnessMarginMs, 62 s by default: a commit start restarted after a crash),
 * so 124 s by default. Past it the witnesses are taken as out of reach for now: the host
 * connection that waits fails (HomeMoveHeld) and retries on its backoff, each try with a new wait.
 */
export function commitWaitMs(params: Pick<PermitParams, 'validMs' | 'witnessMarginMs'>): number {
  return 2 * (params.validMs + params.witnessMarginMs)
}

/**
 * The switch to declare from `home`, once its commit stood; null when there is none (or the
 * permit stopped before the commit stood: the process goes away). While the commit has not stood
 * (or the permit is still booting) it waits, looking again from every 250 ms up to every 5 s, never
 * answering null for it: past `deadlineMs` (commitWaitMs of the home's permit) it rejects with
 * HomeMoveHeld, and the asking connection fails without a frame.
 */
export async function switchedHereAfterCommit(home: string, permitOf?: () => PermitSeen, deadlineMs?: number): Promise<SwitchedFrom | null> {
  let view = permitOf
  if (!view) {
    const { currentLeaderPermit } = await import('./boot.js')
    view = () => {
      const p = currentLeaderPermit()
      if (p) return { machine: p.machine, trial: p.trial, status: () => p.runtime.status() }
      return leaderPermitActive() ? 'booting' : null
    }
  }
  const look = () => judgeSwitchedHere({ promoted: readPromoted(home), handedOver: readMarker(home) !== null, permit: view!() })
  let v = look()
  if (v.kind === 'wait') {
    // WALNUT_TEST_COMMIT_WAIT_MS: tests only (read only under vitest), a short wait in place of the permit's.
    const testWait = process.env.VITEST ? Number(process.env.WALNUT_TEST_COMMIT_WAIT_MS) : NaN
    const waitMs = deadlineMs ?? (testWait > 0 ? testWait : await (async () => {
      const { readHomeSwitchConfig } = await import('./settings.js')
      return commitWaitMs(readHomeSwitchConfig(home).settings?.params ?? DEFAULT_PERMIT_PARAMS)
    })())
    const until = Date.now() + waitMs
    v = await new Promise<SwitchedVerdict>((resolve, reject) => {
      let every = COMMIT_LOOK_MS
      const again = () => {
        const next = look()
        if (next.kind !== 'wait') { resolve(next); return }
        const seen = view!()
        // Stopped before its commit stood: nothing to declare from this process.
        if (seen && seen !== 'booting' && seen.status().state === 'stopped') { resolve({ kind: 'none', why: 'the permit stopped before the commit stood' }); return }
        const left = until - Date.now()
        if (left <= 0) { reject(new HomeMoveHeld(readPromoted(home)?.switchId ?? '?', waitMs)); return }
        every = Math.min(COMMIT_LOOK_MAX_MS, Math.round(every * 1.5))
        setTimeout(again, Math.min(every, left)).unref?.()
      }
      setTimeout(again, Math.min(COMMIT_LOOK_MS, waitMs)).unref?.()
    })
  }
  return v.kind === 'declare' ? v.switched : null
}

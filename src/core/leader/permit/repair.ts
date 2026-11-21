/**
 * A witness list change between its two steps (rules.ts judge), as a machine sees it: which
 * witnesses it saw hold the pair, and what finishes a change its writer left half done.
 *
 * A change only goes forward. A witness that took the pair never goes back to the old list
 * alone, and a pair is never turned toward another new list: once a pair stood, witnesses of
 * its new list may take its final step at any later time, so a second pair beside it could
 * end in two lists that do not overlap. So a stuck change is finished, or waits for the
 * witnesses it needs.
 */
import type { PermitReply } from './types.js'
import { majorityOf, nextConfigId, sameList } from './types.js'

/** One pair: from configuration `cfg` (its `list`, generation `epoch`) to `next`. */
export interface PairView {
  cfg: string
  epoch: number
  list: string[]
  next: string[]
}

const sorted = (l: readonly string[]) => [...l].sort().join(',')
const pairKey = (cfg: string, list: readonly string[], next: readonly string[]) => `${cfg}|${sorted(list)}|${sorted(next)}`

/**
 * Every witness seen standing in a pair, or in a plain configuration, by any answer (to a
 * proposal of any machine, or a read). A witness's configuration only moves forward, so what
 * it once showed stays true: a witness seen in the pair took it.
 */
export class PairEvidence {
  private inPair = new Map<string, Set<string>>()
  private plain = new Map<string, Set<string>>()

  note(r: PermitReply): void {
    if (!r.list || !r.cfg) return
    const [m, k] = r.joint ? [this.inPair, pairKey(r.cfg, r.list, r.joint)] : [this.plain, `${r.cfg}|${sorted(r.list)}`]
    const s = m.get(k) ?? new Set<string>()
    s.add(r.witness)
    m.set(k, s)
  }

  /** The witnesses seen in pair `p` or past it (in the configuration it leads to), of its two lists. */
  shown(p: PairView): string[] {
    const past = this.plain.get(`${nextConfigId(p.cfg, p.next)}|${sorted(p.next)}`) ?? []
    const all = new Set([...(this.inPair.get(pairKey(p.cfg, p.list, p.next)) ?? []), ...past])
    return [...all].filter((w) => p.list.includes(w) || p.next.includes(w)).sort()
  }

  /** The pair is known to stand: a majority of each list was seen in it or past it. */
  stands(p: PairView): boolean {
    const by = this.shown(p)
    const n = (l: string[]) => l.filter((w) => by.includes(w)).length
    return n(p.list) >= majorityOf(p.list) && n(p.next) >= majorityOf(p.next)
  }
}

export type RepairPlan =
  | { kind: 'none' }
  /** The pair stands: send the final step. */
  | { kind: 'final'; pair: PairView }
  /** The pair does not stand yet and enough witnesses of both lists answer to take it: send the pair step again. */
  | { kind: 'pair'; pair: PairView }
  /** It cannot go on until these witnesses answer (and are set up to join); nothing is sent. */
  | { kind: 'blocked'; pair: PairView; waitingFor: string[] }

export interface RepairInput {
  /** The machine's configuration (PermitClient.config()). */
  list: string[]
  cfg: string
  epoch: number
  joint: string[] | null
  /** The latest read round. */
  reads: PermitReply[]
  evidence: PairEvidence
}

/**
 * What finishes a change left between its steps. The pair is the machine's own, or the one
 * most witnesses of its list report standing in. The pair step is sent again only when a
 * majority of each list answers and can take it: pushing a pair whose new witnesses are gone
 * would stop the witnesses that still work (a witness in a pair takes nothing the new list
 * does not take too).
 */
export function planRepair(input: RepairInput): RepairPlan {
  const pair = pairToFinish(input)
  if (!pair) return { kind: 'none' }
  if (input.evidence.stands(pair)) return { kind: 'final', pair }
  const byWitness = new Map(input.reads.map((r) => [r.witness, r]))
  const ready = (w: string): boolean => {
    const r = byWitness.get(w)
    if (!r) return false
    if (r.list && r.cfg === pair.cfg && sameList(r.list, pair.list)) return !r.joint || sameList(r.joint, pair.next)
    // A witness set up to join, from this change's generation or an earlier one.
    return !r.list && r.epoch !== null && r.epoch <= pair.epoch && pair.next.includes(w) && !pair.list.includes(w)
  }
  const short = [pair.list, pair.next].filter((l) => l.filter(ready).length < majorityOf(l))
  if (short.length === 0) return { kind: 'pair', pair }
  return { kind: 'blocked', pair, waitingFor: [...new Set(short.flat().filter((w) => !ready(w)))].sort() }
}

function pairToFinish(input: RepairInput): PairView | null {
  if (input.joint) return { cfg: input.cfg, epoch: input.epoch, list: [...input.list], next: [...input.joint] }
  const counts = new Map<string, { next: string[]; n: number }>()
  for (const r of input.reads) {
    if (!input.list.includes(r.witness) || !r.joint || r.cfg !== input.cfg || !sameList(r.list, input.list)) continue
    const k = sorted(r.joint)
    const c = counts.get(k) ?? { next: [...r.joint].sort(), n: 0 }
    c.n++
    counts.set(k, c)
  }
  const best = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))[0]
  return best ? { cfg: input.cfg, epoch: input.epoch, list: [...input.list], next: best[1].next } : null
}

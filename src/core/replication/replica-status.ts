/**
 * The leader's view of every follower's copies, kind by kind
 * (docs/plan/walnut-replica-servers-impl.md, section 4), behind
 * GET /api/replicas/status (web/routes/replicas-status.ts).
 *
 * The generic kinds (kind-leader.ts) keep their per-target state HERE: the
 * manifest a target last took, its rest after an unknown kind or a newer
 * schema, the refused rounds of the half rule and the confirm the user gave.
 * One object per (target, kind), so two targets never share a memo. Kinds
 * with their own protocol (search, devices) only report a status row.
 */

import type { FollowerKind } from '../server-role.js'
import { CONFIRM_AFTER_REFUSALS, type ConfirmFor } from './kind.js'

/**
 * A refused manifest: its row count and key set (kind.ts manifestKeysHashOf),
 * and the follower's side of it: the rows it holds (`local`) and how many the
 * manifest would remove (`removing`), so the user confirms knowing the size.
 */
export interface KindRefusal { error: string; at: number; entries: number; keys?: string; local?: number; removing?: number }

/** The confirm the user gave: bound to the refused manifest's count and keys, until `expiresAt`. */
export interface KindConfirm extends ConfirmFor { at: number; expiresAt: number }

/** A confirm the follower refused anyway (its build is older than the confirm, kind-leader.ts): what it was for, and when. */
export interface KindConfirmRefused extends ConfirmFor { at: number }

/** One kind on one target. The memo fields are the leader's; the rest is what Settings shows. */
export interface KindState {
  kind: string
  /** The manifest hash the target last took whole (null: send it next round). */
  manifest: string | null
  /** Rest after `unknown_kind` / `schema_newer` / an older follower: no step before this (ms epoch). */
  restUntil: number
  restWhy?: string
  /** Rounds refused in a row by the half rule, of the same leader manifest (count and keys). */
  refusals: number
  lastRefusal?: KindRefusal
  /** The user confirmed the removal: the next sync carries `confirm:true`, if `confirmFor` still matches. */
  confirmNext: boolean
  confirmFor?: KindConfirm
  /** The follower refused a confirm: Settings says to update it there, until a refusal names its size. */
  confirmRefused?: KindConfirmRefused
  action?: string
  entries?: number
  held?: number
  sent?: number
  removed?: number
  /** The leader's clock of the last manifest the target answered. */
  asOf?: number
  syncedAt?: number
  error?: string
}

export interface KindStatus {
  kind: string
  action?: string
  entries?: number
  held?: number
  sent?: number
  removed?: number
  asOf?: number
  syncedAt?: number
  /** How old the target's copy is: now minus its last synced round (WP14, section 13). */
  ageMs?: number
  error?: string
  refusals: number
  lastRefusal?: KindRefusal
  /** Three refused rounds: Settings offers the confirm (a row, never a letter). */
  needsConfirm: boolean
  /** A confirm the user gave that no round has sent yet (it goes only for this count and these keys). */
  confirmArmed?: KindConfirm
  /**
   * The follower refused a confirm the user gave: its Walnut is older than the
   * confirm, so Settings says to update it there instead of offering it again.
   * Only while the refusals would offer one (three in a row).
   */
  confirmRefused?: KindConfirmRefused
  restingUntil?: number
}

export interface TargetStatus { id: string; kind: FollowerKind; label: string; kinds: KindStatus[] }

interface TargetEntry { id: string; kind: FollowerKind; label: string; kinds: Map<string, KindState> }

const targets = new Map<string, TargetEntry>()
type StatusSource = () => Promise<Array<{ target: { id: string; kind: FollowerKind; label: string }; status: KindStatus }>>
const sources = new Map<string, StatusSource>()

/** The state of `kind` on `target`, made on first use. */
export function kindState(target: { id: string; kind: FollowerKind; label: string }, kind: string): KindState {
  let t = targets.get(target.id)
  if (!t) {
    t = { id: target.id, kind: target.kind, label: target.label, kinds: new Map() }
    targets.set(target.id, t)
  }
  t.label = target.label
  let s = t.kinds.get(kind)
  if (!s) {
    s = { kind, manifest: null, restUntil: 0, refusals: 0, confirmNext: false }
    t.kinds.set(kind, s)
  }
  return s
}

/** The state if it exists (never makes one). */
export function peekKindState(targetId: string, kind: string): KindState | null {
  return targets.get(targetId)?.kinds.get(kind) ?? null
}

/** Send these kinds' manifests again on every target (the sweep). */
export function forgetKindManifests(kinds: readonly string[]): void {
  const want = new Set(kinds)
  for (const t of targets.values()) for (const s of t.kinds.values()) if (want.has(s.kind)) s.manifest = null
}

/**
 * A follower that restarted (a new server process on a host): every kind's
 * manifest goes again and every rest ends, so its next round sends a real
 * step (its copy may be gone, or its build newer). The refusals stay.
 */
export function forgetTarget(id: string): void {
  for (const s of targets.get(id)?.kinds.values() ?? []) {
    s.manifest = null
    s.restUntil = 0
    s.restWhy = undefined
  }
}

/** A target that left (unregistered): its states go with it. */
export function dropTargetsNotIn(ids: readonly string[]): void {
  const keep = new Set(ids)
  for (const id of [...targets.keys()]) if (!keep.has(id)) targets.delete(id)
}

/** A kind with its own protocol (search, devices) reports its rows through this. */
export function registerStatusSource(kind: string, source: StatusSource): () => void {
  sources.set(kind, source)
  return () => { if (sources.get(kind) === source) sources.delete(kind) }
}

/** A kind with its own protocol records one target's last round. */
export function noteKindRound(target: { id: string; kind: FollowerKind; label: string }, kind: string, patch: Partial<KindState>): void {
  Object.assign(kindState(target, kind), patch)
}

export function kindStatusOf(s: KindState, now = Date.now()): KindStatus {
  const out: KindStatus = { kind: s.kind, refusals: s.refusals, needsConfirm: false }
  for (const k of ['action', 'entries', 'held', 'sent', 'removed', 'asOf', 'syncedAt', 'error', 'lastRefusal'] as const) {
    if (s[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = s[k]
  }
  if (s.restUntil > now) out.restingUntil = s.restUntil
  if (typeof s.syncedAt === 'number') out.ageMs = Math.max(0, now - s.syncedAt)
  if (confirmArmed(s, now)) out.confirmArmed = { ...s.confirmFor! }
  if (s.confirmRefused && s.refusals >= CONFIRM_AFTER_REFUSALS && !confirmArmed(s, now)) out.confirmRefused = { ...s.confirmRefused }
  out.needsConfirm = needsConfirm(s, now)
  return out
}

/** A confirm is armed while it is unsent and not past its time. */
export function confirmArmed(s: KindState, now = Date.now()): boolean {
  return s.confirmNext && !!s.confirmFor && s.confirmFor.expiresAt > now
}

/** A confirm is armed on this target's kind (a round should send it). */
export function confirmWaiting(targetId: string, kind: string, now = Date.now()): boolean {
  const s = peekKindState(targetId, kind)
  return !!s && confirmArmed(s, now)
}

/** Three refused rounds in a row of a stable leader manifest, no confirm armed, and a follower that takes one. */
export function needsConfirm(s: KindState, now = Date.now()): boolean {
  return s.refusals >= CONFIRM_AFTER_REFUSALS && !confirmArmed(s, now) && !s.confirmRefused
}


/** Every target, kind by kind (the generic kinds, then each source's rows). */
export async function replicaStatuses(now = Date.now()): Promise<TargetStatus[]> {
  const out = new Map<string, TargetStatus>()
  for (const t of targets.values()) {
    out.set(t.id, { id: t.id, kind: t.kind, label: t.label, kinds: [...t.kinds.values()].map((s) => kindStatusOf(s, now)) })
  }
  for (const [kind, source] of sources) {
    let rows: Awaited<ReturnType<StatusSource>> = []
    try { rows = await source() } catch { continue }
    for (const { target, status } of rows) {
      const t = out.get(target.id) ?? { id: target.id, kind: target.kind, label: target.label, kinds: [] }
      t.kinds = [...t.kinds.filter((k) => k.kind !== kind), status]
      out.set(target.id, t)
    }
  }
  return [...out.values()]
}

/** Tests only. */
export function _resetReplicaStatusForTesting(): void {
  targets.clear()
  sources.clear()
}

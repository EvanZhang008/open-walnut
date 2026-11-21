/**
 * One witness: holds the highest record it accepted, durably, and answers a proposal
 * only after the record is on disk. After a restart it reads the record back and
 * counts it as accepted at the restart (it cannot know how long ago it was; counting
 * from the restart only makes it wait longer before granting to another machine).
 */
import type { ElapsedClock, PermitParams, PermitReply, PermitRequest } from './types.js'
import { judge, grantable, type WitnessState } from './rules.js'
import { PermitStoreCorrupt, type PermitStore } from './store.js'
import { plainEntry } from './ops.js'

export interface WitnessOptions {
  id: string
  store: PermitStore
  /** Elapsed time that never runs fast across a pause: a plain monotonic clock. */
  clock: ElapsedClock
  params: PermitParams
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export class PermitWitness {
  readonly id: string
  private state: WitnessState
  /** Why this witness refuses everything (its file is corrupt or cannot be written). */
  private broken: string | null = null

  constructor(private readonly opts: WitnessOptions) {
    this.id = opts.id
    this.state = { held: null, acceptedAt: opts.clock.now(), list: null, joint: null, cfg: null, epoch: null, progress: null, ops: [] }
    try {
      const stored = opts.store.load()
      // No file: never set up (bootstrapWitnessStore, prepareJoiningWitness), or lost: it
      // takes nothing until its operator sets it up again.
      // Like the record, every op entry counts as changed at the restart: one whose outcome is
      // known is kept a whole retention from now (longer, never shorter).
      if (stored) {
        const at = opts.clock.now()
        this.state = { held: stored.held, list: stored.list, joint: stored.joint, cfg: stored.cfg, epoch: stored.epoch, progress: stored.progress, acceptedAt: at, ops: stored.ops.map((e) => ({ ...e, at })) }
      }
    } catch (err) {
      this.broken = err instanceof PermitStoreCorrupt ? err.message : `permit store unreadable: ${(err as Error).message}`
      opts.log?.('error', 'permit witness: refusing every request, its record file is not readable', { witness: this.id, error: this.broken })
    }
  }

  /** Whether this witness is refusing everything, and why. */
  brokenReason(): string | null {
    return this.broken
  }

  handle(req: PermitRequest): PermitReply {
    const now = this.opts.clock.now()
    const re = req.type === 'propose' ? req.record.number : 'read'
    if (this.broken) return this.reply(re, false, now, `store-broken: ${this.broken}`, true)
    if (req.type === 'read') return this.reply(re, true, now)
    const j = judge(this.state, this.id, req.record, now, this.opts.params)
    if (!j.ok) return this.reply(re, false, now, j.reason)
    try {
      this.opts.store.save({ held: j.next.held, list: j.next.list, joint: j.next.joint, cfg: j.next.cfg, epoch: j.next.epoch, progress: j.next.progress, ops: j.next.ops.map(plainEntry) })
    } catch (err) {
      // Not durable, so not accepted; the file may now be anything, so stop answering yes.
      this.broken = `save failed: ${(err as Error).message}`
      this.opts.log?.('error', 'permit witness: save failed, refusing until restarted', { witness: this.id, error: this.broken })
      return this.reply(re, false, now, `store-broken: ${this.broken}`, true)
    }
    this.state = j.next
    return this.reply(re, true, now)
  }

  private reply(re: number | 'read', ok: boolean, now: number, reason?: string, hide = false): PermitReply {
    return {
      witness: this.id,
      re,
      ok,
      ...(reason ? { reason } : {}),
      // A broken witness reports nothing it holds: a caller must not count it either way.
      held: hide ? null : this.state.held,
      list: hide ? null : this.state.list,
      joint: hide ? null : this.state.joint,
      cfg: hide ? null : this.state.cfg,
      epoch: hide ? null : this.state.epoch,
      progress: hide ? null : this.state.progress,
      ops: hide ? null : this.state.ops.map(plainEntry),
      grantable: hide ? false : grantable(this.state, this.id, now, this.opts.params),
    }
  }
}

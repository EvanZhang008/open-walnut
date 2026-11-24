/**
 * The stall and retry watchdog of a turn the ACP worker runs through an adapter (codex-acp,
 * OpenCode, Gemini, Pi, ...). The direct Codex client watches its own turns
 * (codex-app-server/connection.ts); both use one policy, engine-turn-watch.ts.
 *
 * The worker feeds it the turn's frames: a retry notice (acpRetryNotice) starts or extends a
 * streak, every other frame is progress, an open tool call stretches the quiet limit, and a
 * permission the person has not answered holds it. Past a limit `watched` rejects with a
 * WalnutTurnStop, which the worker's prompt handler journals as the turn's error (its Walnut
 * words) and its end; then the turn is cancelled at the adapter, and an adapter that does not end
 * it in time is ended and waited for (`cleanup`), so the next message never meets the old turn.
 */
import { TurnWatch, acpRetryNotice, watchTickMs, type TurnVerdict } from '../engine-turn-watch.js'

/** A turn Walnut stopped: read by the worker's prompt handler as `data.walnutError` (codex-app-server/errors.ts). */
export class WalnutTurnStop extends Error {
  readonly data: Record<string, unknown>
  constructor(verdict: TurnVerdict) {
    super(verdict.words)
    this.name = 'WalnutTurnStop'
    this.data = verdict.kind === 'turn_stalled'
      ? { walnutError: 'turn_stalled', walnutWords: verdict.words }
      : { walnutError: 'retry_exhausted', retryKind: verdict.kind, walnutWords: verdict.words }
  }
}

const ENDED_TOOL = new Set(['completed', 'failed'])
/** A tool call update that says the tool runs: an adapter may send only these, never a `tool_call`. */
const RUNNING_TOOL = new Set(['pending', 'in_progress'])
/** How long a cancelled turn may take to end at the adapter before the adapter is ended (as the direct client's interrupt). */
function cancelGraceMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.WALNUT_TURN_CANCEL_GRACE_MS)
  return Number.isFinite(n) && n > 0 ? n : 10_000
}

export interface AdapterTurnHooks {
  env: NodeJS.ProcessEnv
  /** The engine's name for the words. */
  engine(): string
  /** A permission waits on the person. */
  holding(): boolean
  /** Ask the adapter to cancel the turn (ACP session/cancel). */
  cancel(): Promise<unknown>
  /** End the adapter (it did not end the cancelled turn in time), resolving once it is gone. */
  kill(): Promise<unknown>
}

export class AdapterTurnWatch {
  private watch: TurnWatch | null = null
  private openTools = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** The cancel of a stopped turn, while it runs: the next prompt waits for it. */
  cleanup: Promise<void> | null = null

  constructor(private readonly hooks: AdapterTurnHooks) {}

  /** The turn's prompt, rejecting with a WalnutTurnStop when the turn goes past a limit. */
  watched<T>(prompt: Promise<T>): Promise<T> {
    this.end()
    const watch = new TurnWatch()
    this.watch = watch
    this.openTools.clear()
    const settled = prompt.then(() => true as const, () => true as const)
    const stopped = new Promise<never>((_, reject) => {
      this.timer = setInterval(() => {
        if (this.watch !== watch) return
        const verdict = watch.verdict({
          now: Date.now(), itemRunning: this.openTools.size > 0, holding: this.hooks.holding(),
          env: this.hooks.env, engine: this.hooks.engine(),
        })
        if (!verdict) return
        this.end()
        reject(new WalnutTurnStop(verdict))
        const cleanup = this.cancelStopped(settled).finally(() => { if (this.cleanup === cleanup) this.cleanup = null })
        this.cleanup = cleanup
      }, watchTickMs(this.hooks.env))
      this.timer.unref?.()
    })
    void settled.then(() => { if (this.watch === watch) this.end() })
    return Promise.race([prompt, stopped])
  }

  /** One session/update of the live turn. */
  frame(update: unknown): void {
    const watch = this.watch
    if (!watch) return
    const retried = acpRetryNotice(update)
    if (retried) { watch.retried(retried); return }
    // Every other frame is progress: a thought chunk of a long thinking, a plan, a usage update.
    watch.progress()
    const u = update as { sessionUpdate?: unknown; toolCallId?: unknown; status?: unknown }
    if (typeof u.toolCallId !== 'string') return
    const status = String(u.status)
    if (ENDED_TOOL.has(status)) this.openTools.delete(u.toolCallId)
    // A tool_call with no status is pending (ACP's default); an update says so only when it moves.
    else if ((u.sessionUpdate === 'tool_call' && u.status === undefined) || RUNNING_TOOL.has(status)) this.openTools.add(u.toolCallId)
  }

  /** Something of the turn that is no frame (the person answered a permission). */
  progress(): void { this.watch?.progress() }

  /** The turn ended (or the worker goes): nothing more is watched. */
  end(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watch = null
    this.openTools.clear()
  }

  private async cancelStopped(settled: Promise<true>): Promise<void> {
    try { await this.hooks.cancel() } catch { /* the adapter is ended below when the turn stays */ }
    let timer: ReturnType<typeof setTimeout> | undefined
    const ended = await Promise.race([settled, new Promise<false>((res) => { timer = setTimeout(() => res(false), cancelGraceMs(this.hooks.env)) })])
    if (timer) clearTimeout(timer)
    // Resolved only once the adapter is gone: a prompt waiting on this cleanup must never be sent
    // into an adapter that is still dying (it would read as that turn's crash).
    if (ended !== true) await this.hooks.kill()
  }
}

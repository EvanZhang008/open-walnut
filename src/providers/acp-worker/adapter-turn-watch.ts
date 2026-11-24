/**
 * The stall and retry watchdog of a turn the ACP worker runs through an adapter (codex-acp,
 * OpenCode, Gemini, Pi, ...). The direct Codex client watches its own turns
 * (codex-app-server/connection.ts); both use one policy, engine-turn-watch.ts.
 *
 * The worker feeds it the turn's frames: a retry notice (acpRetryNotice) starts or extends a
 * streak, every other frame is progress, an open tool call stretches the quiet limit, and a
 * permission the person has not answered holds it. Past a limit `watched` rejects with a
 * WalnutTurnStop, which the worker's prompt handler journals as the turn's error (its Walnut
 * words) and its end, then `stop` cancels the turn at the adapter and ends an adapter that does
 * not end it in time, so the next message never meets the old turn.
 */
import { TurnWatch, acpRetryNotice, retryKindOf, watchTickMs, type TurnVerdict } from '../engine-turn-watch.js'

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

/** Walnut's own words a stopped turn carries (never the provider's), or undefined. */
export function walnutWordsOf(error: unknown): string | undefined {
  const data = error && typeof error === 'object' ? (error as { data?: unknown }).data : undefined
  const words = data && typeof data === 'object' ? (data as { walnutWords?: unknown }).walnutWords : undefined
  return typeof words === 'string' && words ? words : undefined
}

const ENDED_TOOL = new Set(['completed', 'failed'])
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
  /** End the adapter: it did not end the cancelled turn in time. */
  kill(): void
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
    const notice = acpRetryNotice(update)
    if (notice) { watch.retried(retryKindOf(notice)); return }
    watch.progress()
    const u = update as { sessionUpdate?: unknown; toolCallId?: unknown; status?: unknown }
    if (typeof u.toolCallId !== 'string') return
    if (u.sessionUpdate === 'tool_call') {
      if (!ENDED_TOOL.has(String(u.status))) this.openTools.add(u.toolCallId)
    } else if (u.sessionUpdate === 'tool_call_update' && ENDED_TOOL.has(String(u.status))) {
      this.openTools.delete(u.toolCallId)
    }
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
    if (ended !== true) this.hooks.kill()
  }
}

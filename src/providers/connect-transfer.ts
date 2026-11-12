/**
 * How far the daemon's file has got onto a host during a connect's `upload`
 * step: bytes done of bytes in all, and whether this computer sends them
 * (`upload`) or the host downloads them itself (`download`,
 * daemon-file-fetch.ts). The step's progress bar reads it from the host's
 * status frame (core/hosts/host-status.ts puts it on the active step).
 *
 * Frames are pushed to every open window, so a meter speaks at most once per
 * TRANSFER_NOTIFY_GAP_MS, except for the first number of a transfer and its
 * last (done = total): a bar that starts late or stops short of full reads
 * as stuck.
 */

export type TransferVia = 'upload' | 'download'

export interface ConnectTransfer {
  via: TransferVia
  /** Bytes there so far, 0 to `total`. */
  done: number
  total: number
}

export const TRANSFER_NOTIFY_GAP_MS = 1_000

export interface TransferMeter {
  readonly current: ConnectTransfer | null
  /** A new count; ignored while `active()` says no step shows it, or for a total that is no size. */
  report(via: TransferVia, done: number, total: number): void
  /** The transfer ended (or its step did): nothing to show. Says nothing by itself. */
  clear(): void
}

export function createTransferMeter(deps: {
  /** Whether a step shows a transfer now (the connection is in its `upload` step). */
  active: () => boolean
  /** Push the host's frame again. */
  notify: () => void
  now?: () => number
}): TransferMeter {
  const now = deps.now ?? Date.now
  let current: ConnectTransfer | null = null
  let lastAt = Number.NEGATIVE_INFINITY
  return {
    get current() { return current },
    report(via, done, total) {
      if (!deps.active() || !Number.isFinite(total) || total <= 0) return
      const next: ConnectTransfer = { via, done: Math.max(0, Math.min(total, Math.floor(Number.isFinite(done) ? done : 0))), total: Math.floor(total) }
      const fresh = !current || current.via !== next.via || current.total !== next.total
      if (!fresh && current!.done === next.done) return
      current = next
      const t = now()
      if (!fresh && next.done < next.total && t - lastAt < TRANSFER_NOTIFY_GAP_MS) return
      lastAt = t
      deps.notify()
    },
    clear() { current = null },
  }
}

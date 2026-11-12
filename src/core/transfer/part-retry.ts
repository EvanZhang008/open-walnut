/**
 * What a failed part of a file written onto a host in parts (fs.writePart) means, in ONE place:
 * the relay between two hosts (relayFile) and a file this server writes onto a host
 * (writeFileInParts) both ask it. A part is offset-idempotent on the receiver (transfer-core.ts):
 * a part sent again at the same offset rewrites the same bytes, and a `gap` answer names `have`,
 * where the next part resumes.
 *
 *  - a refusal that retrying gets again (FINAL_CODES), an old daemon, or this server's own stop:
 *    final;
 *  - inside a link wait (link-wait.ts, a task move): a link that dropped under a part, was not
 *    there for it, or gave no answer in the part's window, is waited out and never counted as a
 *    failed part, until the wait's bound passes with no part acknowledged; and each part that may
 *    have gone up is followed by one a quarter of its size (a final part stays final), so a part
 *    fits in a link that keeps being cut (2026-11-12: a 1 MB part takes 50 s or
 *    more on the paced bulk link to a dev host at 20 KB/s; a read waiting behind it timed out and
 *    ended that link, about every 90 s, so the same part was cut again and again for 10 minutes and
 *    a task move failed on "daemon command lost: fs.writePart");
 *  - anything else: retried `tries` times in a row.
 */
import { log } from '../../logging/index.js'
import { DaemonNeedsUpgradeError } from '../daemon-file-reader.js'
import { ServerStoppingError } from '../server-stopping.js'
import { linkFailureKind } from '../../providers/link-failure.js'
import { awakeStopwatch, currentLinkWait, linkPollMs } from './link-wait.js'
import { TransferCommandError, TransferHostOfflineError } from './transfer-errors.js'

/** A refusal from either daemon (not a dropped link): retrying gets the same answer. */
export const FINAL_CODES = ['size_mismatch', 'checksum_mismatch', 'source_changed', 'read_failed', 'bad_request', 'too_large',
  // A private stage's refusals: retrying gets the same answer.
  'not_owner', 'not_supported', 'topology_unknown', 'not_private_path', 'root_unsafe', 'stage_changed',
  'stage_foreign', 'stage_incomplete', 'target_exists']

/** The smallest part a cut link shrinks a part to. */
export const MIN_PART_BYTES = 64 * 1024
/** Parts acknowledged in a row before a shrunk part doubles again. */
const GROW_AFTER = 8

export interface PartRetry {
  /** How many bytes the next part carries. */
  readonly size: number
  /** Parts sent again so far. */
  readonly retries: number
  /** The part was acknowledged. */
  ok(): void
  /**
   * The part at `offset` failed with `err`: the offset to go on from, or `err` (or the last error)
   * thrown. `sent`: the part was the file's final one, ending at `end`; `jump` when the caller may
   * send a final part from a later offset (it knows the file's sha256 and passes no bytes on).
   */
  next(err: unknown, offset: number, sent?: { final: boolean; end: number; jump: boolean }): Promise<number>
}

export function partRetry(opts: { host: string; path: string; size: number; tries: number; delayMs: number }): PartRetry {
  const wait = currentLinkWait()
  const tries = Math.max(1, opts.tries)
  const full = Math.max(1, opts.size)
  let size = full
  let retries = 0
  let failures = 0
  let inRow = 0
  // Awake time since the first part of a run of cut ones (a sleep never uses the bound up).
  let lostFor: { ms(): number } | undefined
  let last: unknown = null
  return {
    get size() { return size },
    get retries() { return retries },
    ok() {
      failures = 0
      lostFor = undefined
      if (size < full && ++inRow >= GROW_AFTER) { size = Math.min(full, size * 2); inRow = 0 }
    },
    async next(err, offset, sent) {
      let at = offset
      if (err instanceof TransferCommandError && err.command === 'fs.writePart' && err.code === 'gap') {
        // The receiver lost bytes (a restart, a cleared staging file): resume where it stands.
        const have = Number(err.data.have)
        at = Number.isFinite(have) && have >= 0 && have < offset ? have : 0
      } else if ((err instanceof TransferCommandError && FINAL_CODES.includes(err.code)) || err instanceof DaemonNeedsUpgradeError
        // This server is stopping: no retry gets a link back.
        || err instanceof ServerStoppingError) {
        throw err
      }
      last = err
      retries++
      const kind = linkFailureKind(err)
      // Offline inside a wait: the command already waited the whole bound for a link.
      if (wait && err instanceof TransferHostOfflineError) throw err
      if (wait && (kind === 'no-link' || kind === 'lost' || kind === 'no-answer')) {
        lostFor ??= awakeStopwatch()
        if (lostFor.ms() > wait.ms) throw last
        inRow = 0
        // A part that may have gone up (lost, or no answer in its window: a big part on a paced
        // link) is followed by a smaller one. A final part stays final: it may have finished the
        // file there, and only a final part ending at the file's end finds that out (the receiver
        // answers done, or gap with what it holds), never a part that starts the file over.
        if (kind !== 'no-link' && (!sent?.final || sent.jump)) {
          size = Math.max(Math.min(MIN_PART_BYTES, full), Math.floor(size / 4))
          if (sent?.final) at = Math.max(at, sent.end - size)
        }
        log.session.info('transfer: the link dropped under a part; it goes again once the link is back', {
          host: opts.host, path: opts.path, offset: at, kind, partBytes: size, waitedMs: Math.round(lostFor.ms()),
        })
        // The next try finds the link back (the client waits for it) and resumes from the receiver's bytes.
        await new Promise((r) => setTimeout(r, linkPollMs()))
        return at
      }
      failures++
      // A receiver that keeps losing what it took would loop forever on gaps alone.
      if (failures >= tries || retries > tries * 10) throw last
      if (opts.delayMs > 0) await new Promise((r) => setTimeout(r, opts.delayMs))
      return at
    },
  }
}

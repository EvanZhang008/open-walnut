/**
 * ONE compaction is ONE timeline row.
 *
 * Why this is a module and not three inlined `if`s: the CLI re-emits
 * `status: compacting` every 30 SECONDS for the whole compaction as a TRANSPORT
 * KEEP-ALIVE, not as an event (claude-code `services/compact/compact.ts`:
 * `setInterval(… setSDKStatus('compacting'), 30_000)`, added so a remote
 * WebSocket doesn't judge the session idle). A real auto-compaction of a
 * large-window session measurably runs 147-539s, so one compaction emits up to
 * ~18 of those lines. Rendering each as a row is the 2026-09-18 report: five
 * identical "Compacting context..." lines stacked above one result, collapsed
 * behind an opaque "6 system messages".
 *
 * A replayed stream tail multiplies them again: daemon reattach replays
 * [fromOffset, end) of the stream file, and system lines carry no dedup key
 * (only text/tool_use do).
 *
 * The rule: the progress line is a PLACEHOLDER. Repeats collapse into the one
 * already on screen, and the boundary REPLACES it in place — so the reader sees
 * a single row that turns into its own outcome, at the position where the
 * compaction actually happened.
 *
 * Kept in `src/core/` and aliased into the web bundle (`@open-walnut/compaction-notice`)
 * because the browser reducer and the server-side stream buffer are twins: a rule
 * only one of them applies reappears as an artifact on reload.
 */

/** Progress line: the CLI is compacting. Carries no numbers — `pre_tokens` only
 *  exists on the boundary. */
export const COMPACTING_MESSAGE = 'Compacting context...'

/** Outcome line: the compaction landed. Numbers ride in the detail. */
export const COMPACTED_MESSAGE = 'Context compacted'

/** `compact_metadata`, either dialect. Canonical JSONL uses camelCase
 *  (`compactMetadata.preTokens`); the CLI's stream-json stdout — what the daemon
 *  stream files hold — uses snake_case (`compact_metadata.pre_tokens`). */
export interface CompactionMetadata {
  trigger?: string
  preTokens?: number
  postTokens?: number
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`
}

/**
 * How much context the compaction moved, labelled. A bare "444K" reads like a
 * percentage — the other half of the same report ("is it actually showing
 * percentage or what"). Both ends make the row self-explanatory: 444K of context
 * became 45K.
 */
function compactedSize(meta: CompactionMetadata | undefined): string | undefined {
  const pre = meta?.preTokens
  const post = meta?.postTokens
  if (pre && post) return `${formatTokens(pre)} → ${formatTokens(post)} tokens`
  if (pre) return `${formatTokens(pre)} tokens`
  if (post) return `down to ${formatTokens(post)} tokens`
  return undefined
}

/** "auto" is worth saying — it means the user didn't ask for this. A manual
 *  /compact needs no label: they just typed it. */
function triggerLabel(meta: CompactionMetadata | undefined): string {
  return meta?.trigger === 'auto' ? ' · auto' : ''
}

/** The live row's second span (the greyed detail beside "Context compacted"). */
export function compactedDetail(meta: CompactionMetadata | undefined): string | undefined {
  const size = compactedSize(meta)
  const trigger = triggerLabel(meta)
  // With no numbers there is nothing for the separator to separate, so the bare
  // word carries the detail span on its own.
  if (!size) return trigger ? 'auto' : undefined
  return `${size}${trigger}`
}

/** History renders ONE text string per system row (there is no separate detail
 *  field), so the reloaded row must read the same as the live one. */
export function compactedHistoryText(meta: CompactionMetadata | undefined): string {
  const size = compactedSize(meta)
  return `${COMPACTED_MESSAGE}${size ? ` (${size})` : ''}${triggerLabel(meta)}`
}

/** How many compaction line uuids one session remembers. A long-lived session
 *  compacts dozens of times; the set only has to outlive a replayed tail. */
const SEEN_LINE_LIMIT = 500

/**
 * True the first time this compaction line is seen — the replay guard system
 * lines never had (text and tool_use dedup by id; system lines did not, so a
 * reattach's replayed tail re-emitted every one of them).
 *
 * Bounded FIFO, mutating the caller's set. A line with NO uuid (older CLI, ACP
 * dialect) cannot be tracked, so it always counts as new; the per-episode gate on
 * the emitter still collapses its repeats.
 */
export function firstSightingOfLine(seen: Set<string>, uuid: unknown): boolean {
  if (typeof uuid !== 'string' || uuid.length === 0) return true
  if (seen.has(uuid)) return false
  if (seen.size >= SEEN_LINE_LIMIT) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  seen.add(uuid)
  return true
}

/** The incoming notice. `progress` marks the placeholder. */
export interface SystemRow {
  variant: string
  message: string
  detail?: string
  progress?: boolean
}

/**
 * A timeline entry as this rule sees it. Every field is optional so BOTH twins can
 * pass their whole block array unchanged: a text or tool_call block simply has no
 * `variant`, which is exactly why it can never match a compaction row — and that
 * keeps the returned index a real index into the caller's array. (`type` is listed
 * only so those blocks share a property with this shape; TS rejects a weak type
 * with nothing in common.)
 */
export interface TimelineRow {
  type?: string
  variant?: string
  message?: string
  detail?: string
  progress?: boolean
}

function isCompactionProgress(row: TimelineRow): boolean {
  return row.variant === 'compact' && row.progress === true
}

function lastCompactionProgressIndex(rows: readonly TimelineRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row && isCompactionProgress(row)) return i
  }
  return -1
}

export type SystemRowPlacement =
  | { action: 'append' }
  | { action: 'drop' }
  | { action: 'replace'; index: number }

/**
 * Where an incoming system notice goes, given the rows already on screen.
 *
 * Only compaction rows collapse. Two API errors are two facts and must both
 * render — folding any repeated system message by text would hide the second
 * failure of a retry loop.
 *
 * @param rows  the caller's WHOLE timeline, in order. Any index returned is an
 *              index into it.
 */
export function placeSystemRow(
  rows: readonly TimelineRow[],
  incoming: SystemRow,
): SystemRowPlacement {
  if (incoming.variant !== 'compact') return { action: 'append' }

  const last = rows[rows.length - 1]

  if (isCompactionProgress(incoming)) {
    // A placeholder is already up: this is the 30s keep-alive, or a replay of
    // the line that put it there. Either way it says nothing new.
    if (lastCompactionProgressIndex(rows) >= 0) return { action: 'drop' }
    // The compaction it announces has ALREADY finished — a reattach replays
    // [status, boundary] in order, and the boundary consumed the placeholder the
    // first time round. A genuinely new compaction cannot start here: the context
    // was just emptied, so the model always produces something first.
    if (last && last.variant === 'compact' && !last.progress) return { action: 'drop' }
    return { action: 'append' }
  }

  // An outcome. Turn the open placeholder into it, in place.
  //
  // Replacement is deliberate even when model output has landed since — which
  // only happens if a CLI died mid-compaction and never reported its boundary.
  // Consuming that stale row puts the outcome one screen too early; LEAVING it
  // would keep a permanent "Compacting context..." in the transcript, claiming
  // work that stopped hours ago. A wrong-by-a-screen fact beats a standing lie,
  // and either way no model output moves: the swap is same-index, so the array
  // length (and with it every render identity) is unchanged.
  const placeholder = lastCompactionProgressIndex(rows)
  if (placeholder >= 0) return { action: 'replace', index: placeholder }

  // No placeholder left to consume. A boundary identical to the row that is
  // already last is the same boundary replayed — two REAL compactions always
  // have the model's continuation between them, and never the same token counts.
  if (last && last.variant === 'compact' && !last.progress
    && last.message === incoming.message && last.detail === incoming.detail) {
    return { action: 'drop' }
  }
  return { action: 'append' }
}

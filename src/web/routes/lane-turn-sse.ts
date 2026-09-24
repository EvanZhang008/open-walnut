/**
 * Translate one lane turn's session bus events into the frozen v1 chat SSE frames.
 *
 * Two turn runners need exactly this translation, which is why it lives here and
 * not inside either of them:
 *   - the primary's ordinary REST turn (api-v1.ts `runApiV1LaneTurn`), and
 *   - the cloud companion's own fallback turn (cloud-chat-fallback.ts), which runs
 *     when the primary provably cannot receive the turn.
 * A phone reads both through the same client code, so the two must emit the same
 * frames under the same rules. Two copies is how one of them silently drifts.
 *
 * The mapping:
 *   - `session:text-delta`     → `text-delta`. Feeds the client's inactivity watchdog
 *     and paints the live bubble during a multi-minute turn; the SSE channel's own
 *     25s comment ping is transport-level only and carries no event.
 *   - `session:tool-use`       → `tool`, `session:tool-result` → `tool-result`,
 *     `session:thinking-delta` → `thinking`. Relaying only text is what made a lane
 *     turn look like a blinking "Thinking…" with no tool ever named.
 */

import { bus, EventNames } from '../../core/event-bus.js'
import { toolDetail, toolResultPreview, toolInputPreview } from '../../core/tool-summary.js'

/** Emit one frame on the conversation's SSE channel. */
export type LaneFrameEmitter = (event: string, data: unknown) => void

export interface LaneTurnFrameRelay {
  /** Bind the relay to the lane session the turn runs on (known only once it resolves). */
  setSessionId: (sessionId: string) => void
  /** The turn is over: flush the reasoning tail, then relay nothing more. Call
   *  BEFORE emitting the terminal frame. */
  settle: () => void
  /** Drop timers and the bus subscription. Emits nothing. */
  dispose: () => void
}

/**
 * Thinking deltas arrive at TOKEN rate with urgency:'urgent', and the channel fans
 * out to every open client (plus the bridge mirror, and the 512-event replay ring,
 * which a raw token stream would blow through, evicting this turn's own
 * message-start from what a reconnect replays). The client buffers deltas at the
 * same cadence anyway (ChatStore.appendDelta), so batching here is invisible to it
 * and cheap for everyone: one trailing window per burst, flushed on turn end.
 */
const THINKING_FLUSH_MS = 120

/**
 * Subscribe BEFORE the lane resolves, then bind with `setSessionId`: subscribing
 * first means no delta of this turn can slip through the gap.
 *
 * Interest-scoped global subscription (the pattern every session-event consumer
 * uses): session events are addressed to 'main-ai'/'session-runner', and without
 * `interest` this handler would wake on every event in the process.
 */
export function subscribeLaneTurnFrames(subName: string, emit: LaneFrameEmitter): LaneTurnFrameRelay {
  let laneSessionId: string | null = null

  let thinkingBuf = ''
  let thinkingTimer: NodeJS.Timeout | null = null
  const flushThinking = (): void => {
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null }
    if (!thinkingBuf) return
    const delta = thinkingBuf
    thinkingBuf = ''
    emit('thinking', { delta })
  }

  // Set just before this turn's terminal frame. Nothing may be relayed after it:
  // iOS finalizes the turn on `message-end`, so a later frame would leave its
  // activity line lit on a finished turn, and it would also sit in the replay
  // ring AFTER the terminal frame, which is the shape that once re-materialized a
  // previous answer as a permanent duplicate on reconnect. One rule for all four
  // kinds on purpose. (A trailing delta after the CLI's result line is normal.)
  let turnSettled = false

  // toolUseIds whose `tool` frame this turn actually put on the wire. A
  // `tool-result` means "clear the activity line for THIS id", so one whose `tool`
  // frame was dropped (a subagent's, a replayed one, one that arrived before the
  // lane id resolved) is an instruction about a line the client never drew.
  // Relaying only known ids makes the pair symmetric: every drop rule below
  // automatically applies to the result too.
  const relayedToolUseIds = new Set<string>()

  bus.subscribe(subName, (event) => {
    const d = event.data as {
      sessionId?: string; delta?: string; parentToolUseId?: string; replayed?: boolean
      toolName?: string; toolUseId?: string; input?: unknown; result?: string
    }
    if (turnSettled) return
    // Own lane only, and never a `replayed` event (JSONL history being re-read,
    // not this turn happening). Identical gate for all four event kinds.
    if (laneSessionId === null || d.sessionId !== laneSessionId || d.replayed) return
    // `parentToolUseId` = a SUBAGENT's nested activity. Dropped for every kind:
    // this channel drives ONE activity line for the main turn, and a subagent's
    // tools would overwrite "Task (investigate the crash)" with whatever the
    // delegate happens to be reading, hiding the one fact the human needs.
    // Thinking deltas never carry the field (stream_event lines have no
    // parent_tool_use_id), so that kind is unaffected by this rule today.
    if (d.parentToolUseId) return
    switch (event.name) {
      case EventNames.SESSION_TEXT_DELTA: {
        if (!d.delta) return
        emit('text-delta', { delta: d.delta })
        return
      }
      case EventNames.SESSION_THINKING_DELTA: {
        if (!d.delta) return
        thinkingBuf += d.delta
        if (!thinkingTimer) {
          thinkingTimer = setTimeout(flushThinking, THINKING_FLUSH_MS)
          thinkingTimer.unref?.()
        }
        return
      }
      case EventNames.SESSION_TOOL_USE: {
        if (!d.toolName) return
        // A tool starting ENDS the reasoning burst it followed: flush first so the
        // frames stay in causal order on a channel the client reads as a sequence.
        flushThinking()
        const input = d.input as Record<string, unknown> | undefined
        // `detail` is the collapsed one-liner (Bash prefers `description`, so the
        // command itself never reached the phone). `inputPreview` is the same
        // bounded, masked `key: value` render the history row carries.
        const detail = toolDetail(d.toolName, input)
        const inputPreview = toolInputPreview(input)
        if (d.toolUseId) relayedToolUseIds.add(d.toolUseId)
        emit('tool', {
          name: d.toolName,
          ...(d.toolUseId ? { toolUseId: d.toolUseId } : {}),
          ...(detail ? { detail } : {}),
          ...(inputPreview ? { inputPreview } : {}),
        })
        return
      }
      case EventNames.SESSION_TOOL_RESULT: {
        if (!d.toolUseId) return
        // Only an id this turn announced. `delete` rather than `has`: it also
        // makes a repeated result frame a no-op, and keeps the set from outliving
        // the tools it describes.
        if (!relayedToolUseIds.delete(d.toolUseId)) return
        // Bounded three times over: the emitter caps the bus event at 2000
        // characters, `toolResultPreview` clips to 700 plus an ellipsis, and it
        // masks with the same rule the history row uses. The FULL text never
        // rides this channel; it is only reachable through the row's detailRef.
        const resultPreview = toolResultPreview(d.result)
        emit('tool-result', {
          toolUseId: d.toolUseId,
          ...(resultPreview ? { resultPreview } : {}),
        })
        return
      }
      default:
        return
    }
  }, {
    global: true,
    interest: [
      EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_THINKING_DELTA,
      EventNames.SESSION_TOOL_USE, EventNames.SESSION_TOOL_RESULT,
    ],
  })

  return {
    setSessionId: (sessionId) => { laneSessionId = sessionId },
    settle: () => {
      // Hand the client the reasoning tail BEFORE any terminal frame, then stop.
      flushThinking()
      turnSettled = true
    },
    dispose: () => {
      // Discard, never emit: by here the terminal frame is already out. Clearing
      // the timer matters on its own, since a pending one keeps this closure alive.
      if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null }
      thinkingBuf = ''
      turnSettled = true
      bus.unsubscribe(subName)
    },
  }
}

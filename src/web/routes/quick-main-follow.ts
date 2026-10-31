/**
 * Main's reply to one message from the quick box, read off the event bus: what Main writes after
 * the message reached its CLI, until the turn that answers it ends.
 *
 * A launcher used to open Main's session stream and take the first turn end after it sent. That
 * read the wrong turn twice over: opening the stream asks for a Brief refresh turn on an org node
 * (session-stream-v1.ts), and a message that waits for a running turn to end is answered by the
 * NEXT turn. So the reply is matched the way core/sessions/lane-turn.ts matches a lane turn: the
 * delivery event names the message and the generation of the turn that answers it, and only a
 * result of that generation or later closes the reply. Subscribed before the send, so a hot CLI
 * that answers in the same tick is not missed.
 *
 * A message sent while Main is in a turn is counted as joining that turn, but the CLI often
 * answers it with a turn of its own right after (seen 2026-10-31: the second message's words came
 * in a second result 4 s after the first). So when the send found Main working, the end of the
 * running turn is held for MID_TURN_NEXT_MS: a new turn starting in that time is the reply, and a
 * `reset` line tells the client to drop the words it showed so far.
 */

import { bus, EventNames, type BusEvent } from '../../core/event-bus.js'
import { toolDetail } from '../../core/tool-summary.js'

/** A follow that sees no end in this long stops; the reply is still in Main's chat. */
export const MAIN_FOLLOW_MAX_MS = 15 * 60_000
const EARLY_MAX = 400
/** How long the end of a turn the message may only have queued behind waits for the next turn. */
export const MID_TURN_NEXT_MS = 2_500

export type FollowLine =
  | { type: 'text'; delta: string }
  | { type: 'reset' }
  | { type: 'activity'; detail: string }
  | { type: 'result'; text: string; unfinished?: true }
  | { type: 'error'; code: string; message: string }

export interface MainFollower {
  /** The send went out: follow `sessionId`. `fresh` = the message started this session, so its
   *  first turn is the message's own. `midTurn` = Main was in a turn when the message went in. */
  bind(sessionId: string, opts: { messageId?: string; fresh?: boolean; midTurn?: boolean }): void
  stop(): void
}

let nextId = 0

export function followMainReply(
  onLine: (line: FollowLine) => void,
  onEnd: () => void,
  maxMs = MAIN_FOLLOW_MAX_MS,
): MainFollower {
  const subName = `quick-main-follow-${process.pid}-${++nextId}`
  let sid: string | null = null
  let messageId: string | undefined
  let delivered = false
  let gen: number | undefined
  let text = ''
  let over = false
  let midTurn = false
  /** The running turn ended; waiting MID_TURN_NEXT_MS to see whether the next one is the reply. */
  let held: { timer: ReturnType<typeof setTimeout>; last: FollowLine } | null = null
  const early: BusEvent[] = []

  const finish = (last?: FollowLine) => {
    if (over) return
    over = true
    clearTimeout(timer)
    if (held) clearTimeout(held.timer)
    bus.unsubscribe(subName)
    if (last) onLine(last)
    onEnd()
  }

  /** A turn started after the held end: it is the reply, so the words shown so far go. */
  const nextTurnStarted = () => {
    if (!held) return
    clearTimeout(held.timer)
    held = null
    midTurn = false
    gen = undefined
    text = ''
    onLine({ type: 'reset' })
  }

  const consider = (event: BusEvent) => {
    const d = event.data as Record<string, unknown>
    if (d.sessionId !== sid) return
    if (held && event.name === EventNames.SESSION_STATUS_CHANGED && d.process_status === 'running'
      && event.source !== 'daemon-reconnect' && event.source !== 'session-tracker') {
      nextTurnStarted()
      return
    }
    if (held && !d.parentToolUseId && (event.name === EventNames.SESSION_TEXT_DELTA || event.name === EventNames.SESSION_TOOL_USE)) {
      nextTurnStarted()
    }
    switch (event.name) {
      case EventNames.SESSION_MESSAGES_DELIVERED: {
        if (delivered) return
        const ids = Array.isArray(d.messageIds) ? d.messageIds : undefined
        // Older emitters name no ids: the first delivery after the send is taken as ours.
        if (messageId && ids && !ids.includes(messageId)) return
        delivered = true
        gen = typeof d.turnGen === 'number' ? d.turnGen : undefined
        return
      }
      case EventNames.SESSION_TEXT_DELTA: {
        if (!delivered || d.parentToolUseId) return
        const delta = typeof d.delta === 'string' ? d.delta : ''
        if (!delta) return
        text += delta
        onLine({ type: 'text', delta })
        return
      }
      case EventNames.SESSION_TOOL_USE: {
        if (!delivered || d.parentToolUseId) return
        const name = typeof d.toolName === 'string' ? d.toolName : ''
        if (!name) return
        const input = d.input && typeof d.input === 'object' ? d.input as Record<string, unknown> : undefined
        onLine({ type: 'activity', detail: toolDetail(name, input) || name })
        return
      }
      case EventNames.SESSION_RESULT: {
        if (!delivered) return
        // A result of a turn older than the one that took the message is an earlier turn's.
        if (gen !== undefined && typeof d.turnGen === 'number' && d.turnGen < gen) return
        if (d.isError === true) {
          finish({ type: 'error', code: 'turn_failed', message: typeof d.result === 'string' && d.result ? d.result : 'Main\'s turn failed' })
          return
        }
        if (held) return
        const result = typeof d.result === 'string' ? d.result : ''
        // The streamed words when there were any (the result is only the turn's last message).
        const last: FollowLine = { type: 'result', text: text.trim() ? text : result }
        if (midTurn) {
          held = { timer: setTimeout(() => finish(last), MID_TURN_NEXT_MS), last }
          held.timer.unref?.()
          return
        }
        finish(last)
        return
      }
      case EventNames.SESSION_ERROR: {
        if (!delivered) return
        finish({ type: 'error', code: 'session_error', message: typeof d.error === 'string' ? d.error : 'Main\'s session failed' })
        return
      }
    }
  }

  bus.subscribe(subName, (event) => {
    if (over) return
    if (sid === null) {
      if (early.length < EARLY_MAX) early.push(event)
      return
    }
    consider(event)
  }, {
    global: true,
    interest: [
      EventNames.SESSION_MESSAGES_DELIVERED, EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_TOOL_USE,
      EventNames.SESSION_RESULT, EventNames.SESSION_ERROR, EventNames.SESSION_STATUS_CHANGED,
    ],
  })

  const timer = setTimeout(() => finish({ type: 'result', text, unfinished: true }), maxMs)
  timer.unref?.()

  return {
    bind(sessionId, opts) {
      if (over || sid !== null) return
      sid = sessionId
      messageId = opts.messageId
      midTurn = !!opts.midTurn && !opts.fresh
      if (opts.fresh) delivered = true
      for (const event of early.splice(0)) {
        if (over) break
        consider(event)
      }
    },
    stop() { finish() },
  }
}

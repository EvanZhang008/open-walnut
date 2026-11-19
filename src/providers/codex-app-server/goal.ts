/**
 * A thread goal (`/goal`, commands.ts) as Codex runs it: `thread/goal/set` with status
 * active, and Codex starts the goal's turn itself, then another each time one ends,
 * until the model marks the goal complete (or it is paused or cleared). Seen with Codex
 * 0.170: turn/completed and the next turn/started come back to back.
 *
 * Here those turns are ONE Walnut turn, so the person sees the work and can stop it:
 * the turn goes on while the goal is active and Codex starts a next turn within
 * NEXT_TURN_GRACE_MS of the last one's end; a goal Codex did not start a turn for gets
 * one from us (the adapter's continuation prompt). A stop pauses the goal first, or
 * Codex would start the next turn behind it. A turn Codex starts while no Walnut turn
 * is open (a resumed thread goes on with its active goal at once, seen with Codex 0.170)
 * would run unseen, so its goal is paused and the turn interrupted; `/goal resume` goes on.
 *
 * A goal the model believes done but never marks complete runs forever: Codex starts turn
 * after turn and each one says the same words (2026-11-19, real Codex 0.170: 28 turns of
 * "the goal is complete" in a minute). REPEAT_LIMIT turns in a row with the same answer
 * pause it.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** How long a goal's next Codex turn may take to start before the Walnut turn ends. */
export const NEXT_TURN_GRACE_MS = 2_000
/** codex-acp's words for a goal turn Codex did not start itself. */
export const GOAL_CONTINUATION_TEXT = 'Continue working toward the active goal.'
/** Goal turns in a row with the same answer that pause the goal. */
export const REPEAT_LIMIT = 3
export const REPEAT_PAUSED_TEXT =
  `The goal is paused: Codex answered the same way ${REPEAT_LIMIT} turns in a row without finishing it. `
  + '`/goal` shows it, `/goal resume` goes on, `/goal clear` ends it.'

/** The words of the last agent message in a completed turn's items. */
function lastAnswer(items: unknown): string {
  if (!Array.isArray(items)) return ''
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') return item.text.trim()
  }
  return ''
}

export class CodexGoalState {
  /** The thread's goal is active: Codex goes on with it after each turn. */
  active = false

  /** Reads thread/goal/updated and thread/goal/cleared; true when it was one of them. */
  note(method: string, params: Record<string, unknown>): boolean {
    if (method === 'thread/goal/cleared') { this.active = false; return true }
    if (method !== 'thread/goal/updated') return false
    if (isRecord(params.goal)) this.active = params.goal.status === 'active'
    return true
  }

  private lastText = ''
  private repeats = 0

  /** A goal turn ended: true when it is the REPEAT_LIMIT-th in a row with the same answer. */
  repeated(turn: Record<string, unknown>): boolean {
    const text = lastAnswer(turn.items)
    this.repeats = text && text === this.lastText ? this.repeats + 1 : 1
    this.lastText = text
    return this.repeats >= REPEAT_LIMIT
  }

  /** A new goal or a resume starts the count again. */
  restart(): void { this.lastText = ''; this.repeats = 0 }

  /** thread/goal/set's answer. */
  adopt(resp: unknown): void {
    if (isRecord(resp) && isRecord(resp.goal)) this.active = resp.goal.status === 'active'
  }
}

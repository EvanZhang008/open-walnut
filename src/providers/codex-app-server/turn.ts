/**
 * One Walnut turn of a direct Codex session (connection.ts). It is usually one Codex
 * turn, and more when Codex ended a turn without answering what it took into it:
 *
 * - a steer Codex took (its userMessage item) after the model's last output is not
 *   answered in that turn: the turn goes on as a new Codex turn with those words
 *   (real Codex 0.167: a steer at the end of a turn is recorded and never answered);
 * - a plan approved in plan mode goes on with "Implement the approved plan.".
 *
 * A review runs as a child Codex turn under the id review/start answered with (its
 * `rootTurnId`); both ids are this turn's.
 */

export interface TurnResult { stopReason: string; usage?: Record<string, number> }

/** Items that are not the model's answer: a steer before them is still unanswered. */
const NOT_OUTPUT = new Set(['userMessage', 'hookPrompt', 'enteredReviewMode', 'contextCompaction', 'sleep'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function userMessageText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content.filter(isRecord) : []
  return content.map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('')
}

/**
 * An input of a Codex turn's own start: its words and the client id sent with it
 * (`clientUserMessageId`, which Codex reports back as the userMessage item's `clientId`), or
 * `null` when Codex words it itself (a review).
 */
export type OwnInput = { text: string; clientId: string } | null

export class LiveTurn {
  /** The Codex turn's id (review/start's or turn/start's answer wins over an event's). */
  id: string | undefined
  /** Other ids of this turn's Codex turns (a review's child turn). */
  readonly aliases = new Set<string>()
  started!: Promise<string | undefined>
  private markStartedFn!: (id: string | undefined) => void
  readonly done: Promise<TurnResult>
  private resolveFn!: (r: TurnResult) => void
  private rejectFn!: (e: Error) => void
  /** Resolves once the turn is settled, however it ended. */
  readonly ended: Promise<true>
  private markEndedFn!: () => void
  lastEventAt = Date.now()
  usage?: Record<string, number>
  settled = false
  /** The text of every user input Codex reported in this turn (its own and each steer it took). */
  readonly userTexts: string[] = []
  /** Inputs Codex took after the model's last output: unanswered so far. */
  unanswered: string[] = []
  /**
   * Inputs of the Codex turn's own start not reported yet (they are not steers). A report is
   * matched by its client id; a Codex that reports none is matched by the words, and an input
   * Codex words itself (a review's) by order. A steer's report can come before the start's own.
   */
  private ownInputs: OwnInput[]
  /** Client ids of the user inputs Codex reported in this turn: the proof a steer was taken. */
  readonly reportedIds = new Set<string>()
  /** Words of the user inputs Codex reported with no client id (a Codex that sends none). */
  readonly unidentifiedTexts: string[] = []
  /** Codex turns started after the first one; also the generation of the current start. */
  continuations = 0
  /** The plan item this Codex turn completed (plan mode). */
  plan: { id: string; text: string } | undefined
  /** Waiting on the person (the plan question). */
  holding = false
  /** A stop is on its way: the turn ends at its next end, with no follow-up or plan question. */
  stopping = false
  /** Codex ended it and its end is being recorded (connection.ts endTurn): it takes nothing more. */
  ending = false
  private userTextWaiters = new Set<() => void>()

  constructor(ownInputs: OwnInput[]) {
    this.ownInputs = [...ownInputs]
    this.done = new Promise<TurnResult>((res, rej) => { this.resolveFn = res; this.rejectFn = rej })
    this.ended = new Promise<true>((res) => { this.markEndedFn = () => res(true) })
    this.done.catch(() => {})
    this.newStart()
  }

  private newStart(): void {
    this.started = new Promise<string | undefined>((res) => { this.markStartedFn = res })
  }

  markStarted(id: string | undefined): void { this.markStartedFn(id) }

  /** An id Codex answered with: it wins, and an id read before it stays this turn's. */
  adoptId(id: string): void {
    if (this.id && this.id !== id) this.aliases.add(this.id)
    this.id = id
  }

  owns(turnId: string): boolean { return turnId === this.id || this.aliases.has(turnId) }

  /** Every id this turn had (to retire once it moves on or ends). */
  ids(): string[] { return [...(this.id ? [this.id] : []), ...this.aliases] }

  /** The same Walnut turn goes on as a new Codex turn; returns the ids the last one had. */
  continueAs(ownInputs: OwnInput[]): string[] {
    const old = this.ids()
    this.id = undefined
    this.aliases.clear()
    this.unanswered = []
    this.ownInputs = [...ownInputs]
    this.plan = undefined
    this.continuations++
    this.newStart()
    return old
  }

  noteItemStarted(item: Record<string, unknown>): void {
    if (item.type === 'userMessage') {
      const text = userMessageText(item)
      const clientId = typeof item.clientId === 'string' && item.clientId ? item.clientId : undefined
      this.userTexts.push(text)
      if (clientId) this.reportedIds.add(clientId)
      else this.unidentifiedTexts.push(text)
      // Every input this client sends carries an id, so a reported id names it exactly.
      let own = clientId
        ? this.ownInputs.findIndex((o) => o?.clientId === clientId)
        : this.ownInputs.findIndex((o) => o?.text === text)
      if (own === -1 && !clientId) own = this.ownInputs.indexOf(null)
      if (own !== -1) this.ownInputs.splice(own, 1)
      else this.unanswered.push(text)
      for (const wake of [...this.userTextWaiters]) wake()
      return
    }
    if (typeof item.type === 'string' && !NOT_OUTPUT.has(item.type)) this.unanswered = []
  }

  /**
   * Resolves once `taken()` holds (checked at each user input Codex reports), or never.
   * `onTaken` runs at that report, before any later event of Codex's is handled.
   */
  whenUserText(taken: () => boolean, onTaken?: () => void): { seen: Promise<void>; dispose: () => void } {
    let wake!: () => void
    const seen = new Promise<void>((res) => {
      wake = () => { if (taken()) { this.userTextWaiters.delete(wake); onTaken?.(); res() } }
    })
    this.userTextWaiters.add(wake)
    return { seen, dispose: () => this.userTextWaiters.delete(wake) }
  }

  noteItemCompleted(item: Record<string, unknown>): void {
    if (item.type === 'plan' && typeof item.id === 'string') this.plan = { id: item.id, text: typeof item.text === 'string' ? item.text : '' }
  }

  settle(outcome: { stopReason: string } | { error: Error }): void {
    this.settled = true
    this.userTextWaiters.clear()
    this.markEndedFn()
    if ('error' in outcome) this.rejectFn(outcome.error)
    else this.resolveFn({ stopReason: outcome.stopReason, ...(this.usage ? { usage: this.usage } : {}) })
  }
}

/**
 * The pure rules of a session's message to another session, in ONE place: the leader
 * (session-send-core.ts, session-requests.ts), a host's own Walnut server answering its host's
 * calls (replica/away-sends.ts, away-replies.ts) and the host daemon answering while both are
 * away (providers/offline-host-core.ts) all run these, so the three never drift.
 * No I/O here: each caller reads the tasks its own way (the leader its store, a host
 * replica its copy with this host's journal folded in, the daemon its slice) and passes what it read.
 *
 * Imported by daemon-standalone.ts (createSendRules). The factory body references NOTHING at module scope (types are erased), and every constant lives inside it.
 */

/** A send's inputs these rules read (session-send-core.ts SessionSendInput, the route body's fields). */
export interface SendRuleInput {
  expectReply?: boolean
  handsOn?: unknown
  wake?: boolean
  force?: boolean
  reason?: string
}

/** A refusal: its code, words and HTTP status, as the leader's SendError carries them. */
export interface SendRuleRefusal { code: string; message: string; status: number; detail?: Record<string, unknown> }

/** What org/retired-lead.ts retiredLeadRefusal answers (only the fields this rule reads). */
export interface RetiredLeadFacts {
  message: string
  detail: Record<string, string>
  retired: { lead: { id: string; title?: string; phase?: string } }
}

/**
 * What kind of work a request asks for, which sets its default deadline (2026-11-04, the org
 * reflection: of 40 overdue notices a VP got in a day, most were 6h fuses on "read your task and
 * do it end to end" starts and on asks to leads, whose answers take a whole job or a team's round):
 *   - 'send': a message to a task about work it is doing (1h asked, 6h by default);
 *   - 'lead': a message to a lead or Main, whose answer waits on its teams;
 *   - 'start': starting a task, whose answer is the whole task done.
 */
export type ReplyKind = 'send' | 'lead' | 'start'

export function createSendRules() {
  /** Default reply deadline when the sender EXPLICITLY asked for a reply and named no timeout:
   *  an explicit ask is an ask, an hour of silence is worth hearing about. */
  const DEFAULT_REPLY_TIMEOUT_SECS = 3_600
  /** Default deadline for an IMPLICIT request, one the expect_reply default created (2026-09-01).
   *  Most of them are "tell me when you're done" rather than "answer me": a 1h fuse on every
   *  session to session message turns the reply loop into a notification firehose. */
  const IMPLICIT_REPLY_TIMEOUT_SECS = 6 * 60 * 60
  /** Deadline bounds: a sweep tick is 60s, so sub-minute deadlines are noise. */
  const MIN_REPLY_TIMEOUT_SECS = 60
  const MAX_REPLY_TIMEOUT_SECS = 24 * 60 * 60
  const REPLY_TIMEOUT_BY_KIND: Readonly<Record<ReplyKind, { asked: number; implicit: number }>> = {
    send: { asked: DEFAULT_REPLY_TIMEOUT_SECS, implicit: IMPLICIT_REPLY_TIMEOUT_SECS },
    lead: { asked: 2 * 60 * 60, implicit: 12 * 60 * 60 },
    start: { asked: 12 * 60 * 60, implicit: 12 * 60 * 60 },
  }
  const RETIRED_LEAD_REASON_MIN = 10

  /** The route body's (or an op's args') fields as these rules read them. */
  function ruleInputOf(b: Record<string, unknown>): SendRuleInput {
    return {
      ...(typeof b.expect_reply === 'boolean' ? { expectReply: b.expect_reply } : {}),
      ...(b.hands_on !== undefined ? { handsOn: b.hands_on } : {}),
      ...(typeof b.wake === 'boolean' ? { wake: b.wake } : {}),
      ...(b.force === true ? { force: true } : {}),
      ...(typeof b.reason === 'string' ? { reason: b.reason } : {}),
    }
  }

  /** wake=false is a note that asks nothing: it cannot also ask for a reply or hand on a request. */
  function wakeFalseConflict(input: SendRuleInput): SendRuleRefusal | null {
    if (input.wake !== false || !(input.expectReply === true || input.handsOn)) return null
    return { code: 'bad_request', message: 'wake=false is a note that asks nothing: it cannot also ask for a reply or hand on a request', status: 400 }
  }

  /** A note that asks nothing and is not forced starts no turn: it waits for the target's next message (quiet-notes.ts). */
  function holdsQuietly(input: SendRuleInput): boolean {
    return input.wake === false && !input.force
  }

  /** Whether the org direction decides the reply default: expect_reply left out and no hand-off. */
  function directionDecides(input: SendRuleInput): boolean {
    return input.expectReply === undefined && !input.handsOn
  }

  /**
   * The expect_reply default: a session asking another wants the answer, unless it said
   * expect_reply=false, or left it out on a note up the org (`goesUp`, reply-direction.ts),
   * which reports and asks nothing.
   */
  function asksReply(input: SendRuleInput, goesUp: boolean): boolean {
    return input.expectReply !== false && !(directionDecides(input) && goesUp)
  }

  /**
   * Whether a delivered send opens a request: as asksReply, and never for a note that asks nothing
   * (the leader holds that one quietly and opens none; a host that cannot hold it delivers it now,
   * still asking nothing). A forced wake=false note is delivered and asks as any message does.
   */
  function opensRequest(input: SendRuleInput, goesUp: boolean): boolean {
    return asksReply(input, goesUp) && !holdsQuietly(input)
  }

  /** The request's kind by its target task's `org_role`, which sets its default deadline (REPLY_TIMEOUT_BY_KIND): a lead or Main answers for its teams. */
  function replyKindOf(orgRole: unknown): 'lead' | 'send' {
    return orgRole ? 'lead' : 'send'
  }

  /**
   * A request's deadline in seconds: the caller's own, bounded, else the default of its kind.
   * `implicit` = this request exists only because the expect_reply DEFAULT fired, not because
   * anyone asked: it changes nothing but the fallback fuse.
   */
  function clampReplyTimeoutSecs(secs: number | undefined, implicit = false, kind: ReplyKind = 'send'): number {
    if (typeof secs !== 'number' || !Number.isFinite(secs)) {
      const by = REPLY_TIMEOUT_BY_KIND[kind] ?? REPLY_TIMEOUT_BY_KIND.send
      return implicit ? by.implicit : by.asked
    }
    return Math.min(MAX_REPLY_TIMEOUT_SECS, Math.max(MIN_REPLY_TIMEOUT_SECS, Math.floor(secs)))
  }

  /** A subtask never messages its COMPLETE parent (session-send-core.ts refuseSendToCompleteParent). */
  function parentCompleteRefusal(parent: { id: string; title?: unknown }): SendRuleRefusal {
    return {
      code: 'parent_complete',
      message: `"${typeof parent.title === 'string' ? parent.title : ''}" (${parent.id}) is your task's parent and it is complete: it no longer takes messages `
        + 'from its subtasks. Keep your result in your own task, where the user reads it; if that task should hear '
        + 'from you again, the user reopens it.',
      status: 409,
      detail: { parentTaskId: parent.id },
    }
  }

  /**
   * A message to a lead that handed its project over: refused with the lead that took it, unless the
   * old lead itself must act (force with a reason of 10 or more characters, which then leads the
   * text; a COMPLETE lead's reason is the complete-target check's to lead). The text to deliver, or the refusal.
   */
  function admitRetiredLeadRule(refusal: RetiredLeadFacts, input: SendRuleInput, text: string): { text: string } | { error: SendRuleRefusal } {
    if (input.force !== true) {
      return { error: { code: 'lead_handed_over', message: `${refusal.message} If the old lead itself must act, pass force:true with reason:"<why it, not the lead that took over>".`, status: 409, detail: refusal.detail } }
    }
    const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim()
    const lead = refusal.retired.lead
    if (reason.length < RETIRED_LEAD_REASON_MIN) {
      return {
        error: {
          code: 'bad_request', status: 400,
          message: `force:true needs a reason (at least ${RETIRED_LEAD_REASON_MIN} characters) saying why "${lead.title}" `
            + `(${lead.id}), which no longer leads ${refusal.detail.project}, must act rather than the lead that took over.`,
        },
      }
    }
    if (lead.phase === 'COMPLETE') return { text }
    return { text: `This comes to you although you no longer lead ${refusal.detail.project}. Why: ${reason.slice(0, 300)}\n\n${text}` }
  }

  return {
    DEFAULT_REPLY_TIMEOUT_SECS, IMPLICIT_REPLY_TIMEOUT_SECS, MIN_REPLY_TIMEOUT_SECS, MAX_REPLY_TIMEOUT_SECS, REPLY_TIMEOUT_BY_KIND,
    ruleInputOf, wakeFalseConflict, holdsQuietly, directionDecides, asksReply, opensRequest, replyKindOf,
    clampReplyTimeoutSecs, parentCompleteRefusal, admitRetiredLeadRule,
  }
}

export type SendRules = ReturnType<typeof createSendRules>

const rules = createSendRules()
export const {
  DEFAULT_REPLY_TIMEOUT_SECS, IMPLICIT_REPLY_TIMEOUT_SECS, MIN_REPLY_TIMEOUT_SECS, MAX_REPLY_TIMEOUT_SECS, REPLY_TIMEOUT_BY_KIND,
  ruleInputOf, wakeFalseConflict, holdsQuietly, directionDecides, asksReply, opensRequest, replyKindOf,
  clampReplyTimeoutSecs, parentCompleteRefusal, admitRetiredLeadRule,
} = rules

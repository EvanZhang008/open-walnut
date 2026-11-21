/**
 * The pure rules of a session's message to another session, in ONE place: the leader
 * (session-send-core.ts) and a host's own Walnut server answering its host's calls
 * (replica/away-sends.ts, away-replies.ts) both call these, so the two never drift.
 * No I/O here: each caller reads the tasks its own way (the leader its store, a host
 * replica its copy with this host's journal folded in) and passes what it read.
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

/** wake=false is a note that asks nothing: it cannot also ask for a reply or hand on a request. */
export function wakeFalseConflict(input: SendRuleInput): SendRuleRefusal | null {
  if (input.wake !== false || !(input.expectReply === true || input.handsOn)) return null
  return { code: 'bad_request', message: 'wake=false is a note that asks nothing: it cannot also ask for a reply or hand on a request', status: 400 }
}

/** A note that asks nothing and is not forced starts no turn: it waits for the target's next message (quiet-notes.ts). */
export function holdsQuietly(input: SendRuleInput): boolean {
  return input.wake === false && !input.force
}

/** Whether the org direction decides the reply default: expect_reply left out and no hand-off. */
export function directionDecides(input: SendRuleInput): boolean {
  return input.expectReply === undefined && !input.handsOn
}

/**
 * The expect_reply default: a session asking another wants the answer, unless it said
 * expect_reply=false, or left it out on a note up the org (`goesUp`, reply-direction.ts),
 * which reports and asks nothing.
 */
export function asksReply(input: SendRuleInput, goesUp: boolean): boolean {
  return input.expectReply !== false && !(directionDecides(input) && goesUp)
}

/** The request's kind by its target task's `org_role`, which sets its default deadline (session-requests.ts REPLY_TIMEOUT_BY_KIND): a lead or Main answers for its teams. */
export function replyKindOf(orgRole: unknown): 'lead' | 'send' {
  return orgRole ? 'lead' : 'send'
}

/** A subtask never messages its COMPLETE parent (session-send-core.ts refuseSendToCompleteParent). */
export function parentCompleteRefusal(parent: { id: string; title?: unknown }): SendRuleRefusal {
  return {
    code: 'parent_complete',
    message: `"${typeof parent.title === 'string' ? parent.title : ''}" (${parent.id}) is your task's parent and it is complete: it no longer takes messages `
      + 'from its subtasks. Keep your result in your own task, where the user reads it; if that task should hear '
      + 'from you again, the user reopens it.',
    status: 409,
    detail: { parentTaskId: parent.id },
  }
}

const RETIRED_LEAD_REASON_MIN = 10

/** What org/retired-lead.ts retiredLeadRefusal answers (only the fields this rule reads). */
export interface RetiredLeadFacts {
  message: string
  detail: Record<string, string>
  retired: { lead: { id: string; title?: string; phase?: string } }
}

/**
 * A message to a lead that handed its project over: refused with the lead that took it, unless the
 * old lead itself must act (force with a reason of 10 or more characters, which then leads the
 * text; a COMPLETE lead's reason is the complete-target check's to lead). The text to deliver, or the refusal.
 */
export function admitRetiredLeadRule(refusal: RetiredLeadFacts, input: SendRuleInput, text: string): { text: string } | { error: SendRuleRefusal } {
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

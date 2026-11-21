/**
 * Whether a decision letter still waits on the user: the ONE rule every reader uses (the task's
 * status facts, the close gate, a lead's answer in the user's place, the morning report, the
 * duplicate-letter check, a lead's settle, the web inbox and the Org page's answer cards).
 *
 * A letter is answered when the user picked one of its options (`answered`) or wrote back in its
 * thread (2026-11-18: the user wrote back "I unblock everything" to a letter asking him to unblock
 * a rollout; nothing set `answered`, so the task read Needs you with that ask after he had
 * answered it). A written answer goes to the task's session, whose
 * own turn-end report says whether it still asks anything. Not for a letter only a pick settles:
 * a plugin's approval of a step outside Walnut, a sign-in ask (it needs the credential itself) and
 * a letter carrying inbox items. A reply whose delivery to the session failed answers nothing: the task never read it.
 * Guard: tests/core/own-park-survives-turn-end.test.ts.
 *
 * Pure, with structural types only: the web imports it too.
 */

export interface DecisionLetterShape {
  type: string;
  answered?: unknown;
  archived?: boolean;
  settled?: unknown;
  sender?: { pluginId?: string } | null;
  credentialAsk?: unknown;
  items?: readonly unknown[];
  thread?: readonly { from: string; delivery?: { status?: string } }[];
}

/** The user wrote back in the letter's thread, and a written answer can settle this letter. */
export function userAnsweredInThread(l: DecisionLetterShape): boolean {
  if (l.sender?.pluginId || l.credentialAsk || l.items?.length) return false;
  return !!l.thread?.some((t) => t.from === 'human' && t.delivery?.status !== 'failed');
}

/** The user answered the decision: an option picked, or words written back in its thread. */
export function decisionAnswered(l: DecisionLetterShape): boolean {
  return !!l.answered || userAnsweredInThread(l);
}

/** A decision letter still waiting on the user: not answered, settled or archived. */
export function awaitsUserDecision(l: DecisionLetterShape): boolean {
  return l.type === 'action_required' && !decisionAnswered(l) && !l.settled && !l.archived;
}

/**
 * A decision letter whose buttons still show: no option picked, not settled or archived. Words
 * written back leave them on his card (2026-11-21), so a task that asks him anew must name it
 * (org/thread-supersede.ts); whether it still waits on him is awaitsUserDecision.
 */
export function showsDecisionButtons(l: DecisionLetterShape): boolean {
  return l.type === 'action_required' && !l.answered && !l.settled && !l.archived;
}

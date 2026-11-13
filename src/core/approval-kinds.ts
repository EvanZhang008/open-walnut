/**
 * The kinds of step only the user approves, and which of them the Approvals switch hands to agents
 * when it is off: ONE list that both the session prompt's approvals-off line
 * (sessions/reply-language-context.ts approvalsLine) and an answer in the user's place
 * (sessions/ask-answer.ts, an answer to a teammate's ask) read, so what agents are told and what Walnut
 * lets them do never drift apart (2026-11-12, two VPs' reflections: with
 * approvals off the prompt said an outward message was no longer the user's decision, while
 * answers_ask still refused every outward ask with user_words and left it on his Needs you).
 */

/** Ask kinds only the user may approve: an answer in their place quotes their words (user_words). */
export const APPROVAL_KINDS: ReadonlySet<string> = new Set(['outward', 'spending', 'credentials', 'permissions', 'cloud_delete', 'irreversible']);

/** The kinds the switch settles: with approvals off they are no longer the user's decision. */
export const SWITCH_OFF_SETTLES: ReadonlySet<string> = new Set(['outward']);

/** How the prompt names each kind that stays the user's whatever the switch says. */
export const STILL_THE_USERS: Readonly<Record<string, string>> = {
  spending: 'spending money',
  credentials: 'changing credentials',
  permissions: 'changing permissions',
  cloud_delete: 'deleting cloud resources or data',
  irreversible: 'a hard-to-reverse step',
};

/** Whether an ask of `kind` needs the user's own words now, with the switch on (`askMe`) or off. */
export function needsUsersWords(kind: string | undefined, askMe: boolean): boolean {
  if (!kind || !APPROVAL_KINDS.has(kind)) return false;
  return askMe || !SWITCH_OFF_SETTLES.has(kind);
}

/**
 * The kinds of step only the user approves, and which of them the Approvals switch hands to agents
 * when it is off: ONE list that both the session prompt's approvals-off line
 * (sessions/reply-language-context.ts approvalsLine) and an answer in the user's place
 * (sessions/ask-answer.ts, an answer to a teammate's ask) read, so what agents are told and what Walnut
 * lets them do never drift apart (2026-11-12, two VPs' reflections: with
 * approvals off the prompt said an outward message was no longer the user's decision, while
 * answers_ask still refused every outward ask with user_words and left it on his Needs you).
 *
 * 2026-11-17, the user, after a VP signed him up for a colleague's office hour and replied "I am
 * signing up" in his name with the switch off: "you need my approval for everything that is
 * irreversible or involves other people, and tell me when you decide for me". The switch now settles
 * no kind: it changes what Walnut stops, never whose decision a step is (USERS_OWN_YES_RULE).
 */

/** Ask kinds only the user may approve: an answer in their place quotes their words (user_words). */
export const APPROVAL_KINDS: ReadonlySet<string> = new Set(['outward', 'spending', 'credentials', 'permissions', 'cloud_delete', 'irreversible']);

/**
 * The kinds the switch settles: with approvals off they would no longer be the user's decision.
 * None since 2026-11-17 (above); kept as the one place such a kind would be named.
 */
export const SWITCH_OFF_SETTLES: ReadonlySet<string> = new Set<string>([]);

/** How the prompt names each kind that stays the user's whatever the switch says. */
export const STILL_THE_USERS: Readonly<Record<string, string>> = {
  outward: 'anything that involves other people or speaks in the user\'s name',
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

/**
 * The rule every session's charter carries (team-charter.ts), whatever the Approvals switch says: a
 * step that touches other people, their time, the user's name, or that cannot be undone waits for
 * the user's own explicit yes. Guarded by tests/core/users-own-yes-guard.test.ts.
 */
export const USERS_OWN_YES_RULE = 'Anything that involves other people or takes their time, speaks or publishes in the user\'s name, '
  + 'or cannot be undone (a sign-up, a meeting or office hour, an invite, a post, a reply or a ping, a word to their manager '
  + 'or a colleague, an application in their name, a public release of an app or package) waits for the user\'s own explicit '
  + 'yes, whatever the Approvals switch says: a decision a lead or Main passes on is not that yes, and a standing permission '
  + 'they gave holds only in its own scope. Whenever you decide something in the user\'s place, tell them in that same turn.';

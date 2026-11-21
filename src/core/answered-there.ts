/**
 * An ask whose answer lives outside Walnut is read there again before it is asked or kept
 * (2026-11-20, the user: "Alreqady did, can y fucking remove the rehad, after u saw my reply").
 * A Slack monitor task asked him for two hours which time to move a meeting to, though he had
 * answered in the same DM at once: its trigger delivered only other people's messages, and the
 * task never read the DM again before rewording its ask.
 *
 * Three readers, one rule: the team charter every task and lead gets (team-charter.ts), the
 * needs re-check and the letter re-check (sessions/needs-recheck.ts, sessions/letter-recheck.ts),
 * and the overdue check of a thread waiting on him (org/thread-recheck.ts). The data half: the
 * Slack and mail trigger templates hand the user's own replies over, marked `from_user`.
 * tests/core/answered-there-ratchet.test.ts keeps every reader.
 */

/**
 * The charter bullet (team-charter.ts). Its second sentence is the same day's other case (2026-11-20,
 * the user: "why the fuck is this need you, shoudl be done right , nothing need from me"): a task
 * whose CRs he had already agreed to publish sat in Needs you asking whether to swap in their new
 * descriptions, a step that only finished what he had agreed to; its reason was his words about
 * one other CR, said in another task (org/user-kind.ts citesUserWords checks that now).
 * Its last sentence (2026-11-21): a card asked "put it in this position, ok?" with a "Put it here,
 * ship" button and nothing to show where; org/ask-clarity.ts refuses such a question.
 */
export const ANSWERED_THERE_RULE = 'Ask the user each thing once. A step that follows from what they already agreed to '
  + '(a new description or picture for the same CR, carrying out their words) is yours: do it, then tell them in one line. '
  + 'Words of theirs cover only what they were about (that task, CR or post), never a rule for anything else. '
  + 'Before you ask, or open or reword a thread, letter or status that asks, read again where the answer would be (a Slack '
  + 'DM or channel, a mail thread, a code review, a ticket outside Walnut; their cards and chats in it), the user\'s own '
  + 'messages there included: when they already answered or acted, drop the ask and say so in one line. '
  + 'A question reads on its own to someone who never saw the task: what it is and what each choice does, no "here" or '
  + '"this position", a screenshot or design page for where or how something looks, and each choice names its result. '
  + 'A design or picture reaches them only after your own reviewer subagent on another model (Sol, where your Agent tool has it) checked each '
  + 'image (overlaps, cut-off text, alignment, spacing, match with the real screen) and scored function, experience and '
  + 'interface out of 10; put the scores and what changed in the page and your reply. Text-only or colour-only changes skip it. '
  + 'A thread waiting on them has a summary whose first sentence says what they decide and what you recommend, with evidence '
  + 'paths, and its choices as buttons, your pick first and marked recommended.'

/** The line a re-check of an open ask carries. */
export const ANSWERED_THERE_RECHECK = 'When the ask is about a conversation or item outside Walnut (a Slack DM or channel, a mail '
  + 'thread, a code review, a ticket), read it again there, the user\'s own replies included: when they already answered '
  + 'there, the ask is done, so close it yourself (settle the letter, close the thread or set it answered with one line '
  + 'saying they answered there) instead of asking again.'

/** Phrases every reader must keep (the ratchet reads them). */
export const ANSWERED_THERE_MARKS = ["the user's own", 'outside Walnut'] as const

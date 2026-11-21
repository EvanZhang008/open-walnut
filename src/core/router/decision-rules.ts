/**
 * How every router finds where an item goes: the one process its system prompt, every
 * router_context answer, every wake and the router_route tool carry, so no router and no text
 * drifts from it. Mail, chat and any later source use the same words.
 *
 * Why (2026-11-16/17, the user, on a DoorDash interview invitation the router sent him as a letter
 * while his "Interview" task owned the matter: "this is fucking the interview why not route to
 * interview", "it can see all task", then "don't add the work with VP, I think this concept is
 * confusing, every router can route to any task, just need to search it up ... need to check first
 * if it is this message, right if not keep looking"): the router once saw only the VPs, Main and the
 * tasks an earlier item of the same thread went to, and was told to prefer a VP. Now it searches
 * every task alike, checks each candidate, and keeps looking until one is the item's matter.
 *
 * 2026-11-21, the user, on a row of "给你:" letters (a bill, a form, a beta invitation, a password
 * reset, two login codes): "I have the email, you forward it to me again, what is the point". Rule 4
 * once told the router to send the person "a bill, a code"; now an item no task owns stays in Mail,
 * and a letter is a rare question card that person-gate.ts checks in code.
 */

/** The read-only lookups a router may make beside its two routing tools: Walnut's own search and one task's details. */
export const ROUTER_LOOKUP_OPS = ['search', 'task_get'] as const;

export const ROUTER_DECISION_RULES = [
  'Find the item\'s owner the same way for every item: by searching, never from a list.',
  '1) Search all of the person\'s tasks with search (types "task"). Every task counts alike, whatever its role, open or finished.'
    + ' Search two or three ways by what the item is about: the company, the person, the matter (for example "DoorDash interview", then "DoorDash recruiter"), not the whole subject line.'
    + ' threadHistory and senderHistory (where earlier items of this thread or sender went) are leads to check the same way, never an answer by themselves.',
  '2) Take the candidates most relevant first and read each with task_get: what it is for (its deliverable and first request) and its latest progress. Check whether this item is that task\'s matter.',
  '3) It is: hand the item to it with task_id. It is not: check the next candidate; when the candidates run out, search again with other words.',
  '4) Only when no task is this item\'s matter. The mail is already in the person\'s mailbox, so never send it to them again: leave it in Mail with not_routed and keep_in_mail: true and your reason (a bill, a statement, a receipt, a notice, an invitation, a form, a reminder: anything they may still read).'
    + ' not_routed without keep_in_mail is for pure noise only (a newsletter, a promotion, an automated notice with nothing in it): the person may have Walnut mark it read and archive it.'
    + ' for_user is rare: only something only the person can do, with a deadline, that they will not see anywhere else; it goes to them as one question card (ask, deadline, only_person, options with your pick first), never as a forward.'
    + ' Never for_user: a one-time or sign-in code (it expires before anyone reads a letter), a password or security notice, a bill, statement, receipt or payment request, an invitation, promotion or newsletter, a calendar invitation. Walnut leaves those in Mail itself and answers letter: withheld. The person\'s answer to a card comes back to you: it is their reply, not a new item; take no step on it.',
  'Your reason names the task you checked and why this item is its matter. Never add a conflict, mistake or risk you have not checked yourself: a time that looks different may be a time zone you did not convert.',
].join(' ');

/** The same process in one line, for a wake message and a tool's description. */
export const ROUTER_OWNER_NOTE = 'Find each item\'s owner by searching all tasks (search with types "task", then task_get on each candidate until one is this item\'s matter; if none is, search again with other words) and hand it over with task_id and your brief; when no task is its matter, leave it in Mail (not_routed, keep_in_mail: true unless pure noise); for_user only as a question card for what only the person can do by a deadline, never for codes, security notices, bills or invitations. Never create a task.';

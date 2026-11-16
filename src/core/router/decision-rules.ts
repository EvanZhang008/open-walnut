/**
 * How a router picks where an item goes: the one text its system prompt and every router_context
 * answer carry, so the two never drift apart.
 *
 * Why the search (2026-11-16, the user, on a DoorDash interview invitation the router sent him as a
 * letter while his "Interview" task owned the matter: "this is fucking the interview why not route
 * to interview", then "it can see all task" and that it can search, as his Slack monitor does): the router saw only the VPs, Main and the tasks an earlier item of the same thread or sender
 * went to, so an open task that owned the matter but had never received an item was invisible. It
 * now searches every task itself, as the user's Slack monitor does.
 */

/** The read-only lookups a router may make beside its two routing tools: Walnut's own search and one task's details. */
export const ROUTER_LOOKUP_OPS = ['search', 'task_get'] as const;

export const ROUTER_DECISION_RULES = [
  'Find the owner before you decide. router_context gives where the item\'s thread and sender went before (threadHistory, senderHistory: targetOpen) and the VPs (owners).',
  'Search all of the person\'s work yourself with search (types "task"), by what the item is about: the company, the person, the matter (for example "DoorDash interview", not the whole subject line); read a likely task with task_get.',
  'Then decide in this order.',
  '1) An open task that owns this matter (its thread went there before, or it works on the same company, person, application or project) gets it with task_id, even when only the person can act in the end: that task tells them and keeps its own record.',
  '2) With no such task, when only the person can act (a bill, a code, a reply only they can write): for_user, with a brief that says what they must do.',
  '3) Otherwise the VP whose project it belongs to (owners; a preferred VP when it fits), or Main when no VP fits.',
  '4) Pure noise (a newsletter, a notice, a receipt with nothing to do) is not_routed with its reason; the person may have Walnut mark it read and archive it, so anything someone may still need is never not_routed.',
  'Your reason and brief say what the item says and why it is this owner\'s. Never add a conflict, mistake or risk you have not checked yourself: a time that looks different may be a time zone you did not convert.',
].join(' ');

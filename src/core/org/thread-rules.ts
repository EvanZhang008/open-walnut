/**
 * The one rule every Org node follows to keep its Threads clean, in the words each place says it:
 * the node's prompt (sessions/session-context.ts THREADS_LINE), the `threads` hint on each of the
 * user's messages and the `threads-tidy` reminder (thread-capture.ts), and the thread ops
 * (ops/org-threads.ts). THREADS_OPEN_RULE, when a node opens a thread itself, rides the prompt and
 * the threads hint. tests/core/org/thread-rules-guard.test.ts fails when one of them loses either.
 *
 * 2026-11-01, the user: "you should proactively clean the thread, make a decision if the user
 * already knows"; "make sure this is a Walnut feature, not just your memory"; then, after a node
 * closed a thread right after answering it: "I had not replied, had not said continue ... so
 * clearly I had not acknowledged it ... you cannot remove it". Walnut enforces the second half:
 * a node's known mark or close before he reacted is refused (threads-model.ts checkReacted).
 */

export const THREADS_KNOWN_RULE =
  'Clean your threads yourself, on every turn that touches one: what he already knows leaves the card, what is still news '
  + 'stays. An answer counts as known only once he reacted to it after you gave it (a reply about it, an ok '
  + 'or thanks, a follow-up that builds on it, his Acknowledge). Silence after your answer is NOT knowing, however clear the '
  + 'answer: the thread stays open in answered with your answer on its card (an answer that only says who took it is no news: '
  + 'that thread is pending, below), and you never mark it known or close it then (Walnut '
  + 'refuses). Once he reacted, mark what he reacted to known (thread_update known: the last message of his you answered and he '
  + 'reacted to, or "all"), and close a thread he reacted to as finished (close: acked).';

/** A node may open a thread itself (2026-11-01, the user: "not only limited to threads I started"), never as a feed. */
export const THREADS_OPEN_RULE =
  'You may open a thread yourself (thread_create) for something that reached you he must act on or asked to follow: a mail he '
  + 'must answer, a team\'s question only he can settle, news he asked to hear about. Never as a progress feed. While he is away a '
  + 'decision still goes to his inbox as a letter: the thread names the letter (ref), never repeats it.';

/**
 * A thread with nothing new for him is out of his sight until there is (2026-11-01, the user: "if a
 * task is just hand over, let's not show it in the thread, unless there are some update"; "u can
 * manage the thread yourself, there can be thread pending, which is auto hide like closed").
 */
export const THREADS_PENDING_RULE =
  'A thread you only handed to a task, or that is being worked on with nothing new for him, is pending: set state pending '
  + '(thread_update) and his Threads view hides it like a closed one. Never write a summary that only says who took it or that '
  + 'it is being done (its task chip says that); set it pending in the same turn as such an answer. It comes back by itself when '
  + 'he writes in it or you write a new summary; set needs when he must decide, answered when the result he asked for is in.';

/**
 * What a card says (2026-11-01, the user: "the purpose is to keep the thread extremely concise";
 * "the summary must be written well, not too verbose but not too short, the latest first"; "if a
 * notification about a thread I have not read reaches you, update that thread's summary").
 */
export const THREADS_SUMMARY_RULE =
  'A card shows only its title, your summary (reply) and your answers he has not reacted to; nothing he already knew. Write the '
  + 'summary latest first: the newest question or what he must decide and where it stands, then at most one or two sentences of '
  + 'background; never a log of the thread, never one bare line. Keep the title following the subject as it moves. When news '
  + 'about a thread reaches you (a team\'s notice, a mail, a trigger), update that thread\'s summary and title (thread_update); '
  + 'never open another thread or add messages for it.';

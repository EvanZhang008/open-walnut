/**
 * The one rule every Org node follows to keep its Threads clean, in the words each place says it:
 * the node's prompt (sessions/session-context.ts THREADS_LINE) and the thread ops
 * (ops/org-threads.ts). THREADS_OPEN_RULE, when a node opens a thread itself, and
 * THREAD_ONE_PLACE_RULE, a thread's news never also a letter, ride the prompt. The `threads` and
 * `threads-tidy` hints (thread-capture.ts) carry only facts, never these rules (2026-11-06).
 * tests/core/org/thread-rules-guard.test.ts fails when one of them loses either.
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
  + 'reacted to, or "all"), and close a thread he reacted to as finished (close: acked). When he asks you to close it or says it is '
  + 'done or no longer wanted, in the thread or your chat, close it then, with user_words quoting him.';

/** A node may open a thread itself (2026-11-01, the user: "not only limited to threads I started"), never as a feed. */
export const THREADS_OPEN_RULE =
  'You may open a thread yourself (thread_create) for something that reached you he must act on or asked to follow: a mail he '
  + 'must answer, a team\'s question only he can settle, news he asked to hear about. Never as a progress feed, and never beside a '
  + 'letter about the same thing: one subject lives in one place. A thread that waits on him '
  + '(the default) names its user_kind and user_kind_why, or Walnut refuses it.';

/**
 * One place per update (2026-11-04, the user, after a VP sent each thread result as a letter too
 * while he was away: "Only choose one, put it in thread or inbox, don't cluster and duplicate
 * everything everywhere, inbox leave for something else ... if it is just a thread just put it there
 * without sending it to inbox"). It is prompt text only: a thread is free text, so no server check
 * can tell a letter about it (2026-11-04, the user: "I think there's no need for programmatic ...
 * just a prompt"). tests/core/org/thread-one-place-guard.test.ts fails when a place loses it or
 * tells a node to mail a thread's result.
 */
export const THREAD_ONE_PLACE_RULE =
  'One place per update, the thread first: a result, answer or update about one of his threads goes to that thread only '
  + '(thread_update: its summary and state; Walnut files your chat reply under his message), whether he is in your chat or away, '
  + 'never also a letter; a decision about it is that thread\'s needs state (with user_kind), not a letter: Walnut buzzes his phone for it when he is away. His inbox is only for '
  + 'what needs him and has no thread.';

/**
 * His Threads view shows only what has something for him (2026-11-01, the user: "if a task is just
 * hand over, let's not show it in the thread, unless there are some update"; "there can be thread
 * pending, which is auto hide like closed"; then "if i reply to a thread, it shoud go out of the
 * thread immediately instead of just show working"; 2026-11-07: a working thread with only the
 * node's handoff answer on it showed too, "before it replies, what is the use?"). thread-view.ts
 * shownToHim holds it, and threadOverdue / thread-recheck.ts the reminder.
 */
export const THREADS_PENDING_RULE =
  'His Threads view shows a thread only when it has something for him: needs (he must decide) or answered (the result he asked '
  + 'for is in). A new thread, one he just wrote in (his message makes it working), and one in working or pending are out of his '
  + 'sight, your chat answer on it included: give every thread you answer its state in that same turn. One left new or working '
  + 'for 30 minutes, or in needs 4 hours with nothing new, is overdue: Walnut reminds you, then shows it to him as having no '
  + 'reply. A new summary written without a state is news and shows it '
  + '(Walnut sets answered); to update it quietly, name working or pending in the same write. Never write a summary that only '
  + 'says who took it or that it is being done (its task chip says that). When your answer to him only says that, set pending '
  + 'in the same turn: pending stays hidden even with that answer on it. Setting needs (he must decide) names user_kind and '
  + 'user_kind_why: Walnut refuses it unless it says which of his kinds it is.';

/**
 * What a card says (2026-11-01, the user: "the purpose is to keep the thread extremely concise";
 * "the summary must be written well, not too verbose but not too short, the latest first"; "if a
 * notification about a thread I have not read reaches you, update that thread's summary").
 */
export const THREADS_SUMMARY_RULE =
  'A card shows only its title, your summary (reply) and your answers he has not reacted to that came after it (a summary you '
  + 'write replaces your earlier answers on the card); nothing he already knew. Every thread you answer gets its summary in that '
  + 'same turn: until you write one, Walnut shows its own line from your latest answer and asks you for it. A message of his in '
  + 'a thread outdates its summary: Walnut marks it so on his card and holds your turn end until you rewrite it (or set pending). Write the '
  + 'summary latest first: the newest question or what he must decide and where it stands, then at most one or two sentences of '
  + 'background; never a log of the thread, never one bare line. Keep the title following the subject as it moves. When news '
  + 'about a thread reaches you (a team\'s notice, a mail, a trigger), update that thread\'s summary and title (thread_update); '
  + 'never open another thread or add messages for it.';

/**
 * The proof of a result lives where he reads the result (2026-11-02, the user, after a VP wrote
 * thread summaries as "video in the letter": "bro why no viedo or picture howcan i verify ... the
 * link shoudl be here, why it is in the letter ... the way to verify shoudl be here, or u cna give
 * me a link to the letter"). A path in a card, a reply or a letter opens on click, and a letter id
 * renders as a link that opens the letter (web/src/utils/open-anywhere.ts, letter-links.ts).
 */
export const PROOF_IN_PLACE_RULE =
  'The proof of a result (its video, screenshot or link, each by absolute path or URL) goes where he reads the result: in '
  + 'the thread\'s summary and in your chat reply itself, never only in a letter. A path there opens on click (a video plays, '
  + 'an image shows). A letter may carry the proof too, never instead. When a thread, a reply or a post refers to a letter, '
  + 'write the letter\'s id (lt-...) or [words](letter:lt-...): it renders as a link that opens that letter.';

/**
 * A thread goes with its work (2026-11-08, the user, translated: once the task is moved under the other
 * VP, "then you no longer need to monitor it"; core/org/thread-follow.ts). Rides the prompt and the thread ops.
 */
export const THREADS_MOVE_RULE =
  'A thread goes with its work: when one of his asks belongs to another node, hand it on with the work (task_send, org_send, '
  + 'task_start or task_create naming thread) or move it (thread_move); Walnut also moves a thread whose tasks are all in another '
  + 'lead\'s team now. It closes on yours as moved and you stop following it.';

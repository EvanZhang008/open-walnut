/**
 * The one rule every Org node follows to keep its Threads clean, in the words each place says it:
 * the node's prompt (sessions/session-context.ts THREADS_LINE) and the thread ops
 * (ops/org-threads.ts). THREADS_OPEN_RULE, when a node opens a thread itself, and
 * THREAD_ONE_PLACE_RULE, a thread's news never also a letter, ride the prompt. The `threads` and
 * `threads-tidy` hints (thread-capture.ts) carry only facts, never these rules (2026-11-06).
 * tests/core/org/thread-rules-guard.test.ts fails when one of them loses either.
 * A thread's line goes in THREAD_LINE_CHANNEL, never "at the turn's end" (2026-11-24: sessions read
 * that as the end of their reply and wrote the lines there; tests/lib/internal-lines.test.ts).
 *
 * 2026-11-01, the user: "you should proactively clean the thread, make a decision if the user
 * already knows"; "make sure this is a Walnut feature, not just your memory"; then, after a node
 * closed a thread right after answering it: "I had not replied, had not said continue ... so
 * clearly I had not acknowledged it ... you cannot remove it". Walnut enforces the second half:
 * a node's known mark or close before he reacted is refused (threads-model.ts checkReacted).
 * 2026-11-20, the user, on a card that stayed up as unread while he kept talking about it in the
 * chat: the node checks its threads against his words before each turn ends (the Stop hook names
 * the answered ones he wrote after, org/thread-summary-stop.ts answeredBeforeHim).
 */
import { STATUS_QUESTION, THREAD_LINE_CHANNEL } from '../../lib/internal-lines.js';
import { CARD_TAG_FORM } from '../../lib/card-tag.js';

/**
 * With threads_kept_by_walnut on (threads-kept.ts; 2026-11-22, the user, on a VP that wrote a thread
 * before each reply: "every thread is being updated, every question has to do this ... that's
 * unbelievable, and very wasteful"): the node answers in the chat, and the status question after
 * its turn keeps its threads (sessions/status-threads.ts). This replaces the rules above that ask
 * for a write each turn (the summary, its state, the known mark); what a line cannot do stays a call.
 */
export const THREADS_KEPT_RULE =
  'Walnut keeps your Threads from your chat, in place of the earlier rules that had you write each thread\'s summary, state and '
  + 'known mark with thread_update every turn (those no longer apply): answer him in the chat first and write no thread for each '
  + `message. Your line for each open thread goes in ${THREAD_LINE_CHANNEL}. It gives its state (working: you are on it `
  + 'now; waiting: a team or something outside has it; answered: the result he asked for is in; done: finished) and where it '
  + 'stands for him, latest first, with the proof\'s path or URL if any. Walnut writes that as its state and '
  + 'the summary on his card, gives an untitled thread the title you name, and marks your answer known only where you say he '
  + 'reacted to it in his own words (a reply about it, an ok or thanks, a follow-up that builds on it; unsure is not seen). His '
  + 'Threads view shows a thread only when it needs him or its result is in. Call thread_update yourself only for what a line '
  + 'cannot do: a decision he must make (needs, with its options, user_kind and user_kind_why), a close he asked for in his own '
  + 'words (close with user_words quoting him), and a merge (merge_into), split or move. When Walnut could not ask you (a '
  + '"threads to tidy" note, or a held turn end, names threads), write what it names with thread_update.';

/**
 * The same with threads_reply_tag on too (reply-card-switch.ts; 2026-11-25, the user, translated: "in
 * what it returns, it adds this tag. Then it is both its reply to me and its reply to the thread"):
 * the thread's line is one hidden line at the end of the chat reply (lib/card-tag.ts), which Walnut
 * takes off every screen and writes to the card (reply-card.ts); the status question asks only about
 * the threads no line named. This is the one form of a thread's line a reply may hold, and only this
 * rule and the `threads` hint ask for it (tests/lib/internal-lines.test.ts): a free list of threads
 * in a reply is still what no text asks for.
 * 2026-11-25, a live session: after a thread_split it told him in the chat "I moved your compost
 * question into its own thread". What a session did to a thread is on his cards, so the rule keeps
 * it out of the reply. A held turn end asks such a session for card lines only
 * (reply-card-stop.ts), so the rule's last sentence names the tidy note alone.
 */
export const THREADS_TAG_RULE =
  'Walnut keeps your Threads from your chat reply itself, in place of the earlier rules that had you write each thread\'s '
  + 'summary, state and known mark with thread_update every turn, or give its line only when asked (those no longer apply): '
  + `answer him in the chat, and end that reply with one hidden line of its own for each thread it speaks for, ${CARD_TAG_FORM} `
  + '(state working: you are on it now; waiting: a team or something outside has it; answered: the result he asked for is in; '
  + 'done: finished). The thread id is one Walnut gave you (the note on his message, thread_create, thread_list): with none '
  + 'at hand, write no line, never a made-up id. Walnut takes the line off before he reads the reply and writes the thread\'s card from it: one line per '
  + 'thread, at most 6, after your words. Your reply holds no other list of threads and no word of what you did to one (its '
  + 'line, a split, a merge, a mark) unless he asks: his cards show it. The line may add '
  + 'summary="where it stands for him, latest first, with the proof\'s path or URL" (240 characters; without it his card shows '
  + 'your reply), title="..." for an untitled thread, and seen="yes" only where he reacted to your earlier answer in his own '
  + 'words (a reply about it, an ok or thanks, a follow-up that builds on it; unsure is not seen). thread="th-..." '
  + 'merge="th-..." alone joins a thread to that open one. A decision he must make is state="needs" ask="what he decides" '
  + 'options="Larch; Oak" (2 to 5, the one you recommend first) kind="<its user_kind>" why="<what makes it that kind>". A quote '
  + 'inside a value is &quot;. A card line shown as an example goes in backticks or a code block. A line Walnut cannot read or '
  + 'write comes back to you before the turn ends. Where these rules name '
  + `a thread\'s line, this is it; ${STATUS_QUESTION} asks only about the open threads you gave none. His Threads view shows a `
  + 'thread only when it needs him or its result is in. Call thread_update yourself only for what the line cannot do: a close he '
  + 'asked for in his own words (close with user_words quoting him), a split or a move. When Walnut could not ask you (a '
  + '"threads to tidy" note names threads), write what it names with thread_update.';

export const THREADS_KNOWN_RULE =
  'Clean your threads yourself, on every turn that touches one: what he already knows leaves the card, what is still news '
  + 'stays. An answer counts as known only once he reacted to it after you gave it (a reply about it, an ok '
  + 'or thanks, a follow-up that builds on it, his Acknowledge). Silence after your answer is NOT knowing, however clear the '
  + 'answer: the thread stays open in answered with your answer on its card, and you never mark it known or close it then (Walnut '
  + 'refuses). Once he reacted, mark what he reacted to known (thread_update known: the last message of his you answered and he '
  + 'reacted to, or "all"), and close a thread he reacted to as finished (close: acked). When he asks you to close it or says it is '
  + 'done or no longer wanted, in the thread or your chat, close it then, with user_words quoting him. '
  + 'His chat words count for every thread they build on, wherever Walnut filed them.';

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

/** The same with threads_kept_by_walnut on: the thread's update is its line in the status question, not a call. */
export const THREAD_ONE_PLACE_KEPT_RULE =
  'One place per update, the thread first: a result, answer or update on one of his threads goes to that thread only '
  + `(its line in ${STATUS_QUESTION}; Walnut files your chat reply under his message), whether he is here or away, `
  + 'never also a letter; a decision about it is its needs state (thread_update with user_kind), not a letter: Walnut buzzes his phone when he is away. His inbox is for '
  + 'what needs him and has no thread.';

/**
 * A choice is clicked, never only read (2026-11-20, the user, on a needs thread whose summary listed
 * A (recommended) and B under only Acknowledge: "if you recommend this, why can I not just click
 * it?"; "Acknowledge is for when I do not need to make any choice"). Enforced where it writes:
 * thread-options.ts refuses a needs write listing choices with no options. Not in the always-loaded
 * prompt (its budget, prompt-blocks-guard.test.ts): the thread ops carry it, and the refusal teaches it.
 */
export const THREADS_OPTIONS_RULE =
  'A thread in needs that asks him to pick among choices carries them as options (thread_update or thread_create: 2 to 5, '
  + 'each a short label and a line of detail, the recommended one first with recommended: true). With his one-card setting on '
  + '(threads_one_card) his card shows them as buttons, his click is his answer, filed in the thread, and Walnut refuses a needs write '
  + 'whose words list choices (A:, B:, 1., 2.) without options. '
  + 'When he types instead: words naming an option, or a clear yes ("ok", "K") to the recommended one, are that option; only unclear words '
  + 'get one specific question back as the summary, never the same question and options again.';

/**
 * His Threads view shows only what has something for him (2026-11-01, the user: "if a task is just
 * hand over, let's not show it in the thread, unless there are some update"; "there can be thread
 * pending, which is auto hide like closed"; then "if i reply to a thread, it shoud go out of the
 * thread immediately instead of just show working"; 2026-11-07: a working thread with only the
 * node's handoff answer on it showed too, "before it replies, what is the use?"). thread-view.ts
 * shownToHim holds it, and threadOverdue / thread-recheck.ts the reminder. 2026-11-20, the user: "a
 * human acknowledge means I now know the situation; the thread is truly closed only when the problem
 * is really solved" (experiment ack_means_known, thread-ack.ts).
 */
export const THREADS_PENDING_RULE =
  'His Threads view shows a thread only when it has something for him: needs (he must decide) or answered (the result he asked '
  + 'for is in). A new thread, one he just wrote in (his message makes it working), and one in working or pending are out of his '
  + 'sight, your chat answer on it included: give every thread you answer its state in that same turn. One left new or working '
  + 'for 30 minutes, or in needs 4 hours with nothing new, is overdue: Walnut reminds you, then shows it to him as having no '
  + 'reply. A new summary written without a state is news and shows it '
  + '(Walnut sets answered); to update it quietly, name working or pending in the same write. Never write a summary that only '
  + 'says who took it or that it is being done (its task chip says that). When your answer to him only says that, set pending '
  + 'in the same turn: pending stays hidden even with that answer on it. His Acknowledge means he knows: it closes, or stays '
  + 'pending while its work runs. Setting needs (he must decide) names user_kind and '
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

/**
 * The source-check rule (core-instructions.ts SOURCE_CHECK_RULE) at the moment of writing, in every tool that writes what the
 * user reads: a Brief, a thread, a letter (2026-11-19: one VP marked an unchecked claim in 34 of 127 chat replies, in 0 of 50
 * Brief writes and 5 of 77 thread updates). Any task can send a letter, so it names no team.
 */
export const WORD_TO_USER_RULE =
  'The user reads this without your session, as your word: write anything you did not check yourself (another task\'s claim, '
  + 'a status label, your own memory) as that source\'s word, not checked, and name the commit a test result ran on.'

# Threads: rules, default instructions, code guards and known problems

One page that tracks everything about Threads: what the agents are told, what the code enforces,
which experiments change it, and every problem the user hit with its fix and its state. The design
background is in [Org, Brief, Threads and inbox](org-and-inbox.md); this page is the tracking list.
Update it in the same commit as any change to a thread rule, guard or problem below.

## What a thread is

A thread is one of the user's subjects with one node: Main, a lead (VP), or a task with Threads on.
Walnut files every message he sends that node into a thread and puts the node's chat reply under
it. His Threads view shows a thread only when it needs him (`needs`) or its result is in
(`answered`). A thread of a task pops up to the leaders above it (`threads_pop_up`), stored once:
while it waits on him, and, on the one node whose own thread names that task on the same subject,
while it holds a result for him (that node's thread waits behind it: `thread-subject-pairs.ts`).

Two rules the user set and every part below serves:

- **One subject is one thread, kept by one task** (2026-11-23: "one thread is one issue"; "it should
  be maintained by a single task ... so that it wouldn't cause a single thread to appear in all
  different places, like in VP, in leaders, and in the subtask"). A leader sees the threads of the
  tasks below in its own view, each named by the task it comes from; it never copies them.
- **Each question he asks is its own thread** (with `threads_each_question` on; 2026-11-25: "each
  question I ask needs to have one thread, otherwise how can I track"). It replaces "several asks
  about the same thing are one thread" for his questions; a remark that asks nothing still joins its
  subject's thread, and the node's own threads keep the one-subject rule.
- **A card reads alone**: its title and summary say the result or the question itself, for someone
  who never saw the chat (2026-11-23: "the thread should be readable self contained"), and never
  say his own message back to him ("my words are sometimes messy; summarize it, or just say the matter").

## The default instructions (what agents are told) and where each lives

| Text | File | Reaches |
|---|---|---|
| The Threads setting: one thread per subject (with `threads_each_question` on: each question he asks is its own thread, `EACH_QUESTION`), filing, states | `src/core/sessions/session-context.ts` (`threadsLine`, `threadsKeptLine`) | the node's prompt |
| Card summary rule (latest first, never one bare line) | `src/core/org/thread-rules.ts` `THREADS_SUMMARY_RULE` | prompt, thread ops |
| Walnut keeps threads from the status answer | `thread-rules.ts` `THREADS_KEPT_RULE` | prompt (with `threads_kept_by_walnut`) |
| Known only after his reaction | `thread-rules.ts` `THREADS_KNOWN_RULE` | prompt, thread ops |
| Opening a thread itself, never as a feed | `thread-rules.ts` `THREADS_OPEN_RULE` | prompt, thread ops |
| One place per update, proof in place, a thread goes with its work | `thread-rules.ts` `THREAD_ONE_PLACE_RULE`, `PROOF_IN_PLACE_RULE`, `THREADS_MOVE_RULE` | prompt, thread ops |
| The status question's thread lines (`FOR_USER_THREAD`, `_NEW`, `_TITLE`, `_SEEN`), where each summary is written: readable alone, the task by its title and where it stands, never only "given or told"; a subject an open thread covers is that thread's line | `src/core/sessions/status-threads.ts` `threadQuestionBlock`, `keptBlock` | every turn end |

The prompt of every node is at its budget (`tests/core/sessions/prompt-blocks-guard.test.ts`), so a rule the code enforces is said where it acts: in the status question and in Walnut's refusals, not in the prompt.

Guard tests for the wording: `tests/core/org/thread-rules-guard.test.ts`,
`tests/core/sessions/status-threads-kept.test.ts`, `tests/core/sessions/status-threads-prompt.test.ts`.

## What the code enforces

| Guard | Where | Test |
|---|---|---|
| A summary that only says the answer was given elsewhere ("given to you", "see the chat") is refused from thread_update and thread_create; a status line with such words moves nothing (its state stays too). A clause that names what was given ("Reported to you that the migration lost 12 rows") passes | `src/core/org/thread-summary-content.ts`, used in `threads-model.ts` `updateThread`, `threads-store.ts` `openNodeThread` and `status-threads.ts` `patchForLine` | `tests/core/org/thread-summary-content.test.ts`, `tests/core/org/thread-one-subject-writes.test.ts`, `tests/core/sessions/status-threads-consistency.test.ts` |
| A summary that says his own message back (a run of 70 characters of it, 20 in CJK; paths, links, ids and code left out, so proof he gave is no repeat) is refused the same way | `thread-summary-content.ts` `summaryRepeatsHim` | `tests/core/org/thread-one-subject-writes.test.ts` |
| A card that comes back to him after his words starts with the decision, then what was done since; it never quotes him | `src/core/org/thread-return.ts` `returnedReply` | `tests/core/org/thread-return.test.ts` |
| thread_create that names a task below which keeps open threads of its own (that task does the work, so it keeps the subject, its questions to him included): 409 `same_subject`, its threads nearest the title named first, unless a `separate_reason` that names that task (`reasonCoversTask`). Not narrowed to titles that share a word: 5 of the 12 copies in his data shared none | `src/core/org/thread-same-subject.ts` `copyRefusal`, called by `threads-store.ts` `openNodeThread` | `tests/e2e/thread-same-subject.test.ts` |
| thread_create whose title clearly repeats an open thread of its tree or team (three telling words shared, four when either title has five or fewer, and half of its own; words in many threads do not count; finished tasks do not count): 409 `same_subject` naming them, unless `separate_reason` or `supersedes` | `thread-same-subject.ts` `strongMatch`, `treeOpenThreads` | `tests/core/org/thread-same-subject.test.ts`, `tests/e2e/thread-same-subject.test.ts` |
| Two threads the node opened merge (the newer word becomes the summary; an older word of the node is not kept, its chat holds it; his words always are); a thread waiting on his decision (needs, a letter, a choice) never merges under one that does not ask it; merge_into reaches a thread on a task above or below, and the pointer left behind names the thread it joined, so his follow-up from an old card goes there; thread_move to a task that keeps Threads lands on it | `threads-model.ts` `mergeThreads`, `src/core/org/thread-tree-merge.ts`, `threads-store.ts` `markMergedThere` and `fileThreadMessage`, `thread-follow.ts` `moveTargetOf` | `tests/e2e/thread-tree-merge.test.ts`, `tests/core/org/threads-model.test.ts`, `tests/core/org/thread-follow.test.ts` |
| A status line's new subject whose title clearly repeats an open thread of the task itself is that thread's line; one of another task's opens nothing (logged) | `thread-same-subject.ts` `newSubjectsOnly`, in `status-threads.ts` `applyThreadLines` | `tests/core/org/thread-same-subject.test.ts` |
| His bare reaction ("Done", "ok, thanks") goes to the open thread of the node's newest word (within a day, whatever its state) and moves no state, never a new thread | `threads-model.ts` `fileMessage`, `isPlainReaction` | `tests/core/org/thread-one-subject-writes.test.ts` |
| A status line never brings back a result he acknowledged: on a thread he acknowledged standing answered or needs (`ackedResult`; an older ack counts so), with no word of his since, a done line closes it (his Acknowledge covering it, the line's words on the closed card) and no other line writes its state or words. Wherever it was placed since (the node or Walnut put it in Working or Waiting), a line's words on it are never news (`thread-view.ts` `lineWordsSinceAck`, read by his view and by Walnut's own settling): what finishes there and is news for him is the node's own thread_update. Still news: a result after an ack while its work ran, the node's own thread_update, an answer given for him, his own new words. The status question marks such a thread. An answer he only read is not covered: its lines write as before | `src/core/org/thread-known.ts` `ackHoldsResult`, `lineMay`; `src/core/sessions/status-threads.ts` `patchForLine`; `threads-model.ts` `updateThread` refuses any other line write (`he_has_it`) | `tests/core/sessions/status-threads-after-ack.test.ts` (every line state on every kind of acknowledged thread) |
| A Threads list holds still while he reads it: under the pointer every card keeps its place (a new one goes last), and the card at the top of the view stays where it is on screen when cards above come, go or change height, in both engines | `web/src/components/org/useThreadsHold.ts` (hold-order.ts, useScrollAnchor), `org-threads.css` | `tests/web/threads-hold.test.ts`, `tests/e2e/browser/threads-hold-still.spec.ts` |
| His messages minutes apart are one conversation | `threads-model.ts` `recentConversation` | `tests/core/org/thread-join-conversation.test.ts` |
| A message that joined a thread only for coming right after his last one is marked (`ThreadMessage.joined`), and the node's status question asks once whether it is another subject (at most 3 a question, the first unchecked per thread, marks older than a day not asked; zero bytes when none). `FOR_USER_THREAD_SPLIT: <ref> \| <title> \| <state> \| <words>` takes it, and the joined ones right after it up to the newest message the question saw, into a thread of its own, before the answer's other lines in the same locked write; the run's tail keeps its mark and is asked next. A bare reaction is filed unmarked (`joined: 'reaction'`) | `src/core/sessions/status-thread-split.ts`, `status-threads.ts` `applyThreadLines` | `tests/core/sessions/status-thread-split.test.ts` (each filing rule classified marked or unmarked) |
| One subject is one thread when the node names his new thread: the question's title line also offers `FOR_USER_THREAD_MERGE: <ref> \| <other ref>`, which puts an untitled thread under another listed one before the answer's lines, in the same answer. A title it gives instead (a title line, or a split line's) that strongly repeats another open thread is held (`OrgThread.titleHeld`), not written; the next question names it with that thread's ref when that thread is listed too (at most 3 a question) and asks it no title, and `FOR_USER_THREAD_MERGE: <ref>` merges it; an answer with thread lines and no such line writes the held title. A merged thread's line and seen mark speak for the thread it went into when that one has none. A word of his in it since the question keeps it as it is (asked again); a merge the threads refuse writes the title; the other thread unlisted (it waits on him) asks its title again. With `threads_each_question` on, a thread his question opened is never offered for a merge (a merge of it is refused, `own_question`): a held title of it is asked again as a title of its own | `src/core/sessions/status-thread-title.ts`, `status-thread-pre.ts` | `tests/core/sessions/status-thread-title.test.ts` (every place that sets a thread's title as given is classified) |
| A decision is not asked twice in one task tree | `src/core/same-ask-tree.ts`, `threads-store.ts` `refuseSameAskThread` | `tests/core/same-ask*.test.ts` |
| A node's other open asks are named as replaced or as other decisions | `src/core/org/thread-supersede.ts` | its tests |
| Known or closed only after his reaction | `threads-model.ts` `checkReacted` | `tests/core/org/threads-model.test.ts` |
| A card handed to him (`needs`) is clear: options, no bare opening, user_kind | `src/core/org/ask-clarity.ts`, `user-kind.ts` | `tests/core/org/ask-clarity-doors.test.ts` |
| One question is drawn once at the top of a chat and in the Threads view; a task row always draws the full card | `src/core/org/thread-holds.ts`, `web/src/components/org/top-thread-model.ts` | `tests/web/top-thread.test.ts`, `tests/core/action-needed-ratchet.test.ts` |
| The top of a chat counts the threads for him (`threadsForHim`: "16 threads (1 needs you)"); with `threads_each_question` on it also says how many are being worked on ("· 2 working", or "2 working" alone), never in any count for him | `web/src/components/org/top-thread-model.ts` (`hiddenLine`, `workingThreads`) | `tests/web/top-thread.test.ts`, `tests/e2e/browser/top-thread-working.spec.ts` |

## Experiments that change Threads

`task_threads`, `threads_sqlite`, `threads_pop_up`, `action_needed_everywhere`, `top_thread`,
`reply_thread_line`, `letters_as_threads`, `threads_one_card`, `threads_kept_by_walnut`,
`brief_off`, `threads_each_question` (all in `src/core/experimental.ts`; "Every experiment on" turns on each one never set alone).

The Threads plan of 2026-11-25, five parts, each its own switch that "Every experiment on" never
turns on (`ownSwitchOnly`), so each is measured alone: `threads_reply_tag` (the chat reply carries
one hidden line and is the thread's reply), `threads_related` (a new thread comes with up to five
related ones), `threads_one_id` (a hand-off keeps one thread id), `threads_reminder` (a reminder now
and then in place of the question after every turn), `threads_audit` (a small model reads the open
threads on a schedule and only reports).

### threads_reply_tag

A reply is its thread's reply (2026-11-25, the user, translated: "it can do two things at once: in
what it returns, it adds this tag. Then it is both its reply to me and its reply to the thread").
A session the status question asks about its threads (`asksThreads`: a task with Threads on, and Main
and every lead where Walnut keeps their threads) ends its chat reply with one hidden line per thread
it speaks for:

    <walnut-card thread="th-1a2b3c4d5e6f" state="answered"/>

`state` is working, waiting, answered or done, and means what a line of the status question means;
`summary` (240 characters), `title` (an untitled thread) and `seen="yes"` (he reacted to the earlier
answer) ride it under the same conditions that question's lines have. `merge="th-..."` alone joins
the thread to that open one. `state="needs"` with `ask`, `options="Larch; Oak"` (the recommended one
first; one written as `Oak (recommended)` is that one, its label without the mark), `kind` and `why`
is the `thread_update` into needs; after his message on a thread that waited on him, `since` (what was
done about it) and `decision="same"` or `decision="new"` go with it. The op's own names read as the
same attributes (`since_you_wrote`, `user_kind`, `user_kind_why`: one table, `CARD_ALIASES`), since the
store's refusals name them. One line per thread, at most 6, each a
line of its own outside a code block with at most 3 other lines after it; a quote inside a value is
`&quot;`. A line shown as an example goes in backticks or a code block, where it stays text.

- **The write.** When the turn ends, Walnut reads the lines off the turn's own last words and
  applies each through the code that already owns the write: a state line is a line of the status
  question (`applyThreadLines`), a decision is `patchThread` (every refusal of `thread_update`
  holds), a merge is `merge_into`. A message of his the session has not answered when the turn ends
  (its line is still in the session's queue, or it was filed after the turn's end) fences the line
  out of its thread, and the question then asks about that thread as before. A decision the store
  refuses, at the turn's end or at the send-back, and a decision line that cannot be read (an
  unknown attribute, two lines for one thread) are named by the next status questions until a
  decision line for that thread is written, or the thread is closed, moved or gone (`noteLineAsks`,
  `linesThatAsked`, `noteUnreadDecisions`): never dropped with only a log row.
- **A new decision.** `decision="new"` is never a rewrite of the thread's card (`thread-return.ts`).
  Walnut does for the line what the store asks of a `thread_update`: his message is answered on its
  thread (state answered, the line's `since` words), and the new decision opens as its own thread
  through `thread_create`'s path (`openNodeThread`, `supersedes` naming the old one), with the line's
  ask, choices, kind, why, title and summary (`reply-card-decision.ts`). A thread still waiting on
  him with nothing of his since is stepped aside by `supersedes` instead. The same line again opens
  nothing more (`upAlready`). `tests/core/org/reply-card-carries-guard.test.ts` reads every field the
  store's refusal of a return reads from the source; each is carried by a line or named with why.
- **The order.** The write starts in the turn-complete hook, in the step that arms that turn's status
  question (`turnEndedWith`, then `armStatusQuestion`), and the question waits for it before it
  lists the threads (`cardsWritten` in `threadQuestionFor`). It needs nothing slower than the words
  themselves: not the transcript read that keeps answers under his messages, which a busy server
  finishes late and an isolated one (`dev:ephemeral`) never starts (2026-11-25: the write once
  followed that read, and on an isolated server no line was ever written). The wait is at most 10
  seconds; at that bound the question is built as with the switch off (no thread is left out, a
  warning is logged), and the write still lands when it ends. The same bound caps how long one
  write holds the session's next one (`queueCardWrite`): a write past it is logged and the next goes
  on. In the log, `reply card lines applied`
  names each turn's lines, `reply card lines: threads kept current` the threads they changed, and
  `status question: threads their card line spoke for are left out` what the question skipped and
  what it still listed. A status answer's own write says how many thread lines it held (`lines`),
  and one that only moved the task's ask to a thread says so, so it is never read as a line.
- **The question.** A thread a line spoke for is not listed by the status question of that turn;
  every other open thread still is, and with all of them spoken for the question holds no thread
  block. A thread that still has no title of its own after its line is asked about, for its title.
  A thread may still be named beside an untitled one as its possible subject. With the switch on
  the question takes the form in which its line is the card (`linesAreCards` in `threads-kept.ts`:
  the summary, a title for an untitled thread, his reaction), whether or not
  `threads_kept_by_walnut` is on: the card line is that same line said in the reply, so the
  question asks the same of the threads no line named.
- **One decision, shown once.** A task with Threads asks him in two ways: a card line that puts a
  thread in needs, and its status answer's `FOR_USER_ASK`, which Walnut places on a thread
  (`thread-report-ask.ts`). The thread stores the id of the decision it carries (`askId`, a
  report's `ask-...` id): a card line's write gives it the task's own decision id when the line asks
  that decision, else a new one (`cardDecisionId`, `markThreadDecision`). Every write of a threads
  file (`mutateThreads`, `keepThreadDecisions`) keeps the id only while the thread asks that
  decision: a new stretch of needs leaves it behind, and a write that leaves the thread in needs
  asking another question (its `ask`, judged by one task's words rule) gives it a new id, whoever
  writes it (a `thread_update`, a card line, Walnut's own writes). An id holds the task's ask item
  in the top bar only while its thread asks it in needs (`thread-holds.ts`). The status question
  quotes each card's decision id ("Your threads' cards already ask him: "..." (ask-...)"), and a
  status answer that asks it again names that id as `FOR_USER_ASK_ID`, so the same decision in
  other words with no choices is still one card. A decision an open thread of the task stores in needs is that thread's
  (`needsThreadOf`): by that id, or by one task's words rule (`sameOwnDecision`: the same content
  words, or the same question reworded offering the same choices with words of their own); when
  `askNowOnThread` takes the report's ask off for it, the thread takes the report's id. Shared words alone never make one decision (review 2026-11-25:
  "Turn the sync toggle on by default?" and "Shorten the sync toggle description?"). The task's ask that is the
  same decision is no ask of its own, in either order: a status answer that names it is stored
  asking nothing (`askOnNeedsThread`), a report that asked it before the line stops asking when the
  line is written, before any status answer (`askNowOnThread`, remembering the decision so the same
  ask later keeps its id; it runs again right after each status answer is stored, so a line that
  lands while the answer is on its way meets it there), and `placeAsk` keeps no place for it, so it never lands on another open
  thread (2026-11-25: a decision put up by a line also showed on the thread about another subject
  and as the task's own item). The task reads Needs you through the thread (`taskThreadNeeds`). The
  status question says which decisions are up ("Your threads' cards already ask him: ..."), so a
  session need not say one twice. Another decision in the status answer is still the task's own ask.
  A decision on a needs thread is still its task's to hold (`thread-held-decision.ts`), whether its
  report asked it first, never asked it, or asks another decision now: a teammate's same ask folds
  under the thread (its decision is a fold target, `threadRelatives`), a `same_as` pointer binds to
  its id (`resolveDecisionOwner`, also at a later hop of a chain of pointers), and a fold keeps the
  id of the decision it folded under (`SameAskFold.decision`), so it stays folded while a thread
  carries that id. With no id on one side (a thread or a fold an older build wrote), only the same
  content words count (`oneDecision`, the rule of every fold between two tasks). His message on the
  thread that carries the decision is his answer to it (`repliedOnThread`); one on another thread
  of the holder is not. A change of the holder's Threads re-derives the tasks folded under it.
- **The send-back.** The session's Stop hook hands Walnut the shape of the reply's last 16 lines
  (`last_lines` of `open_items`: a line of words is `x`, only a card line is whole). The turn is held
  once, with one plain line per thing, when a message of his this turn read was filed under an open
  thread and the reply has no line for it (the exact line is given), a line cannot be read, a merge
  is refused, or the store refuses a decision (its own words). A decision the store would refuse
  because he wrote on the thread since it last waited, or it asked before, is named in the line's
  own attributes, everything it lacks at once (`since="..."` and `decision="same"` or `"new"`, 383
  bytes in place of 717 that named only `since_you_wrote`; `returnLacks`), since there is no second
  send-back. A line that names a thread that is
  not an open thread of the task has nothing to write in its place, so it holds no turn by itself
  and is named beside another thing that does. Each thing is named at most twice. A message this turn read is one filed after the
  newest of his messages that an earlier turn's end saw (kept in memory per session), so a thread
  the session answered in before is not asked for a line again while nothing keeps the answer under
  that message (an isolated server, a slow read); after a restart, the task's stored report says
  when this session's last turn ended (`turn_ended_at`), and only a message filed after it is owed a
  line (`readBefore`). A decision that passes is written right then, and one
  already up with the same question and choices is left as it is, at the check and at the turn's end
  (`askedAlready`), so a hold that was lost (a slow check, a restart) never asks it twice.
- **No thread bookkeeping in his chat.** Whatever a session writes after a hook sends its turn back
  is a chat message to him (2026-11-25: sent back about answers he had written after, a session
  closed its reply with "I've left those three threads as they are ... so I haven't marked any of
  them as read"). So for a session that writes card lines the card check is the only check of the
  Stop hook about its threads. Every text it sends is in one table (`CARD_STOP_LINES`), names the
  line to write and no `thread_update` for what a line can say, and the reason ends with "Write only
  this line now, and no other words about it: anything else you add is shown to him as chat". The
  summaries check (`thread-summary-stop.ts`: a summary his message outdated, answers he wrote
  after) is never run for such a session, and the `threads-tidy` hint is not sent to it while
  Walnut can ask it: a line carries the summary, the state and his reaction, and whether his new
  message reacted to earlier answers is asked in the status question after the turn, where the
  answer costs no chat message. That question asks it once after each new message of his, also on a
  thread whose first need was asked already (`lineNeed`), with `threads_reminder` on or off.
  `tests/core/org/stop-checks-guard.test.ts` reads the checks from the route's own source, so a new
  one fails there until it is classified.
- **The hook's five seconds.** The check runs beside the hook's other checks, never before them,
  and gives up after 3 seconds, so a slow server costs the turn its card check and nothing else.
  `open_items` is a GET: the hook sends the last lines only while they and its lists weigh under
  9,000 bytes in the request (a server refuses one past 16 KB, with a 431 that names no field), and
  an answer that is neither a block nor the empty answer is asked once more without them.
- **He never sees it.** `stripInternalLines` drops every card line, wherever it stands, and holds
  back a last line that began one while a reply streams, so the stored history, the web chat, the
  thread cards, a push, the ACP rows and the phone's twin (`CardTagLines.swift`) leave it out, with
  the switch on or off. A message that is only card lines is no chat row.
- **What sessions are told.** Only with the switch on: the kept rule in the always-loaded prompt is
  `THREADS_TAG_RULE` (724 bytes more than `THREADS_KEPT_RULE`), which a running session hears through
  the instruction notice, and the `threads` hint on each filed message of his ends with the line for
  that thread (121 bytes). The rule also keeps what a session did to a thread (its line, a split, a
  merge, a mark) out of its reply unless he asks, since his cards show it; who has his ask now
  is still said (2026-11-25: a
  live session told him "I moved your compost question into its own thread" after a split). For a
  thread with no title of its own yet the line it gives carries
  `title="..."` (165 bytes), and for a new thread beside open ones it adds the merge line (96 bytes
  more); the hint then names no `thread_update` for the title or the merge, its related threads
  included (their join is the line's merge, 26 bytes fewer than the op), so the title is asked
  for in one place. The status question adds one line while a thread of a task waits on him for a
  decision (275 bytes and each question, at most 3 of 160 characters, with its card's decision id), and with
  `threads_kept_by_walnut` off its thread block takes the card form that switch already gives
  (1,396 bytes for three threads instead of 796; no change where that switch is on). A send-back
  ends with 101 bytes (one line) or 132 (several). Off, no text names the tag and nothing reads it.

Code: `src/lib/card-tag.ts` (the reader and the strip), `src/core/org/reply-card.ts` (the write),
`reply-card-decision.ts` (a decision line, a new decision), `reply-card-stop.ts` (the send-back), `reply-card-switch.ts`, `src/core/sessions/status-thread-carded.ts`
(what the question skips), `src/providers/stop-unanswered-hook.ts` (`LAST_LINES_SCRIPT`),
`thread-rules.ts` (`THREADS_TAG_RULE`), `thread-capture.ts` (the hint),
`src/core/session-hooks/builtins.ts` (the turn end, in `turnCompleteTriageHook`). Tests: `tests/lib/card-tag.test.ts`, `tests/lib/card-tag-readers-guard.test.ts` (every reader of
reply text drops the line, a subscriber of the turn-end event too), `tests/core/org/reply-card.test.ts` (each state lands as its status line
does), `tests/core/org/reply-card-prompt.test.ts`, `tests/core/org/reply-card-carries-guard.test.ts`, `tests/e2e/reply-card-return.test.ts` (his words on a decision's thread, turn d of the live walk), `tests/core/sessions/status-thread-carded.test.ts`,
`tests/providers/stop-hook-last-lines.test.ts` (the hook's own shell), `tests/e2e/reply-card-line.test.ts`,
`tests/e2e/reply-card-stop.test.ts`, `tests/e2e/reply-card-stop-budget.test.ts` (the check beside the
others, and the request's size), `tests/e2e/reply-card-real-flow.test.ts` (every kind of line
through the runner's own turn-end event and the question the hook arms, on an isolated server),
`tests/e2e/reply-card-slow-answers.test.ts` (an answers read that takes thirty seconds),
`tests/e2e/reply-card-one-decision.test.ts` (a decision by a line and the task's ask, both orders),
`tests/core/fold-on-needs-thread.test.ts` and `tests/core/org/thread-decision-id.test.ts` (a teammate's
fold under a decision on a thread, and the decision id the thread stores on both stores),
`tests/e2e/reply-card-stop-quiet.test.ts` (no send-back to tidy threads; his reaction asked in the
question) and `tests/core/org/stop-checks-guard.test.ts` (every check and text of the Stop hook).

Limits: the send-back needs a Stop hook that sends the last lines, so an engine without one, and a
Claude Code process started before this change, is never held and its threads without a line are
asked by the status question as before. A decision the store refuses at the turn's end (no hook) is
written nowhere; the next status question names its thread. What a turn's lines spoke for is kept in
memory, so after a restart the next question asks every thread once more. The write rides the
turn-complete hook (`turn-complete-triage`), which also arms the status question: where that hook is
switched off, neither runs, and a turn whose result came while its background work still ran is
written when it settles, from the lines the Stop hook's check held. A turn end announced again
with no words (the sweep after a restart, `askMissedReports`, or a snapshot that saw the turn end)
writes only such held lines and leaves what the last turn's lines spoke for as it is. On a server with no job that
keeps answers (an isolated one), `seen="yes"` marks an answer only after his Threads were read,
which is what keeps the answer under his message there.

### threads_related

A new thread comes with the threads that may be its subject (2026-11-25, the user: "It should do a
fuzzy match, or go through a vector database, and attach the related threads; the agent decides").
When his message is filed as a NEW thread on a node that keeps Threads, Walnut reads the open threads
(and those closed in the last 7 days) of the node and of the tasks above, below and beside it, a task
finished in the last 7 days included for its closed threads (`treeOpenThreads` with `closedWithinMs`),
never a moved-away pointer or the new thread, and puts up to 5 on that message's `threads` hint. The
open ones come under how to join one: `Related threads (its subject is one of yours: thread_update
{"id":"<new>","merge_into":"<id>"}; another task's: that task keeps it, task_send it): th-a "..."
(answered, yours); th-b "..." (needs, on "<task>" <task id>)`. The closed ones come apart, since a
merge into a closed thread is refused: `Related, closed this week (no merge: a new ask about it stays
its own thread; read it, and say on the new card that it continues it): th-c "..." (yours)`. A thread
of the node already named in the hint's Open list goes by its id alone. Advice only: nothing is merged
or refused. A filing whose hint is never sent (a message that switches the engine,
`fileSwitchedRequest`) looks nothing up.

Two lanes, either one is enough: words (his message against each thread's title, ask and first
summary sentence, with the same-subject brake's telling words: 2 shared words and a tenth of the
fewer side's words, and 3 when they stand in one place of his message, as two pairs of CJK
characters in one run can be one word), and meaning (the search stack's model, his message as a
query and each thread's text as a passage, cosine 0.5 or more). The meaning lane runs only where
search by meaning is on and the index is open (never in tests or on ephemeral servers), and only on
workers that already run: no worker (a full model copy of about 2 GB) is ever started for it. With no
query worker running (searches keep it up for 10 minutes after the last one) the lookup is words only
(`semantic: "no-worker"`); passages are embedded only while the backfill's passage worker runs, one
batch of 16 after another so the backfill's own batches queue between them, and cached in memory by a
hash of model and text (4,000 at most), so the cached ones count when the worker is gone
(`semantic: "partial"` for the rest). The whole lookup has 600 ms (the meaning lane 400 ms of it);
past that, or on any error, the list is the words lane alone (the node's own threads alone when the
tree was not read in time) and his message is filed and sent as without it. One log line per lookup,
`org threads: related threads` (candidates, words, meaning, shown, semantic
on/partial/no-worker/timeout/off/error, timedOut, ms), no thread text.

The lookup sits between planning where his message goes and writing it. So that it does not widen
that window for the next message, a message to the same node is planned only after a lookup still
running there ends (`lookupsSettled`, at most 600 ms): two messages sent right after each other are
planned one after the other, as without the lookup. What stays, as before this experiment: a write
by another hand during the lookup (the agent merging or closing a thread) can make the store file his
message elsewhere than the hint said (`filed elsewhere than told` in the log); the store re-plans at
the write, so nothing is lost.

Bars were calibrated on a replay of his own messages (each message that opened a thread or was later
filed into an existing one, against the threads that existed then): words alone showed a list on 21%
of new threads and named the thread a message later sat in for 12% of those messages; with the
meaning lane, 52% and 33%, the list holding that thread 59% of the times it was shown for such a
message. The hint addition is at most 1,000 bytes (`RELATED_HINT_MAX_BYTES`), sent only on a message
that opens a new thread with a related one found.

Code: `src/core/org/thread-related.ts` (lanes, ranking, hint text, `lookupsSettled`),
`src/core/search/short-text-vectors.ts` (the embedder entry and its cache, over
`SearchIndex.embedShortTexts` in `src/lib/hybrid-search`, which asks a worker only while
`Embedder.running()` says it runs), `thread-capture.ts` (`relatedOf`, `threadHintText`). Tests:
`tests/core/org/thread-related.test.ts`, `tests/lib/hybrid-search-short-texts.test.ts`,
`tests/e2e/threads-related.test.ts`. Limits: the replay scored threads by their titles and summaries
as they are now, not as they were; titles written in another language than his message rely on the
meaning lane, which on a quiet server (no search in 10 minutes, no backfill pass running) has only
its cached vectors and no query worker, so words alone.

### threads_one_id

One request, one id (2026-11-25, the user, of one request he saw as his VP's card and as a second
card the task opened: "two threads for the same thing"). When Main, a lead or a task with Threads on
hands a thread on with `thread` (task_send, task_start, task_create) to an open task of its own team
that keeps Threads, the thread moves to that task under the same id, through the cross-node move
(`movedTo` pointer on the node, `movedFrom` kind `hand` on the task). The node that handed it on
lists the task's one record, same id, while it has something for him (it waits on him, a result
for him, his reply on its way), whatever `threads_pop_up` says; its own pointer steps aside, so it is
never two cards, and his reply on it goes to the task (`thread-reply.ts`). The node's status counts
it as a card below, never its own Needs you. Once the task holds an open copy, that copy is the
thread: a move cut off between its two writes leaves the node's copy open too, which every read
hides (never a card or a count of its own), his reply skips, and the read that finds it moves again
into a pointer. A task that finishes while its handed thread waits on him gives the thread back to
the node that handed it (the follow pass, kind `work`), where it counts in that node's Needs you. A
thread handed on again is refused, naming the task that holds it. The task hears it in one line (about 140 bytes,
`sameIdTaskLine`) in the message that hands the work over: task_send and task_start decide before
the send (`thread-handoff.ts` `sameIdLineBeforeSend`, the same `sameIdDecision` the move runs) and
move after it succeeds, so a failed send moves nothing; a create puts it in the task's first
message. When the thread changed between the two decisions the move's wins, and a move the message
did not announce is told on the task's next message. Its own Threads now hold the thread, so the same-subject refusal and the status line's
`own` match find it.

A named thread stays on the node and only lists the task, as before, when it waits on him now
(`needs` or `askOwner`: he answers where he was asked), holds the node's decision letter, Board
choice or own ask, is watched or Known on the node's Threads, or lists other open tasks; the
caller's outcome then says why. `hands_on` without `thread`, a target in another team (the
cross-node rule) and a target that keeps no Threads behave as today. Off again, a moved thread stays
where it is and reads as an ordinary moved thread; nothing new is stored (`same_card` and `stays`
in `thread_handoff` are additive).

Code: `src/core/org/thread-one-id.ts` (switch, decision, lines), `thread-handoff.ts` (the hand-off's
outcome and lines, the decision before the send and at the move), `thread-one-id-view.ts` (the node's
read: by the task's `movedFrom`, which outlives the week a pointer is kept, and by its pointers),
`thread-follow.ts` `handOffThread`, `thread-popup.ts` `elsewhereThread`, `user-status-sync.ts`
counts, the threads route. Tests: `tests/core/org/thread-one-id.test.ts`,
`tests/e2e/thread-one-id.test.ts`, `tests/core/org/thread-handoff-paths-guard.test.ts` (every
hand-off route reaches the one decision). Limits: a thread handed on twice reads through on the
first node only while its pointer is kept (a week); a task_start with no message of its own gets
the line on its next message; a thread announced in the message that then stays (it changed in
the moment between) is not corrected to the task.

### threads_reminder

A reminder of the open threads now and then, in place of a line for every thread after every turn
(2026-11-25, the user, translated: "like that To Do": remind the agent of the threads it still has
open and of the ones nobody touched for long, the way Claude Code reminds a session of its to-do
list). It changes only which threads the status question at a turn's end lists; the answer's lines,
the reply's card lines (`threads_reply_tag`) and every write rule stay as they are.

- **Asked at every turn end:** a thread in the node's hands (new, working), since any turn may have
  finished it (a subtask's report, a background job's end, a peer's note); `thread-recheck.ts`
  leaves a quiet working thread to that line while the node's work carries on. Also a line its
  last answer dropped for asking him. An overdue one is marked so.
- **Asked once, until the thread changes again:** every need the question ranks first, each placed
  by name in `ASKED_BETWEEN` (his word after the summary, a summary owed, a card asking him outside
  needs, a joined message, a held title, an untitled or stale-asking title); a reaction to check on
  an answer in his sight (answered), once after each new message of his; a thread Walnut's overdue
  note named since it was last listed. A need asked with nothing moved since is asked again at the
  reminder: a line that changes nothing writes nothing, so it would otherwise be asked every turn.
  Nothing to ask: no thread block (a task keeps its one new-subject line).
- **The reminder** is one question in five (`REMIND_EVERY`), the first after a restart, a session of
  the task not reminded before, or a compaction, and sooner when a thread went overdue since the
  last one (`threadOverdue`'s reply clock, at most once per 30 minutes). Every need in full (more
  than 12: the one listed longest ago first), every other open thread short and grouped by state
  (`answered: t5 "Orchard fence" 2h, t6 ...; pending: ...`, titles cut to 40 characters, at most 60),
  with one rule: a line only for a thread that moved. A reminder by count or by an overdue thread
  leaves out the short items the node wrote since the last reminder and says how many.
- **With reply card lines** a thread the reply spoke for is left out of both; when every open thread
  was spoken for the question asks nothing about threads and is not counted.
- **Bytes**, measured on saved copies of the eight nodes with the most open threads (kept by
  Walnut): today's block is 3.0 to 4.5 KB on every turn. With the switch on: nothing on a quiet
  turn with nothing in hand (1.4 to 2.0 KB on the two nodes with threads in hand); 1.2 to 3.6 KB on
  a turn with one new message of his; 1.7 to 3.9 KB at a reminder (6.3 KB by count, 7.8 KB after a
  restart, on the one node with 65 open threads).

Code: `src/core/sessions/status-thread-remind.ts` (when, which, the short items),
`status-thread-question.ts` (`threadQuestionOf`, pure, and `threadQuestionFor`, which reads the file
and records the listing at the time of the read; re-exported from `status-threads.ts`),
`status-thread-pick.ts` (`NEED_RANK`, `needName`, `byNeed`'s `rotate`), `status-threads.ts`
(the block's words), `status-question.ts` (passes the session and its last compaction). Tests:
`tests/core/sessions/status-thread-remind.test.ts` (the rules, the switch off, the overdue note's
carry-on case, and a guard that every need name is placed), `tests/e2e/threads-reminder.test.ts`
(ten questions on a real server, a turn on a peer's note, card lines, then off).

Limits: the record of the last reminder and of when each thread was listed is in memory, so a
restart brings the reminder early. A question that gets no answer still counts. A need asked once
and left unanswered waits up to four questions for the reminder. A node with many answers he has
not reacted to lists each of them again after every message of his (on the 65-thread node that
turn costs about as much as today's).

### threads_audit

A small model reads the threads now and then, and only reports (2026-11-25, the user: "by default
it should rely on the agent. But we have an extra agent that scans once, maybe Haiku,
periodically"). Every 6 hours each node that keeps Threads and has open ones is checked once, one
node at a time (a clock look every 15 minutes, at most 12 nodes a look, oldest first). Four kinds,
most important first: `repeat` (two open cards on one subject, on the node or between the node's
card and one of a task below it or that its card names), `unasked` (a summary that asks him to
decide, `asksHimNow`, on a card not in needs), `stale` (new or working with nothing written for 24
hours, needs for 3 days) and `thin` (no summary on an answered or needs card, one that only points
elsewhere, `summaryPointsElsewhere`, or under 30 characters). The rules pick repeat candidates
(a card naming the other's id, two or more shared telling words of the same-subject index, the same
linked task); ONE fast-model call per node judges at most 10 pairs SAME, DIFFERENT or UNSURE with a
reason, from each card's title, ask and first summary sentence (never his messages). A verdict is
kept while both cards read the same (at most 14 days), so an unchanged pair costs no second call.
Only SAME is reported. Without a model (none set up, a timeout, a test run) the rule findings still go.

Only what is new is told: a finding's key is its kind and thread ids, and a key told is not told
again for 14 days; a later pass that no longer finds it counts it fixed. At most 8 findings a note,
each with its thread ids and the call that fixes it (`merge_into` for a repeat, the node's card
merging into a task's card; `state: needs` with options for unasked; its summary or status line for
stale and thin). A note with a repeat or an unasked decision wakes the node: a notification
(outcome `threads-audit`) into its session under the source `thread-audit`, as the re-check sends,
so the org's off switch blocks it and a parked wait comes back with its clock at the turn end
(`tests/core/wait-words-only-guard.test.ts`, `tests/e2e/thread-audit-wait.test.ts`); a session the
user stopped is not woken. One with only stale or thin rides the node's next message (`rideLine`,
key `thread-audit`); that slot keeps one note, so while one is unread the next carries its findings
still found, and a newer note never drops an older one. A full note is 0.8 KB typically, at most about 3.8 KB (8 findings, longest titles).
Nothing is merged, closed or rewritten by the check.

Counts per day (UTC) and per node, kept 60 days in `org/thread-audit.json`: passes, found, told and
fixed per kind, model calls and their milliseconds. Read them with `GET /api/v1/thread-audit`
(`?days=`, `?task=`) or the op `thread_audit`; `POST /api/v1/thread-audit/run {task}` (op
`thread_audit` with `run: true`) checks one node now, and answers `running` after 8 s while the
check goes on (2026-11-25, its first run in real use: one model call took 11 s and the op gave up
at its 10 s call bound with the route still holding). One log line per pass, counts only.

Leader only, never on an ephemeral server (`WALNUT_THREAD_AUDIT=0` turns the clock off), one clock
per process (a start replaces a clock left running; the server awaits its start, so a stop always
finds it), the switch
read at every node, skipped while background AI is off; a check run by hand does nothing while the
org is off. A node tried is not tried again for 6 hours in that process, even when it had no open
thread or its counts could not be written. A tree that could not be read finds no repeat and counts
none fixed; a told repeat is fixed only once a card of it is closed on the node, or both read open
and no longer one subject. Code: `src/core/org/thread-audit.ts`
(clock, pass, delivery, judge seam `setAuditJudgeOverride`), `thread-audit-rules.ts` (the kinds,
pairs, judge input, note), `thread-audit-store.ts` (the file and counts),
`src/core/fast-model-call.ts` (the one short fast-model call, shared with the join check),
`src/web/routes/thread-audit-v1.ts`, `src/ops/thread-audit.ts`. Tests:
`tests/core/org/thread-audit-rules.test.ts`, `tests/core/org/thread-audit-store.test.ts`,
`tests/e2e/thread-audit.test.ts`. On the 2026-11-25 export (95 nodes with open threads): 17 rule
findings (2 unasked, 11 stale, 4 thin), 173 candidate pairs on 23 nodes (half the nodes none, one
lead 132), and of 40 judged by the fast model 18 SAME, 21 DIFFERENT, 1 UNSURE, 16 of the 18 a real
repeat on reading. Limits: a node with more pairs than the cap takes a few passes to have them all
judged; a pair with a task above the node is judged when that task is checked.

### threads_each_question

Each question he asks is its own thread (2026-11-25, the user, after a question he typed in a node's
chat had no thread of its own: "each question I ask needs to have one thread, otherwise how can I
track"). He had asked question A, then 3.5 minutes later question B on the same subject; B opened
its own thread, and 32 seconds later the node's status answer merged it into A's
(`FOR_USER_THREAD_MERGE`), because the prompt said "several asks about the same thing are one
thread" and the status question offered the merge. On, "Every experiment on" included:

- **One predicate, by form** (`src/core/org/thread-question.ts` `asksQuestion`, no model): a question
  mark; why, how, what, which or who wherever it stands, unless the word before makes it part of a
  statement ("that is how it works"); when or where before an auxiliary and an auxiliary before its
  subject at a clause start; a few auxiliary forms anywhere ("is there a way", "can we"); a closing
  "right" or "correct" that is no agreement; or a Chinese question form; and at least 3 words or 4
  CJK characters; never a plain reaction. It leans towards yes. Measured on a week of real chat
  messages (2026-11-25): about 6 in 10 read as a question, and 7 in 10 of those had gone
  into another thread, so the switch makes about 3.5 times as many threads of his questions.
  A question opened beside a thread that waits on him is told to the node with that thread's id
  (`thread-capture.ts` `threadHintText`): only the node can say it answers that one.
- **Filing** (`threads-model.ts` `fileMessage`): such a chat message with no thread named joins no
  thread by timing and none as a reaction, even when the recent thread waits on him. A Follow up, a
  letter's note and a remark that asks nothing keep the old rules.
- **Merging** (`mergeThreads`, every merge goes through it): a thread his question opened
  (`ownQuestionOf`, its first message) is refused `own_question`, unless he merges it himself or the
  target already holds the very same words. A split's one message is refused only when it opened its
  thread. The refusal says to title it by what it asks and answer it there; the status answer's
  refused merge keeps a held title held, and its line and marks are written on that thread.
- **What nodes are told**: the prompt's sentence (bytes: 114 to 196; with Walnut keeping the threads,
  50 to 182; a running session hears the changed sentence); the status question offers no merge for
  such a thread and asks a held title again as a title of its own; the filing hint, the related
  threads, the turn-end check of answers before his message and the thread check (`threads_audit`)
  no longer tell a node to merge it.
- **The top of the chat says how many are being worked on** (2026-11-25: a question of his still
  being worked on sat in the folded Working group, the line read "1 thread (1 needs you)", and he
  concluded it had no thread). After its own words the line and the bar read "· 2 working", the
  Working group's count (`top-thread-model.ts` `workingThreads`, `hiddenLine`, the one place the
  words are built); with nothing for him the line shows alone ("2 working · Open", a click opens the
  Threads on the first of them, Working open). One line of text, no card; a thread moving between
  working and answered changes only its words, never its height or the chat's scroll. Every count
  for him (badges, the red line, Org rows, the tab, `user_status.threads`, the phone) stays
  `threadsForHim`. The phone draws no top of the chat, so it has nothing to change.
- Off: everything as before. Guards: `tests/core/org/thread-each-question.test.ts`,
  `tests/core/org/thread-each-question-guard.test.ts` (every call of `mergeThreads(` and
  `splitMessageInto(`, and every join kind of `fileMessage`, listed with its test),
  `tests/core/org/thread-each-question-prompt.test.ts`, `tests/e2e/thread-each-question.test.ts`.

## What the user's data showed (2026-11-23)

Read from one leader task and its six subtasks (64 threads), the tree the user reported:

- The leader task opened 12 threads in one second, each a copy of a dashboard problem its subtask
  already kept a thread on (each named that subtask in `tasks`). Cause: only a subtask's `needs`
  threads are listed in the leader's view (`thread-view.ts` `listedAbove`), so to show him the
  results the leader opened its own copies, and nothing refused them.
- The same node opened a second thread on one subject 19 hours after the first, in nearly the same
  title, and could not merge them: both were its own, and the merge refused either way.
- One rule error had five threads across the leader task and the subtask, one of them made by
  filing his letter answer as a new thread.
- A card opened with his voice message quoted: Walnut's own `returnedReply` wrote it.
- Replaying the new thread_create check over those 64 threads in the order they were made refuses 16:
  13 that name the subtask (the 12 copies and one that needs a `separate_reason`) and 3 by title
  (the pair he reported, one true repeat, one same cause in another region). It misses a subject told
  in other words (two of the five rule-error threads), which is why merge now works both ways.

## Known problems and their state

Newest first. State: fixed (with where), open (with who owns it next).

| Date | What the user saw | Cause | State |
|---|---|---|---|
| 11-25 | A question he asked in a node's chat had no thread of its own ("why there is no thread for this") | it opened its own, and the node's status answer merged it into the thread of his question 3.5 minutes earlier on the same subject: the prompt said several asks about one thing are one thread, and the status question offered the merge | fixed behind `threads_each_question`: each question he asks is its own thread (see above) |
| 11-25 | While he read the Threads list, a card that changed group still pushed what he saw (a review of the hold, item a: 186px in Chromium, 183px in WebKit, the pointer on a group's head at the top) | the card that moved was the one under his pointer (the matrix had picked its point before a move line from its last cell faded, so the pointer came to rest on that card), and a held card drawn again in another group was let go with no correction, so every card he saw moved by its new height: the same as a Needs you card he answers going to Done. Also, a press with no release (a ctrl-click's menu, a native drag) left the pointer counted as down, and a letter typed in a Follow up box counted as his scroll: either way WebKit's pull at the end of the list stayed in (376px) | fixed: when the card he reads leaves its place, the card drawn right before it (else right after it) holds the place until he moves or scrolls, so nothing above the pointer moves and the rest closes up under its line (`heldPlace` in `web/src/hooks/scroll-anchor.ts`, `useScrollAnchor.ts`); a move with no button, a wheel or a key lets a press go, and a letter typed in a text field is no scroll (`stepScrollInput`). The matrix waits for the last cell's lines and cleanups before it picks a point, refuses a pointer that rests on a card in a cell about the space between them, and has a column for his own card changing group (`tests/e2e/browser/threads-hold-matrix.spec.ts`, its columns now in `threads-hold-changes.ts`; `tests/web/threads-hold.test.ts`). Open: at the end of the list, his own card leaving below the rest still moves the cards above it (no scroll is left; it would need room at the bottom) |
| 11-25 | Replies of sessions with Threads on ended with one line per open thread, often under a heading or inside a tag the session made up | the Threads rule said each turn ends with a line for each thread, and a Claude Code session never sees Walnut's status question in its own chat, so it wrote the lines into its reply | fixed: every screen hides a reply's trailing thread-status block, with its heading and a made-up tag around it (`src/lib/internal-lines.ts` `stripInternalLines`: the web chat, the history every client reads, push, the thread takeaway, ACP; the phone's `InternalLines.swift`; both run `tests/fixtures/internal-lines/cases.json`). Precision first, since a review found the first version hid his content: only a block that is strictly the reply's end goes (a list item, paragraph, table row or quote after a thread line keeps everything; only a line indented under a thread's item carries it on); a table row, a quote or a sentence that names a thread is never a thread line; an item that says its state in free words counts only under a heading, in a made-up tag or beside a line with a known state word; and the block stays when it is the whole reply, follows one sentence (sentences, not lines: a version, a file name, a time or a URL never ends one) or a lead-in (a colon, "as follows", "below", a sentence naming the threads), holds a link, a path, a letter, a task ref or a relative image the reply keeps nowhere else, has a line that waits on him (state needs or new, or words that ask him: a decision, a review, a question, news to answer; a second review found 39 real replies whose decision was hidden, some on threads in waiting, which his Threads view does not show), or ends a longer list. On 834 real replies 268 change, 234 still end with a block (the accepted miss), none hides a link or path the shown text lacks, and the review's reproductions all keep their content. Every text that asks for those lines says they go in Walnut's status question after the turn, in the reply only if he asks (`THREAD_LINE_CHANNEL`). The phone reads text as the server's JavaScript does (whitespace, trim, digits, word ends, the line split): on the 834 replies both show the same text at all 33,469 points tried. Guards `tests/lib/internal-lines.test.ts` (with its list of shapes that must show), `tests/core/sessions/status-threads-kept.test.ts` |
| 11-25 | thread_split takes a title for the new thread. Real use on 11-24: a node sent a title with its split, was refused `bad_args`, and the split's answer then asked for a second call to give the thread a title | the op took no title | fixed: `title` is written on the thread the split made, in the same call, with thread_update's own write (the split route is unchanged); with merge_into, or on a thread Walnut split out before that has a title already, it is not applied and the answer names it in `not_applied` (`src/ops/org-threads.ts` titleSplitThread; `tests/mcp/org-answers.test.ts`, `tests/e2e/thread-split-route.test.ts`) |
| 11-25 | Two cards about two things on one screen were read as one repeat (the thread monitor's [dup]): one said a row of a list looks bad, the other that other rows' names there are too long | both titles opened with the list's name, three shared words in a title of six, which is all the title check asks for; what each went on to say was not looked at | fixed: two titles that share only the words both open with, each going on for at least as long with words the other has none of, are two matters (`sharesOnlyOpening` in `thread-same-subject.ts`; the refusal still names such a card as a candidate, it is no clear repeat). Still a repeat: a title that only adds to the other, one word of its own after the opening, a word shared after a word of its own, and two that share the larger part and differ in where the matter stands. On a copy of his threads that day: 14 strong title matches before and after, none lost (the first version of the rule, without the length test, lost one true repeat there). Guard `tests/core/org/thread-same-subject.test.ts` |
| 11-25 | Two cards on two matters were read as one repeat (the thread monitor's [dup]): each title named its own subject before a colon and both ended in the same state ("comments posted to the design doc" of one person) | the title check counted every shared word alike, so a shared state, person or area outweighed two subjects that shared no word; the same check decides where a status line's new subject goes, so such a line could land on the other card | fixed: a subject named before a colon that the other title does not hold is another matter (`headWords` in `thread-same-subject.ts`). On his data that day: 20 strong title matches before, 15 after, the 5 dropped all two matters (one state on two fixes, one finding in two regions); one such pair with no word-free head is still matched. Guard `tests/core/org/thread-same-subject.test.ts` |
| 11-25 | One decision showed as two cards, a task's and its lead's, both waiting on him. The task had written its card with `supersedes` naming the lead's card, and the answer listed `supersedes` among what changed | `supersedes` was applied only to the writer's own asks in the file it wrote; any other id was dropped without a word, while the same-subject gate already let the write through for a card named there. The lead's own way out, `ask_owner`, answered that the task "asks the user nothing" because its ask was on a thread, not in its status | fixed: every id `supersedes` names is acted on or refused, never dropped (`thread-supersede.ts` `namedElsewhere`, `namedVerdict`, `setAsideNamed`). A thread on the Threads around the writer (the file it writes, its own, the open tasks above, below and beside it) that waits on him is taken off there when it is the writer's: on its own Threads, on a node below it, opened by it, pointed at it, or naming it and no other task. It closes with the line naming where it is asked now, its buttons gone (while an answer on it is still his to read it steps aside open instead). One that asks him nothing now is left (a retry). Refused by name, with nothing written: another task's card, one that names other tasks too, an id that names nothing within reach, a letter that is not the writer's, and (a review found the first version hid them) any card with something of his on it: a word of his unanswered, a reply on its way, a decision letter, a Board choice, a task's own question shown through it whatever state it stores (`thread-ended.ts` `heldWhy`, judged again inside the lock). A card he watches or snoozed is not refused: it steps aside open and stays in his Watching (the card that showed the bug was one he watched). `supersedes` goes only with a thread that waits on him: on a result or a write that asks nothing it is refused, where it used to pass the same-subject check and do nothing. It holds on a later write of a card already in needs too. `ask_owner` naming a task that asks on a thread of its own now says so and names the way on. Guards `tests/core/org/thread-replaced.test.ts` (every state in every place has one of three outcomes; every reason `heldWhy` knows is refused), `tests/e2e/thread-one-matter.test.ts` (two nodes on a real server) |
| 11-24 | Seven of his messages in a day went into an unrelated thread only for coming within three minutes of his last one (a complaint about Notes in the thread about the phone link); the Walnut VP split several by hand (its words: file by subject, not by timing alone, or open a new thread when unsure) | the join was by timing alone, and the node's turn-end check kept it unless it wrote a split line | fixed: a message joined by timing is checked for its subject when it is filed, one call to the fast model on the thread's title and his last words there; NEW or UNSURE takes it out into a thread of its own (untitled, and its source listed beside it at the turn end to merge back), SAME or no answer keeps the join for the node's check. On 425 such messages of his VP it took out 45 of the 72 that now sit in another thread (`thread-join-check.ts`; `tests/core/org/thread-join-check.test.ts`) |
| 11-24 | Real use: thread_split refused `no_message` twice, 4 s after the subject check took the same message out (the node acted on the filing hint "thread_split it out") | the check and the node both split the one message; the second found it gone | fixed: a split of a message already alone at the head of a thread of its own answers done (`already_split`), with merge_into it goes there from where it is now, and one merged inside another thread is refused naming where it is (`thread-join-check.ts` splitWhereItIs; `tests/core/org/thread-join-check.test.ts`) |
| 11-24 | The thread monitor's [dup]: one node kept two decision cards for one approval; it opened the second with a separate_reason that described the first as moot, then rewrote the first to send him to the second ("the step to approve is in thread \u300c<title>\u300d") and left it waiting on him | the asks-him-elsewhere check needed the summary's question to read as one, and its patterns did not know a thread named by its quoted title | fixed: a card in needs (or moved into needs) asks him by its state, so a summary there that sends him to another card is refused whatever its question's words; the patterns take a card or thread named by a quoted title (`thread-summary-content.ts` ON_ANOTHER_CARD; `tests/core/org/thread-decision-card.test.ts`). Of 22 open decision cards on his Mac, none is newly refused |
| 11-24 | Two code reviews waiting on him in one area, each named by its own review id, read as one subject repeated (the thread monitor's [dup]) | title words alone: the area's words were shared, the ids were not compared | fixed: two titles that each name an item (a review or ticket id, a long number) and share none are two matters (`thread-same-subject.ts` `candidatesIn`; `tests/core/org/thread-same-subject.test.ts`) |
| 11-24 | One subject had two or three threads on the Walnut VP, about nine subjects in all (the threads inspection, item 5; "why the fuck there are so many dupciated thread") | a message of his more than three minutes after his last opens a thread, and the status question could merge it only into a listed thread, which the older one on its subject often was not; title words found 1 of 11 such repeats | fixed: an untitled thread of his comes with the threads it may belong to, listed right after it and named on its line (the two he wrote in last within a day, then the one its first words read like; a decision waiting on him included, with no line asked), so the node's merge line can put it there: on his VP the older thread came with it for 6 of the 11 repeats (`status-thread-title.ts` `nearThreads`, `status-thread-pick.ts` `byNeed`; `tests/core/sessions/status-thread-near.test.ts`) |
| 11-24 | One decision showed on two cards on Main: a request of his the node had put in needs, and a card of the node's own asking the same task's pick; the old one later said only that the new card asks it, in Done (the threads inspection, item 9) | a node's other open asks were only the cards it opened itself, so his request in needs for the same task was never named as replaced; a replaced card only stepped aside to pending, where a later line could write it into Done as a pointer | fixed: his request the node put in needs for a task the new ask names is one of its open asks (`thread-supersede.ts` `ownNeedsThreads`); named as replaced it closes with where it is asked now, unless something of his is still on it (`closeReplaced`, `thread-ended.ts` `holdsHim`); the six-hourly sweep closes a card left before: answered or pending, nothing of his on it (no word unanswered, no answer unread), its summary only pointing elsewhere, beside an open decision card it names or, when it once waited on him itself, one of the same task (`replacedBy`); `tests/core/org/thread-replaced.test.ts`, `tests/e2e/thread-one-matter.test.ts` |
| 11-24 | His threads out of sight never closed (the threads inspection, item 3: 79 of his VP's 92 open threads were pending, 26 naming only completed tasks, some for three weeks; every check that reads the open threads read them all; the user, 11-23: empty threads close) | every closer needed him (Acknowledge, a reaction) or a node's line | fixed: Walnut's six-hourly sweep closes a pending thread that is not watched, snoozed or being placed after his Acknowledge, holds nothing for him (`HOLDS`, one per kind in `thread-holds.ts`), has no reply of his on its way and no word of his the node has not answered (a status line's summary is no answer), when every task it names completed three days ago and none still shows him a thread of its own, or when it names no task, the node did not open it and nothing was written for 14 days (`thread-ended.ts`; closed `dropped` by `agent`, in his Done for its week). On his VP: 14 of 99 open threads close, none in his sight. Reviewed (independent, one round: four findings fixed). Guard: `tests/core/org/thread-ended.test.ts` (every state and every kind a thread holds) | fixed |
| 11-24 | A card in his Done kept a title asking him to pick after his pick shipped (VP "new task panel: three designs, please pick one"; the threads inspection, item 8) | the status question asked for a title only while a thread was untitled, so a line changed the summary and state and never the title | fixed: a titled thread out of Needs you whose title asks him (`asksHimNow`) is asked for a title naming the subject as it stands (`status-threads.ts` `staleAskTitle`, `RETITLE_WORDS`); only such a thread takes a title line. On his VP and Main, one card each. Guard: `tests/core/sessions/status-thread-retitle.test.ts` | fixed |
| 11-24 | Writes that change nothing he reads moved cards in his list (the threads inspection, item 11: a reworded or held title, a seen mark, a task link, a message split out or joined by timing; the order hold lasts only while the pointer is over the list, so in the chat or on a phone it jumped) | his lists sorted by `updatedAt`, which every write moves | fixed: his lists and groups order by `changedForHimAt` (`thread-view.ts`): the latest of the summary, the hand-over to him, a message of his on the card, an answer, the first post and the close. On his VP, 7 of 99 open threads were last written with nothing he reads changing. Guard: `tests/core/org/thread-order-changed.test.ts` (no list of his sorts by `updatedAt`) | fixed |
| 11-24 | Five of his messages on a decision card were off the card for 13 hours (a task's card listed on Main; the threads inspection, item 6) | a message joined to a thread only for its timing is hidden until the node's status answer checks it, and a thread in needs was never listed for that check; a mark not checked within a day was swept as checked, so his words read as his reaction with nobody having looked | fixed: a thread in needs with a join is listed for the check alone, no line asked for it (`status-threads.ts` `threadQuestionFor`, `NEEDS_JOIN_WORDS`), and a mark not checked within `JOIN_CHECK_MS` shows his words on the card but never reads as his reaction (`thread-view.ts` `uncheckedJoin`, `readsAsReaction`; the sweep is gone). Guards: `tests/core/sessions/status-thread-join-needs.test.ts`, `tests/core/org/thread-join-keeps-card.test.ts` | fixed |
| 11-24 | A card he acknowledged could come back with nothing new (the threads inspection, item 10; code only, no live case after the 11-23 fixes) | the brake after his Acknowledge was on the status line alone (`lineMay`): a node's own `thread_update` could write the same result again on a card still pending or closed for his Acknowledge (that close reopens on news), and a chat answer Walnut attached late, given before his Acknowledge, read as unread news | fixed: a node's words that add at most one telling word to the summary he acknowledged are refused (`thread-ack-repeat.ts` `repeatsAcknowledged`, `he_has_it`), a close and a needs hand-over aside, and his Acknowledge covers every answer given before it (`thread-view.ts` `exchangesOf`); on his VP's 204 threads nothing he sees changed. Guard: `tests/core/org/thread-ack-news.test.ts` (every door of a node's words on an acknowledged card) | fixed |
| 11-24 | A card in his Done said only that it was replaced by a newer card and to pick there (Main's, written by a status line; the threads inspection, item 7: the summary check covered two of the doors that write a node's words on his card) | a done line closing his acknowledged request, its fallback and a new subject's first post wrote a line's words unchecked; a node's close skipped the check; "replaced by the new card" and "please pick on the new card" were not read as a pointer and an ask | fixed: one check for every line's words (`status-threads.ts` `lineWords`), a node's close with words is checked like any summary (`threads-model.ts` `updateThread`), and the two forms are read (`thread-summary-content.ts`). A/B on 396 saved summaries of his VP, Main and tasks: only that card flips. Guard `tests/core/sessions/status-thread-words.test.ts` |
| 11-24 | A result on a task below never reached the lead where he had asked (the threads inspection: his VP held cards naming six tasks below it, and 21 unread results on those tasks showed only on the tasks' own Threads; four of them answered the subject of a VP card waiting out of his sight) | only `needs` threads of a task below were listed above (`listedAbove`), and the lead's card and the task's card of one subject had no link | fixed: a task's unread result is listed on the node whose own thread names that task and reads nearest its title (`thread-subject-pairs.ts` `subjectPairs`, `carries`), its Acknowledge there closes it on the task, and the node's card waits behind it until the node writes it again, but only while that card is out of his sight (nothing of its own unread, no word of his unanswered past the reminder) and no word of his on it is newer (a pairing on a few shared words can add a card, never hide one), and stays quiet after he read the result whatever state his Acknowledge left it in (`ack_means_known` leaves it pending); the Board card, a change made from the list and the single read agree with the list; experiment `threads_pop_up`. Guards: `tests/core/org/thread-subject-pairs.test.ts`, `tests/core/org/thread-carried-readers-guard.test.ts` (every reader of the threads below lists the carried ones) | fixed |
| 11-24 | The status question named only the 12 threads changed last, and each line moved the same 12 first again, so threads that needed a line were never asked (the threads inspection: on his VP 25 of 91 open threads needed one, 1 of them was among the 12) | the list was cut at `THREAD_LIST_MAX` in newest-first order, and a line moves `updatedAt` | fixed: the question lists by need first, newest within a need (`sessions/status-thread-pick.ts` `needRank`): a line that asked him, a join or held title to check, his words after the summary, an overdue reply, another summary owed, untitled, a reaction to ask about, then the rest; a thread drops back once it got its line. Below the needs the places go round, listed longest ago first (a line that changes nothing writes nothing, so newest first listed the same 10 of 89 each turn: review 2026-11-24), and a held title brings the thread it reads like right after it. On his VP's two saved copies: 12 of the 12 named need a line (1 and 5 before). Guards `tests/core/sessions/status-thread-pick.test.ts`, `tests/core/sessions/status-threads-prompt.test.ts` |
| 11-24 | A decision of his sat in Done with no buttons and nothing in Needs you (the threads inspection: four live cards; one asked him to answer once more after he had answered five times) | only `thread_update` can hand a thread to him, and the status line, the only keeper of a node's threads with `threads_kept_by_walnut` on, writes no needs; the one check (a summary that asks him and names another card) returned early on any path or link, and the ask words read neither Chinese with words between nor "waits for your consent" | fixed: every door that writes a node's summary refuses, or writes nothing for, words that say a decision of his waits (`thread-summary-content.ts` `asksHimNow`) unless the thread is handed to him: `thread_update` and `thread_create` answer 422, a status line is not written and the next question names the thread first and says where a decision goes (`sessions/status-thread-asked.ts`); the pointer check runs before the proof test; Chinese words of choosing count (`thread-options.ts`). Read clause by clause: never after a "not" shortly before it, never as a description (a verb followed by the possessive particle), English only with a decision noun, so a result that only mentions him ("no need to wait for your OK", "waiting for your Mac to wake") is never pushed into a fake Needs you (review 2026-11-24). An inbox update that asks him stays a letter (`letter-to-thread.ts` `letterOnlyReason`); a new subject from a status line opens with its title. A card an older build stored asking him is named first in its node's next status question (`status-thread-asked.ts` `markAsks`, the thread monitor's [ptr] of 11-24 on Main). Checked on two saved copies of his VP (82 and 48 open summaries): three real asks match, no other. Guards `tests/core/org/thread-asks-outside-needs.test.ts`, `tests/core/human-inbox/letter-to-thread-ratchet.test.ts` |
| 11-24 | The pick-a-design card was up twice on the Walnut VP ("why the fuck there are so many dupciated thread"): the VP's card of his request, with the designs' result on it (Done), and the card of the task it was handed to, asking him to pick; he answered on the VP's and the task's kept waiting | nothing joined a lead's card with the card of the task it was handed to: "one decision shows once" (`thread-task-ask.ts`) read only a task's status ask from its session or its Board, and since every task keeps Threads a task asks him on a thread of its own | fixed, two parts. Read: a lead's result (answered) waits behind the thread of a task it names (or a task under one) that asks him, when the lead wrote it while that thread was already asking (one in his view before stays there), and its title is the nearest of the lead's threads naming that task, three telling words in two places of the title at least (an area's name of four CJK characters is three pairs in one place: review 2026-11-24) (`heldResults`); it reads pending with `askedIn` (`via: 'thread'`) on every surface (list, one thread, Board state, counts, push), and stays behind once he answered that thread, until its node writes it again, which is news. Write: two asks are never hidden behind one another (a pointer could hide a decision he never answered); a node handing him a thread while a task around asks its subject on a thread of its own is refused, `same_subject`, unless `separate_reason` says how it differs (`thread-same-subject.ts` `refuseSameSubjectAsk`). Replayed on his VP's last 96 hours: the reported pair held (6 of 385 quarter-hours), no other card held, no ask hidden. Guards `tests/core/org/thread-task-ask.test.ts` (a result waiting to be read ...), `tests/e2e/thread-fold-under-task.test.ts`, `tests/e2e/browser/thread-fold-under-task.spec.ts` |
| 11-24 | A Done card on the Walnut VP said the three new designs were "on the pick card ... waiting for your pick", and he could not find that card ("where is it ... each thread should be self contain have all necessary context") | the pointer check knew only "told you / see the chat", not "on another card"; and a card asking him to decide sat in Done or hidden (eight such cards in his data that day), while only a needs card reaches his Needs you or a lead's view | fixed: a summary that asks him to decide and sends him to another card or task for it is refused by every writer (`thread-summary-content.ts`), and a card asking him to decide that is not in needs is named to its node in the threads-tidy note (`thread-capture.ts`). Guard `tests/core/org/thread-decision-card.test.ts` |
| 11-24 | The Walnut VP opened a card asking him for a decision its subtask was asking, naming that subtask, which kept the subject in its own threads (the thread monitor's [copy]); a reason about its other open asks let it through | the copy rule reads at most 40 tasks around the node, in tree order: the VP had 59 open tasks below it and the one its thread named came 47th, so the rule never read it | fixed: the tasks a thread names are always read, then the rest by relation and newest change (`thread-same-subject.ts` `treeOpenThreads`). Guard `tests/e2e/thread-same-subject.test.ts` (45 open tasks before the named one) |
| 11-24 | Two cards with one title on the Walnut VP ("新任务创建后没跑：文件夹不存在却不提前警告" twice; the thread monitor's [dup]) | a status answer split two of his joined messages out of a thread and titled the new one exactly like its source; a split's title was never compared with its own source ("the answer said another subject") | fixed: a split's title is held like any title that repeats an open thread, its source included, and the next question asks merge or name (`sessions/status-thread-title.ts`); guard `tests/core/sessions/status-thread-title.test.ts` |
| 11-23 | After every turn of the Walnut VP the screen flashed: "会显示好多好多不同的 thread 或者 task ... 然后最后又消失" | the turn-end status question is a side question that never sees its own last answer, so the node wrote every card it was asked about anew each turn (12 of 12 on his VP, the same state in new words; median likeness to the last summary 0.47): the cards in Done changed their words and height and re-sorted under his eyes | fixed: the question quotes each answered card and asks for a line there only when its result changed or it is done, and a working or waiting line on a result he has not read writes no progress over it (`sessions/status-thread-card.ts`); hidden threads take their lines as before, so the task's own state still reads from them. Guards `tests/core/sessions/status-thread-card.test.ts`, `tests/e2e/browser/threads-turn-end-still.spec.ts`; the 7-day monitor counts, from the saved versions of each node's threads, the answered cards that still held and were rewritten per status answer: 1.81 across all nodes and 3.31 on the VP (up to 5 in one write) in the 2 h before the fix went live, 0.22 and 0.25 (never more than 1 in one write, each a real update) in the 2 h after |
| 11-23 | Cards he acknowledged came back "New since you acknowledged" each turn, on a ticket task (three times in one day) and on the Walnut VP (8 cards) | his Acknowledge left the thread pending, and the node's next turn-end line (answered or done, the same result in new words) wrote it answered with a new summary, which read as news | fixed: `thread-known.ts` `ackHoldsResult` (see the guards above). Replayed on both nodes' real threads: of 12 cards he sees, acknowledged and then given one line each, the old code brought back all 12 with an answered line and 5 with a done line; the new code brings back none with done (all 12 close) and, with answered, only the 2 he acknowledged while their work still ran, whose result is news. Same day, after it went live: a card a ticket lead had placed in Waiting (its fix pipeline ran) came back each turn, because the rule still read a line after the node's placement as news; that exception is gone, and a card a line already flipped reads as no news at once, with no write. Review round 1 (function 5): the first fix also swallowed real results (an ack while work ran, then the result by a done line); narrowed to this rule | fixed |
| 11-23 | A card from a task below, in Working, sat at the top of a task's Threads ("why this is working but still show in the up there") | a card below is listed while his reply to it is on its way (so his words do not vanish); the groups drew it in Working, but the plain list beside a chat drew it among the cards for him | fixed: `thread-view.ts` `forHimInList`, the plain list puts it with the ones in progress (`tests/core/org/thread-on-its-way-list.test.ts`) | fixed |
| 11-23 | The Threads view jumps while he reads it: cards above appear, vanish or re-sort, "it keeps flashing" | the list re-sorts by newest change on every write, and WebKit has no scroll anchoring | fixed: `useThreadsHold.ts` | fixed |
| 11-23 | A leader's Threads view gathers the threads of the tasks below; a card does not say clearly whether it is the leader's own or which child task it came from | the card names only who opened it | fixed: every card says "You asked this task", "Opened by this task", "Moved here from <node>" or "From <task below>" (`web/src/components/org/thread-origin.ts`), and a filter (All, This task, each task below) sits above the list when any thread comes from below |
| 11-23 | After batch 2 went live, his own example card ("told you where these two tasks are", with a version number in it) still passed the summary check | the clause split broke at the dot of the version number, and a Chinese question word at the end of the clause was not read as an open question | fixed: numbers, versions and times stay one clause; a question word anywhere after the pointer makes it pointer-only. On his 58 real summaries it refuses exactly his two cards |
| 11-23 | A card opened with his own voice message quoted ("you said at 06:48: ...") | Walnut's `returnedReply` built the card from his words | fixed: the decision first, never his words; `summaryRepeatsHim` |
| 11-23 | A leader's results from its subtasks are not in its Threads view, so it copied them (12 threads in one second) | only `needs` threads of a task below are listed above | copies refused (`copyRefusal`). By design a task's result stays on that task (one place); a leader lists a thread from below only while it waits on him or his reply is on its way (`thread-view.ts` `listedAbove`), filtered by source. Listing every result above would light the same card on every level; since 11-24 a result is listed only on the node whose own thread on its subject names that task (`thread-subject-pairs.ts`) |
| 11-23 | His answer to a decision letter was filed as a new thread beside the thread that asked | the letter's thread and the task's thread are two objects | open |
| 11-23 | A card's whole summary was "the stand-up summary was given to you" | no content check on summaries outside `needs` | fixed: `thread-summary-content.ts`, the status question's line format |
| 11-23 | One issue got two or three threads in a row, on a task and on its own subtask | no subject check on thread_create; status lines checked only the exact title | fixed for copies and near-same titles: `thread-same-subject.ts`; a subject told in other words still gets through (merge it) |
| 11-23 | His "Done" became a new thread | filing joined only messages within 3 minutes | fixed: `isPlainReaction` in `fileMessage` |
| 11-23 | A message on another subject sent within 3 minutes of his last one joined that one's thread (the lead split three by hand) | the recency join cannot read subjects, and the hint asking the node to split was never acted on | fixed: the status question asks the node about each such message and its split line splits it (guards above). On his data a reader judged 38 of 535 such joins another subject (7%), 37 on one lead; word rules caught at most 68 of 90 with 246 of 535 wrong, so the node decides. A replay of the question on his two misfiles and four same-subject joins split exactly the two |
| 11-23 | A lead opened a card asking him to review a subtask's change, naming that subtask, which kept the subject in its own threads (thread monitor `[copy]`) | its separate_reason (about another card of its own) let it past the copy rule | fixed: a separate_reason passes the copy rule only when it names that task (`reasonCoversTask`) |
| 11-23 | His second word on a subject, 40 minutes after the first, opened a second thread the node titled like the first (thread monitor `[dup]`) | a title line names the new thread without checking the open ones | fixed: the answer can merge an untitled thread into a listed one at once (`FOR_USER_THREAD_MERGE: <ref> \| <other ref>`); a title that repeats an open thread instead (a title line's or a split line's) is held and the next status question asks once whether the two are one subject, and no line writes the held title. A title match alone never merges: in review, word overlap merged different problems ("build fails on Sonoma" and "in CI") |
| 11-23 | Two threads the node opened could not be merged either way ("was opened by you with its own first post") | the merge refused any `from` with an opener | fixed: `mergeThreads` |
| 11-23 | A merge into a thread on another task of the same tree failed (`no_thread`) | merge looked only on the node's own file | fixed: `thread-tree-merge.ts` |
| 11-23 | thread_move to a subtask landed on the VP and could not move back (`same_node`) | the target collapsed to its Org node even when the task keeps threads | fixed: `thread-follow.ts` `moveTargetOf` |
| 11-23 | A task's ask said to be its subtask's decision was refused ("No task in this node's team") | ask_owner matched only a full id | fixed: `thread-task-ask.ts` `askOwnerTask` (its subtree, a unique id prefix) |
| 11-23 | The question card above a chat took half his small screen | the strip had no height cap or fold | fixed (Hide folds it to one line) |
| 11-23 | A task row drew a decision its thread held as one red "Needs you" line, cut short ("ugly, not right ... I want this style for all") | the 255a874d2 row line | fixed: every row draws the full question card again (`tests/core/action-needed-ratchet.test.ts`) |
| 11-23 | One question was drawn as a task-row card and as a thread line | rows did not know the thread held it | changed: the row card stays (his pick above); the top above a chat draws it once |
| 11-23 | An answered card he had just read turned Working and left his view when he sent the next chat message on another subject ("我随便一聊，它就直接就消失") | a message joined only for coming within 3 minutes of his last one made the thread the node's turn and read as his reaction to its answer | fixed: such a message moves nothing on an answered or pending card (no state, no read mark, not on the card) until the node's status answer checks it; the reply clock still wakes the node; a decision in needs takes it as his answer, as before (`threads-model.ts` fileMessage, `thread-view.ts` uncheckedJoin; `tests/core/org/thread-join-keeps-card.test.ts`) |
| 11-22 | A VP wrote a thread before every chat reply | the rules asked for a thread write each turn | fixed: `threads_kept_by_walnut` (status lines) |
| 11-20 | A card stayed unread while he kept talking about it in the chat | his chat words did not count for that thread | fixed: `thread-summary-stop.ts` |
| 11-01 | A node closed a thread right after answering it, before he read it | close was not tied to his reaction | fixed: `checkReacted` |

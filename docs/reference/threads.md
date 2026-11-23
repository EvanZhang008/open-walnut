# Threads: rules, default instructions, code guards and known problems

One page that tracks everything about Threads: what the agents are told, what the code enforces,
which experiments change it, and every problem the user hit with its fix and its state. The design
background is in [Org, Brief, Threads and inbox](org-and-inbox.md); this page is the tracking list.
Update it in the same commit as any change to a thread rule, guard or problem below.

## What a thread is

A thread is one of the user's subjects with one node: Main, a lead (VP), or a task with Threads on.
Walnut files every message he sends that node into a thread and puts the node's chat reply under
it. His Threads view shows a thread only when it needs him (`needs`) or its result is in
(`answered`). A thread of a task pops up to the leaders above it (`threads_pop_up`), stored once.

Two rules the user set and every part below serves:

- **One subject is one thread, kept by one task** (2026-11-23: "one thread is one issue"; "it should
  be maintained by a single task ... so that it wouldn't cause a single thread to appear in all
  different places, like in VP, in leaders, and in the subtask"). A leader sees the threads of the
  tasks below in its own view, each named by the task it comes from; it never copies them.
- **A card reads alone**: its title and summary say the result or the question itself, for someone
  who never saw the chat (2026-11-23: "the thread should be readable self contained"), and never
  say his own message back to him ("my words are sometimes messy; summarize it, or just say the matter").

## The default instructions (what agents are told) and where each lives

| Text | File | Reaches |
|---|---|---|
| The Threads setting: one thread per subject, filing, states | `src/core/sessions/session-context.ts` (`threadsLine`, `threadsKeptLine`) | the node's prompt |
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
| A decision is not asked twice in one task tree | `src/core/same-ask-tree.ts`, `threads-store.ts` `refuseSameAskThread` | `tests/core/same-ask*.test.ts` |
| A node's other open asks are named as replaced or as other decisions | `src/core/org/thread-supersede.ts` | its tests |
| Known or closed only after his reaction | `threads-model.ts` `checkReacted` | `tests/core/org/threads-model.test.ts` |
| A card handed to him (`needs`) is clear: options, no bare opening, user_kind | `src/core/org/ask-clarity.ts`, `user-kind.ts` | `tests/core/org/ask-clarity-doors.test.ts` |
| One question is drawn once at the top of a chat and in the Threads view; a task row always draws the full card | `src/core/org/thread-holds.ts`, `web/src/components/org/top-thread-model.ts` | `tests/web/top-thread.test.ts`, `tests/core/action-needed-ratchet.test.ts` |

## Experiments that change Threads

`task_threads`, `threads_sqlite`, `threads_pop_up`, `action_needed_everywhere`, `top_thread`,
`reply_thread_line`, `letters_as_threads`, `threads_one_card`, `threads_kept_by_walnut`,
`brief_off` (all in `src/core/experimental.ts`; "Every experiment on" turns on each one never set alone).

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
| 11-23 | Cards he acknowledged came back "New since you acknowledged" each turn, on a ticket task (three times in one day) and on the Walnut VP (8 cards) | his Acknowledge left the thread pending, and the node's next turn-end line (answered or done, the same result in new words) wrote it answered with a new summary, which read as news | fixed: `thread-known.ts` `ackHoldsResult` (see the guards above). Replayed on both nodes' real threads: of 12 cards he sees, acknowledged and then given one line each, the old code brought back all 12 with an answered line and 5 with a done line; the new code brings back none with done (all 12 close) and, with answered, only the 2 he acknowledged while their work still ran, whose result is news. Same day, after it went live: a card a ticket lead had placed in Waiting (its fix pipeline ran) came back each turn, because the rule still read a line after the node's placement as news; that exception is gone, and a card a line already flipped reads as no news at once, with no write. Review round 1 (function 5): the first fix also swallowed real results (an ack while work ran, then the result by a done line); narrowed to this rule | fixed |
| 11-23 | A card from a task below, in Working, sat at the top of a task's Threads ("why this is working but still show in the up there") | a card below is listed while his reply to it is on its way (so his words do not vanish); the groups drew it in Working, but the plain list beside a chat drew it among the cards for him | fixed: `thread-view.ts` `forHimInList`, the plain list puts it with the ones in progress (`tests/core/org/thread-on-its-way-list.test.ts`) | fixed |
| 11-23 | The Threads view jumps while he reads it: cards above appear, vanish or re-sort, "it keeps flashing" | the list re-sorts by newest change on every write, and WebKit has no scroll anchoring | fixed: `useThreadsHold.ts` | fixed |
| 11-23 | A leader's Threads view gathers the threads of the tasks below; a card does not say clearly whether it is the leader's own or which child task it came from | the card names only who opened it | fixed: every card says "You asked this task", "Opened by this task", "Moved here from <node>" or "From <task below>" (`web/src/components/org/thread-origin.ts`), and a filter (All, This task, each task below) sits above the list when any thread comes from below |
| 11-23 | After batch 2 went live, his own example card ("told you where these two tasks are", with a version number in it) still passed the summary check | the clause split broke at the dot of the version number, and a Chinese question word at the end of the clause was not read as an open question | fixed: numbers, versions and times stay one clause; a question word anywhere after the pointer makes it pointer-only. On his 58 real summaries it refuses exactly his two cards |
| 11-23 | A card opened with his own voice message quoted ("you said at 06:48: ...") | Walnut's `returnedReply` built the card from his words | fixed: the decision first, never his words; `summaryRepeatsHim` |
| 11-23 | A leader's results from its subtasks are not in its Threads view, so it copied them (12 threads in one second) | only `needs` threads of a task below are listed above | copies refused (`copyRefusal`). By design a task's result stays on that task (one place); a leader lists a thread from below only while it waits on him or his reply is on its way (`thread-view.ts` `listedAbove`), filtered by source. Listing results above too would light the same card on every level |
| 11-23 | His answer to a decision letter was filed as a new thread beside the thread that asked | the letter's thread and the task's thread are two objects | open |
| 11-23 | A card's whole summary was "the stand-up summary was given to you" | no content check on summaries outside `needs` | fixed: `thread-summary-content.ts`, the status question's line format |
| 11-23 | One issue got two or three threads in a row, on a task and on its own subtask | no subject check on thread_create; status lines checked only the exact title | fixed for copies and near-same titles: `thread-same-subject.ts`; a subject told in other words still gets through (merge it) |
| 11-23 | His "Done" became a new thread | filing joined only messages within 3 minutes | fixed: `isPlainReaction` in `fileMessage` |
| 11-23 | A message on another subject sent within 3 minutes of his last one joined that one's thread (the lead split three by hand) | the recency join cannot read subjects, and the hint asking the node to split was never acted on | fixed: the status question asks the node about each such message and its split line splits it (guards above). On his data a reader judged 38 of 535 such joins another subject (7%), 37 on one lead; word rules caught at most 68 of 90 with 246 of 535 wrong, so the node decides. A replay of the question on his two misfiles and four same-subject joins split exactly the two |
| 11-23 | A lead opened a card asking him to review a subtask's change, naming that subtask, which kept the subject in its own threads (thread monitor `[copy]`) | its separate_reason (about another card of its own) let it past the copy rule | fixed: a separate_reason passes the copy rule only when it names that task (`reasonCoversTask`) |
| 11-23 | His second word on a subject, 40 minutes after the first, opened a second thread the node titled like the first (thread monitor `[dup]`) | a title line names the new thread without checking the open ones | open. Merging on a title match alone was tried and dropped in review: word overlap merged different problems ("build fails on Sonoma" and "in CI"), and a merge before the lines lost both threads' lines. Next: hold such a title and let the node answer a merge in its status question |
| 11-23 | Two threads the node opened could not be merged either way ("was opened by you with its own first post") | the merge refused any `from` with an opener | fixed: `mergeThreads` |
| 11-23 | A merge into a thread on another task of the same tree failed (`no_thread`) | merge looked only on the node's own file | fixed: `thread-tree-merge.ts` |
| 11-23 | thread_move to a subtask landed on the VP and could not move back (`same_node`) | the target collapsed to its Org node even when the task keeps threads | fixed: `thread-follow.ts` `moveTargetOf` |
| 11-23 | A task's ask said to be its subtask's decision was refused ("No task in this node's team") | ask_owner matched only a full id | fixed: `thread-task-ask.ts` `askOwnerTask` (its subtree, a unique id prefix) |
| 11-23 | The question card above a chat took half his small screen | the strip had no height cap or fold | fixed (Hide folds it to one line) |
| 11-23 | A task row drew a decision its thread held as one red "Needs you" line, cut short ("ugly, not right ... I want this style for all") | the 255a874d2 row line | fixed: every row draws the full question card again (`tests/core/action-needed-ratchet.test.ts`) |
| 11-23 | One question was drawn as a task-row card and as a thread line | rows did not know the thread held it | changed: the row card stays (his pick above); the top above a chat draws it once |
| 11-22 | A VP wrote a thread before every chat reply | the rules asked for a thread write each turn | fixed: `threads_kept_by_walnut` (status lines) |
| 11-20 | A card stayed unread while he kept talking about it in the chat | his chat words did not count for that thread | fixed: `thread-summary-stop.ts` |
| 11-01 | A node closed a thread right after answering it, before he read it | close was not tied to his reaction | fixed: `checkReacted` |

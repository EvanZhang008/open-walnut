# Message hints

A message hint is Walnut text that rides a message to a session's model without
being part of what the person wrote: the question number of a conversation
thread, the rich output instruction, the reply language, the voice-reply ask,
the note that the user is away from Main's or a lead's chat,
and any custom hint a person or an agent adds. All of them live in one registry
and go through one send pipeline. Adding a hint is adding a registry entry (or a
config entry), never a change to a send path.

Standing rules a session must always hold (core instructions, routing rules) are
not hints. They are part of the system prompt and reach a running session through
the instruction notice (`src/core/sessions/instruction-notice.ts`).

## Architecture

```
  registry (hint-registry.ts)          config.yaml session.hints (overrides, custom hints)
        \                                  /
         effectiveHints(config) ----------
                 |
  send path ---> prepareHintedSend (hint-send.ts) <--- SessionRecord.hintState (what was told)
  (web RPC, phone, cloud relay,     |  planHints: audience + schedule (hint-schedule.ts)
   the queue for every other send,  |  composeHinted (hint-format.ts): escape the text, add blocks
   side thread first question)      v
                              text the CLI receives  --commit() after enqueue--> hintState
                                    |
                              CLI echo in the transcript
                                    |
  history projection (session-history.ts, acp-journal-projector.ts):
     parseHinted -> { text: what the person wrote, hints: [...], rawText }
```

Files (all under `src/core/hints/`):

| File | Role |
|---|---|
| `hint-format.ts` | The wire format, pure, shared with the web client (`@open-walnut/hint-format`) |
| `hint-registry.ts` | Built-in hints, config overrides, validation, audience |
| `hint-schedule.ts` | When a hint is due (`dueReasons`), pure |
| `hint-send.ts` | The pipeline: plan, compose, record; post-compaction hook; host tail |
| `hint-drift.ts` / `hint-drift-detect.ts` | The `on_drift` sensor (a turn-end session hook) |
| `hint-drift-live.ts` | The same check inside a person's turn: a mid-turn correction at the first wrong-language progress line, a second when two more stay off |
| `hint-request.ts` | The `hints` a sender asks for on one message |

## Wire format

Each hint is its own Claude Code style block, before or after the message:

```
<system-reminder>
Walnut (reply-language): Talk to the user in Chinese; code stays English.
</system-reminder>
```

The first words say it is Walnut's, and which kind (`question 12` carries its
argument). Hints are told apart by structure, never by matching the person's
words: the message's own `<system-reminder` tags are escaped to
`&lt;system-reminder` (reversibly) before any block is added, so every unescaped
Walnut block in a delivered message is one Walnut wrote. Display removes those
blocks and undoes the escape; whatever the person typed shows as typed.

Every way a message reaches a model escapes it: the queue escapes whatever it is
given (`prepareQueuedHintedSend`; a caller that already composed its text passes
`hinted`), and so do a session's first message (`quick-start.ts`), an edit of a
queued message (`replaceHintedText`, which keeps the row's own blocks), a row
parked behind a permission prompt, and a host's own deliveries (peer notes and a
person's message while the host is alone, `escapeSenderWords`). A slash command is
the one text left byte-exact. A message composed upstream (the companion's voice
block on a phone send) keeps only the exact blocks the receiver renders itself;
any other block in it is the sender's words.

The bracket lines Walnut wrote before (`[Rich output mode is still on …]`,
`[Reply language: …]`, `[Voice reply: …]`) are taken off only rows dated before
this Walnut home first ran the registry (`WALNUT_HOME/hint-registry-since.json`,
written once at server start; `output-mode.ts` `stripLegacyHintLines`). The old `[Question Qn]` banner is
still read by the client for old rows (`questionSeqOfRow`).

## Triggers

Any one trigger that holds sends the hint:

| Trigger | Holds when |
|---|---|
| `every_turn` | every message |
| `every_n_turns` | `every_turns` messages after it last went out (default 5) |
| `session_start` | the session was never told this hint |
| `after_compaction` | it was told before the session's latest compaction boundary (`SessionRecord.lastCompactUuid`, the boundary the place and instruction notices use) |
| `on_change` | what it says now differs from what the session was told (a mode switch, an edited setting) |
| `on_drift` | a reply since it last went out broke its rule (only the reply language checks this) |
| `on_request` | the sender asked for it on this message (a voice send, a question number) |

The queue composes hints for turns nobody typed (triggers, peers, Walnut's
notices, letter replies, the clock, automatic continues and recoveries) and for a
person's `task_send` from the CLI (`QUEUE_HINT_SOURCES`), and only escapes the
rest. Every message counts toward `every_n_turns`, hint or not.

A new conversation's first message, from any launcher (`task_start`, a quick start, a routine, a
restart into a fresh conversation), gets the hints due at its start from the session runner's two
start paths (`prepareStartHints` in `hint-send.ts`, called in `providers/claude-code-session.ts`):
added around what the launcher built, never re-escaping it, skipping a kind it already carries,
and recorded as told once the CLI names its session. A fork, a rewind and a transfer resume an old
conversation and get none. Before 2026-11-05 a session's `session_start` hints went out on its
second message, which a one-turn worker never received.

Defaults: `question`, `voice-reply` and `object-context` on request (`object-context`: what a client says about the thing the person asks about, a web page in the browser side panel, a mail, a tab they let the ask act in; the client stores it with `POST /api/v1/hints/context` and names its id on the send, the first one of a quick start included, so Walnut's note rides beside the person's words, never inside them: `src/core/hints/hint-context.ts`, guard `tests/web/walnut-words-are-hints.test.ts`); `rich-output` at session
start, after a compaction, on a change, and its short reminder every 5 messages;
`reply-language` only by its own triggers: at session start, after a compaction, when the
setting changes, and on the message after a reply that was not in it (`on_drift`). Never on every
message, for any role and for a person's own message alike (2026-11-05, the user: "I said don't do
this every round remove thies, this alsoshoudln't be in any official walnut product"; rules that
forced it onto every message of Main, the leads, every session and every person's message, from
2026-10-29 to 2026-11-02, are gone, and `tests/core/hints/hint-triggers-only.test.ts` fails when a
send carries a hint for a reason that is not one of its triggers). Its words are the user's own
`session.reply_language` sentence; while that is empty nothing is sent, so a fresh install sends
none. Walnut adds one clause after the sentence: it covers every line the user reads, the short
progress lines between tool calls included. Walnut writes no text of its own in any language but
English (lines in Chinese, Japanese, Korean and Russian it once had are gone).
Drift is judged on every message of the turn the user saw (`replies` on the turn-end hook,
the progress lines between tool calls too, not only the final reply), and the next message after
a drifted turn carries the hint again, led by a correction (`replyLanguageCorrection` names that
turn). The server's next message tells it once; a host's own deliveries carry it until then or
until a later turn is in the language again, which clears the mark. A turn the chat hides
(something else started it and it ended on the no-action line) is not judged. Inside any turn,
whoever started it, the first progress line in the wrong language is corrected at once
(`src/core/hints/hint-drift-live.ts`): when the tool call after it starts, an
`outcome="reply-language"` notice goes mid-turn, so a native Claude Code session reads it with that
tool's result; the turn end then judges only what came after the last one. The notice quotes the
line, shows it rewritten by the fast model from the user's own rule (8 seconds at most; without an
answer it quotes alone), and ends with the rule. ACP engines take one prompt per turn, so they keep
the correction on the next message. Inside a turn a progress line is judged from 12 letters
(`LIVE_MIN_LETTERS`: "Chromium 34/34. Now WebKit."), and the next correction goes out when two more
lines after the last are still off, at most three a turn. Every turn the chat shows is judged whole
at its end, in every session.
`brief` (Main and the leads only) at session start, after a compaction, every 3 messages and
when the node's team moved since its Brief was written (`src/core/sessions/brief-hint.ts`): how
old the Brief is, what moved, and to update it with `brief_write`; a node with no Brief hears to
write one. A Brief that is current and only its write changed says nothing (2026-10-31, the user:
"每三轮提示他一下").
`user-away` (Main and the leads only) at session start, on a change and after a
compaction: the user has not been in this chat for 30 minutes and it is not open
anywhere (`src/core/org/user-away.ts`: the last message a person typed into it,
`chatInputAt`, never a letter's answer;
the web's and the phone's attention heartbeats on it, an open session stream on the
phone; `WALNUT_AWAY_AFTER_MINUTES`), so an important update goes to his inbox, and
once that he is back. A person's own message is presence (2026-10-31).
`threads` (Main and the leads only) on each message the user sends there (typed into the chat, or
the note answering one of its letters): Walnut files the message as one of the node's Threads (his
own requests, one thread per subject; `src/core/org/thread-capture.ts`), whether or not the hint is
on, and the hint names the thread it went to, his other open threads, how to put a message about
the same subject under one of them (`thread_update` `merge_into`), and the threads he closed since
the node was last told (2026-11-01, the user: "if my multiple ask is about the same thread, add it
below that thread"). It also carries the cleanup rule (`src/core/org/thread-rules.ts`): an answer
counts as known only once he reacted to it after it was given, silence is not knowing, and the node
may open a thread itself (`thread_create`) only for what he must act on or asked to follow; and what
a card says: its title, a summary written latest first with a sentence or two of background, and only
the answers he has not seen, with news about a thread going into its summary, never into new rows.
`threads-tidy` (Main and the leads only; every 3 messages, at session start and after a compaction,
only when there is one): the open threads that need the node's decision now (he wrote after an
answer in another thread: did he react to it? a stand-in title; a state still `new` though it was
answered), with the same rules, so the node takes what he knows off the card (`thread_update` `known`), keeps the
summary latest first, and closes what he reacted to as finished (2026-11-01, the user: "you should proactively clean the thread ...
make sure this is a Walnut feature, not just your memory").

`hand-on` (Main and the leads, by its default audience; at session start, after a compaction and
every 3 messages): never do the work yourself, at most 3 commands of your own in a turn, then hand the
rest to the team (`src/core/org/core-instructions.ts` `orgHandOnHint`; 2026-11-03, the user: "it shudo
use prompt and in correct time to avoid forget"). Its other half runs inside the turn: the org work hook
(`src/providers/org-work-guard-hook.ts`) adds the same reminder to the result of the node's 3rd command
of its own in a turn, once per turn, and never refuses one (2026-11-04, the user: "remove this
shodln;'t do this at all"; an older `org.block_own_commands` in config.yaml is ignored).

After a compaction the CLI's SessionStart hook (`open_items`) states every hint
with `after_compaction` right away and records it, so the rest of an interrupted
turn holds it; the boundary the server reads later counts those as told.

## Who and where

`audience` limits a hint by role (`main`, `lead`, `worker`, `ask`, `other`, from
the session's task), by agent id, or by session id; empty means everyone.
`placement` is `before` or `after` the message.

## Host-delivered messages and older daemons

A peer message between two sessions on one host is delivered by that host's
daemon and never passes the server's queue. The host slice ships `replyTail`:
the after-placed hints owed right now (one whose triggers say `every_turn`, a drifted reply
language, a change not yet told). A daemon appends it to such a message; an older
daemon's line logic still appends the block (with blank lines inside it, which
the parser tolerates). By default nothing is owed and `replyTail` is absent.

## Changing hints

People: Settings, Sessions, Message hints. Agents: `hint_list`, `hint_set`,
`hint_reset`. Both use `GET/PUT/DELETE /api/v1/hints` (docs/reference/api-v1.md).

## Seeing what a message carried

A message hint is for the model and is not shown in any chat, on the web or the
phone (2026-11-01, the user, of the line under his message that said what Walnut
added: "just remove this, no idea why we need this"). The person's bubble holds
only their words; a CLI-injected row (a hook's added context, which restates the
hints after a compaction) leaves the blocks out, and a row of nothing but hints
is no row. The session menu's "Raw input & output" shows every turn's input
exactly as the model received it, hints included. History rows still carry
`hints` (the kinds a row carried, for question numbers and the raw view) and
`rawText`; no client draws them (`tests/web/hints-not-drawn-ratchet.test.ts`),
and no read a client draws from holds a hint's words
(`tests/web/routes/hints-never-raw.test.ts`).

What else Walnut added to a person's message (its notes in front of the words,
the context blocks it put first) shows in the chat by default
(`ui.show_walnut_additions`, Settings, Sessions, Message hints, "Always show
what Walnut added to a message"); with the setting off, the message footer's
"Walnut added N" button (on a phone, the message menu) shows them for that
message.

## Whose words a hint is

A built-in hint's text is Walnut's, the same in every Walnut, except the part a
setting of the user's fills in; a custom hint (Add a hint) is all the user's
own (`src/core/hints/hint-origin.ts`, shared with the web app). Settings marks
each row "Built in", "Built in, changed by you" (an override of its triggers,
audience or place) or "Yours", and a built-in that sends a setting says what it
sends, the setting apart from Walnut's sentence (`user_setting` on its
`/api/v1/hints` row). Today that is Reply language: the user's
`session.reply_language` sentence, then `REPLY_LANGUAGE_SCOPE`, after a
correction line when a reply drifted
(`hintTextParts` cuts a hint's text into Walnut's words and the user's). A new built-in that sends a setting of the user's
adds it to `HINT_USER_SETTINGS`; `tests/core/hints/hint-origin.test.ts`
renders every built-in from a config whose settings are all markers and fails
when a marker lands in a part marked as Walnut's.

A hook's added context (a Claude Code `hook_additional_context` line: Walnut's
post-compaction open items, its temp-write and clone-identity notes, the user's
own hooks) is an injected context row at its place, "Added by the <event> hook",
without the hint blocks it restates.

The session menu's "Raw input & output" shows every turn's input exactly as the
model received it and its output as it came back. History rows carry `hints` and
`rawText`; the phone's transcript rows carry `added` (each context block with its
label and text; hint items, sent from 2026-10-29 to 2026-11-01, are no longer) and
`textWithoutContext`, and `/api/v1/config` carries `ui.show_walnut_additions`.

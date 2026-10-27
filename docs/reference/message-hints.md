# Message hints

A message hint is Walnut text that rides a message to a session's model without
being part of what the person wrote: the question number of a conversation
thread, the rich output instruction, the reply language, the voice-reply ask,
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

Defaults: `question` and `voice-reply` on request; `rich-output` at session
start, after a compaction, on a change, and its short reminder every 5 messages;
`reply-language` at session start, after a compaction, on a change, and on drift.

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
the after-placed hints owed right now (an every-message hint, a drifted reply
language, a change not yet told). A daemon appends it to such a message; an older
daemon's line logic still appends the block (with blank lines inside it, which
the parser tolerates). By default nothing is owed and `replyTail` is absent.

## Changing hints

People: Settings, Sessions, Message hints. Agents: `hint_list`, `hint_set`,
`hint_reset`. Both use `GET/PUT/DELETE /api/v1/hints` (docs/reference/api-v1.md).

## Seeing what a message carried

The user bubble shows a folded "Walnut hints: …" row. The session menu's
"Raw input & output" shows every turn's input exactly as the model received it
and its output as it came back. History rows carry `hints` and `rawText` for
every client, the phone included.

# Leaving a mailing list

Right-click a message in Mail and one of the entries is `✦ Unsubscribe`. It tries to do the
thing rather than explain it: three programmatic exits in order, and only when none of them
can finish does it hand the job back, with the page and the reason.

The rule the whole design turns on: **a green tick over a page nobody read is worse than
asking.** Senders offer three different exits and only one of them is machine-final, so each
rung answers either "you are off the list" or "I could not tell", never a guess.

## The ladder

| | Rung | What it is | Who authorises it |
|---|---|---|---|
| 1 | RFC 8058 one-click | The sender explicitly invited ONE POST, no confirmation page and no human. `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is that invitation. | the human's click |
| 2 | mailto | A real mail, drafted and sent through the CONSOLE half of the approval ledger. The right-click IS the authorisation, so there is no second letter to answer. | the human's click, recorded as `approval_kind: 'console'`, `approval_ref: 'unsubscribe:<messageId>'` |
| 3 | https GET | Fetch the link and read the page (`unsubscribe-verdict.ts`). Success words mean done; a form means somebody has to look at it; no signal means unclear. | the human's click |
| 4 | the model | NOT a server rung. The console opens the Ask drawer; an agent sends a letter. Either way a human is in the loop by construction. | the human, again |

Three properties the ladder is responsible for, each of which is a bug someone could
reintroduce in one line:

- **One attempt in flight per message**, enforced by a single upsert in the ledger, never by a
  read-then-write. Two clicks a millisecond apart make one request.
- **Nothing retries itself.** A failed rung records its reason and stops; the human clicking
  again is the retry. The 60 second reclaim of an `in-flight` row exists only for a process
  that died mid-attempt.
- **Every network hop goes through the guard.** The ladder never calls `fetch`; it calls
  `fetchUnsubscribe`, which cannot be told to skip its checks.

And the one that matters most for rung 4: **an agent cannot leave a list.** The op behind it
makes a letter and returns. It opens no socket, writes no mail, and never calls the ladder.
The only caller is a human: their click, or their answer to that letter, which is recorded on
the ledger row as the reference that authorised it. A test pins that nothing reachable from an
agent can reach the console send.

## Where the exits come from

`List-Unsubscribe`, `List-Unsubscribe-Post` and `List-Id` are read off the message on IMAP and
kept on the payload, bounded: https only, at most 4 urls and 2 mailtos, 2 KB each. Reading them
needs the RAW header lines rather than the parser's `list` entry, which folds this header into a
lossy shape (pinned by a test).

Two ways a message that has no headers still gets an exit. A body read fills the gap for mail
that predates the field, and the footer of the stored HTML is scraped for an
`unsubscribe` / `opt out` / `manage preferences` link for the providers that never expose the
headers at all (Outlook's API does not). Neither is allowed to correct what the headers already
said. The envelope hash deliberately ignores the whole field, so the first poll after this
shipped rewrote nothing and produced no update events.

## What the console knows without asking anything

`MailMessageDto.unsubscribe` carries one word plus the ledger's own memory, and costs ONE extra
SELECT per page (never one per message):

```ts
{
  available: 'one-click' | 'mailto' | 'link' | 'none',   // derived purely from the payload
  done?: { method, at, scope: 'message' | 'list', keyedBy?: 'list-id' | 'sender' },
  attempt?: { status: 'in-flight' | 'needs-human' | 'failed', reason?, at },
}
```

`done` and `attempt` are DERIVED on every read, never stored on the message, the same rule
`taskId` follows. `scope: 'list'` is what lets a message nobody ever clicked say "you
unsubscribed from this sender on Tuesday", and `keyedBy` decides whether that sentence says
"this list" or "this sender": with no `List-Id` the key falls back to the sender's address, and
one sender running three lists off one address shares that key. The console must not overstate
it, which is why the distinction is on the wire instead of being guessed at.

`reason` is a key to switch on (`confirm-form`, `http-403`, `cannot-send`, `send-unknown`, …),
never a sentence to print.

The menu reads like this: `none` is disabled with "no unsubscribe link found, Ask Walnut can
try"; `in-flight` says "Unsubscribing…"; `done` says "Unsubscribed ✓" and stays clickable;
`needs-human` says "Finish unsubscribing…" and opens the Ask drawer with the url and the reason;
`failed` is worth another click. The reader has the same states as a line plus a button. There
are no submenus anywhere in the Mail menu, because the core `ContextMenu` has none: the AI
entries are grouped under a `Walnut` info row with the ✦ inline in the label rather than in the
icon column, since using that column would indent only this group.

## The SSRF guard

One function, no bypass switch of any kind, and it is the only thing in the ladder that opens a
socket. Every rule below is a way a sender could otherwise point Walnut at something on this
machine or inside the network:

- `https:` only, port 443 or default, no credentials in the url.
- A `dns.lookup(all)` BEFORE the request; any private, loopback, link-local or unique-local
  answer refuses the whole thing. IPv4 written in decimal, octal or hex normalises first, and
  the IPv4 embedded in a v4-mapped or NAT64 address is judged by the IPv4 rules.
- Internal-looking names are refused (`*.local`, `*.internal` and friends, trailing dot
  included).
- `redirect: 'manual'`, at most 3 hops, the FULL guard re-run on every hop.
- No Cookie, no Authorization, no Referer. The user agent names Walnut.
- The response is cut at 256 KB while streaming, and one 10 second deadline is shared across
  every rung and every hop.

Two things it deliberately does not do. It accepts the DNS rebinding window between its own
lookup and the fetch's (pinning an IP in Node costs more than it buys here: the request carries
no credentials and the response produces one verdict word). And a url the guard REFUSED is not
handed back to the client as "open this yourself", because that turns a refusal into a
click with more authority than the server had.

## The ledger

`unsubscribes`, db v8: `(account_id, message_id)` primary key, plus `list_key`, `method`,
`status` (`in-flight` | `done` | `needs-human` | `failed`), `reason`, a short `detail`, the
reference that authorised it, and `at`. Indexed by `list_key`, which is what makes the list-wide
memory one SELECT.

The claim is a single statement: insert, and on conflict update only when the existing row is
`failed` / `needs-human` or older than the reclaim window. `changes() === 0` therefore means
"somebody else is already doing this one" and answers 409. Nothing else can produce that, which
is why the 409 is trustworthy.

## Limits

| Limit | Value | On breach |
|---|---|---|
| https urls kept per message | 4 | the rest are dropped |
| mailto targets kept per message | 2 | the rest are dropped |
| one url | 2 KB | dropped |
| body scanned for a footer link | bounded, tail preferred | no link found |
| response body | 256 KB | cut while streaming |
| whole ladder, all rungs and hops | 10s | `failed` |
| redirect hops | 3 | `failed` |
| attempts in flight per message | 1 | 409 |
| reclaim of an `in-flight` row | 60s | the next click may claim it |
| retries | none, ever | the human clicks again |

## Files

| Piece | File |
|---|---|
| The ladder and the letter path | `src/integrations/mail/unsubscribe.ts` |
| The guard, and the only `fetch` | `src/integrations/mail/unsubscribe-http.ts` |
| Reading a page's answer | `src/integrations/mail/unsubscribe-verdict.ts` |
| A footer link out of stored HTML | `src/integrations/mail/unsubscribe-link.ts` |
| Parsing a mailto target | `src/integrations/mail/unsubscribe-mailto.ts` |
| Header capture | `src/integrations/mail-imap/mime.ts` |
| The ledger | `src/integrations/mail/store-write.ts`, schema in `db.ts` |
| The route | `src/integrations/mail/routes-write.ts` |
| Availability on the wire | `src/integrations/mail/service-dto.ts`, `service.ts` |
| Menu, reader, drawer hand-off | `web/src/apps/mail/mail-unsubscribe-{state,actions}.ts`, `mail-context-items.ts`, `MailReaderHead.tsx` |

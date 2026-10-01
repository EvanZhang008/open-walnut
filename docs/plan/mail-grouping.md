# The grouped inbox

Mail opens on the **Grouped** view: one line per group of UNREAD mail, then Important (every mail
kept for the person, one row each). The model names the groups ("Build results", "Pager alerts"); a group with nothing unread is not
shown. Bulk actions (mark a group read, unsubscribe from its lists, keep it out of the Inbox) run
only when the person clicks them, and every correction the person makes is written to a rules file
they can read and edit.

Code: `src/integrations/mail/sort-*.ts` (server), `web/src/apps/mail/MailGrouped*.tsx`,
`MailGroupLine.tsx`, `mail-groups-*.ts` (console).

## Who decides where a mail goes

In order, first answer wins (`MailSortEngine.compose`):

1. **The person's rules**, top to bottom, from `~/.open-walnut/plugin-data/mail/sort-rules.yaml`.
   A rule has `when` (every listed condition must hold: sender glob or name, subject text or regex,
   list id, addressed to me, cc, sender kind, account, message, the model's group) and `then`
   (Important, Not important, or a group name).
2. **The model** (`sort-ai.ts`), for unread inbox mail of the last 14 days: important or not, and a
   short group name, in batches of 30, at most 60 calls an hour, through the host's main model
   (`walnut.model.fastText`). While it has not answered, the mail waits in Important as
   "Sorting...". When it fails, it goes down for a while and the simple rules decide.
3. **The simple rules**: a person writing to you is Important; everything else is its sender's group.

A correction ("Not important...", "These are important...", "Rename group") becomes a rule or a
rename, so the next mail of that kind lands where the person put the last one.

## The line under each group

Each group line is a title row (name, unread count, top senders, time) and one summary line saying
what the unread mail is ABOUT (`sort-group-summary.ts`):

| Unread in the group | The line |
|---|---|
| one | its subject |
| two or more | the model's line, at most 14 words, from the newest 10 subjects and senders |
| model off, down, or not there yet | the newest subject |

A line is asked for again when new mail arrives in the group, or when the unread set changed some
other way and the line is 30 minutes old. A group the model answered nothing for is stamped empty,
so a batch cannot loop. An unreadable answer costs those groups their line, never the labeling.
Lines are stored per group across every inbox (`mail_group_summaries`), so a folder view shows the
same line.

## Keep out of Inbox

`Keep out of Inbox...` on a group's menu saves a rule with `skipInbox: true` and `then` set to the
group. From then on, mail the rule decides is moved to the account's archive as it arrives, and
stays unread there. The card can also move the unread already in the group ("Also move the N
unread in it now").

Neither transport can create a server-side rule (IMAP has none; the Outlook helper has no rules
tool), so Walnut does the moving itself (`mail-filter-moves.ts`):

| Fact | Consequence |
|---|---|
| Walnut moves mail while it runs | mail that lands while it is off is moved on the next poll; a phone can notify before the move |
| Only mail received after the rule existed is moved on arrival | a new rule never sweeps old mail; the card's checkbox does that, for the unread in view |
| A `group:` rule can only decide after the model labeled the mail | most arrivals are moved from the labeler's re-sort, seconds after ingest |
| A move that fails leaves the mail in the Inbox, in its group | nothing is lost; the ledger retries twice (1 min, 5 min), then keeps it as failed for an hour |
| An account that cannot move says so on the card | `cannotArchive` in `/groups`; its mail stays in the group |
| A moved mail can come back (an Outlook reply re-files its conversation) | moved again, no sooner than 10 minutes after the last move, at most 5 times |

Per provider: IMAP uses `UID MOVE` into the folder the person set as the archive, then `\Archive`,
then Gmail's `\All`, then a folder called Archive. A server without MOVE is refused, never emulated
(imapflow's COPY + EXPUNGE fallback deletes even when the copy failed). Outlook uses `email_move` to
`archive`, one call per conversation, and only for Inbox handles.

## Limits

| What | Limit |
|---|---|
| Model calls (labels and summaries together) | 60 an hour |
| Mail per labeling call | 30 |
| Groups per summary call | 8, 10 mails each |
| Summary line | 110 characters |
| Moves per batch | 50, one batch at a time |
| One `archiveMany` call | 60 s plus 2 s per message |
| Move attempts | 3 (at once, +1 min, +5 min) |
| Re-moves of one message | 5, at least 10 minutes apart |

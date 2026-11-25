# Locked notes

A person can lock one note with their Passwords master password. A locked note's text is
encrypted on disk, hidden on the Notes page until they press Show, and never read by an agent
unless the person approves that one read with their master password.

The user's words (2026-11-24): "we can make one node encrypted, not read by AI, also hide by
default ... i dont want AI be able to accidentally read and make it public, also this is always
hand written. Like lock this file, with a master password, and only human can edit it, or ai can
also do it with my password, the walnut note page, it hidden by default, I have to press visible
to make it visible the content not the file itself."

## What it protects against

Accidents: an agent, a plugin, search, sync or a replica reading or quoting private text it was
never meant to see. Every ordinary way in answers a stub. It is not a wall against a hostile
program running as the user on the Mac (one could read the window's Passwords unlock token from
the browser's storage); Passwords itself draws the same line.

## What is on disk

The note stays a Markdown file at its path, so the tree, links to it, moves and renames work as
before. Its whole text (its own frontmatter included) is replaced by:

```
---
id: n_...
walnut_locked: 1
---
**Locked note.** Its owner marked it private: it is written by hand and is very sensitive. ...

<!-- walnut-locked-note v1 {"key":"<vault item id>","iv":"<base64>","ct":"<base64>"} -->
```

- `ct` is AES-256-GCM over the note's text, with the additional data
  `walnut-locked-note:v1:<key item id>` (`src/core/notes/locked-note.ts`).
- The note's `id` stays in the outer frontmatter, so links by id and the index keep it.
- A file is a locked note only when its frontmatter at the very top carries `walnut_locked: 1` and
  an envelope line follows: a note that quotes the format (this page in a code block) is plain.
- An unknown version or a broken envelope reads as locked and opens nowhere: nothing treats it as
  plain text.
- No ordinary write may write a locked note's file as new text (400 `locked_note_text`): only Lock
  makes one, so a copied file never turns a plain note into one nobody can edit.
- Every write replaces the file whole (a temp file, flushed, renamed, the folder flushed).

## The key

One random 32-byte key seals every locked note. It is a Passwords item, a secure note titled
"Walnut locked notes key" with one hidden field, made on the first lock
(`src/core/vault/locked-notes-key.ts`):

- Agents never get it (`agentAccess: never`, sensitive). The vault's own routes refuse to change,
  trash or delete it (409 `locked_notes_key`), and Bitwarden sync never adopts it.
- Because it is an ordinary item, it is re-wrapped when the master password changes, kept in the
  daily vault backups, copied to the phone with the vault and included in an export. The key never
  rotates, so an old copy of a locked note in git history still opens with it.
- Losing the vault (the Mac and every vault backup) loses the locked notes. The Passwords recovery
  code opens the vault, and so the notes.

## Who reads and writes it

| Who | Reads | Writes |
|---|---|---|
| Every ordinary read (Notes routes, `/api/v1/notes`, note_read, plugins, the replica, the offline host copy) | the stub and `locked: true`, never the ciphertext | refused: 423 `note_locked` |
| Search, the index, embeddings, tags, links, the journal context | the stub only | none |
| The person, Passwords unlocked in that window | `POST /api/v1/vault/notes/read` | `/vault/notes/save`, `/lock`, `/remove-lock` |
| An agent the person approved | `locked_note_wait` after `locked_note_ask` | `locked_note_save` under an `edit` ask |

The person-only routes (`src/web/routes/vault-notes-v1.ts`) use the vault's own gate: a person,
no session caller, no automation mark, no test run, the leader only, and a live vault session
that only the master password buys. They live under `/vault` on purpose: the cloud companion
never forwards a `/vault` route, and no answer is kept in the applied-ops ledger.

Every ordinary write path checks the file it would replace: the notes routes, `/api/v1/notes`,
`/api/file-content`, the plugin notes service, a folder delete or tag rename, the replica's save,
the offline host copy and the offline merge. A delete of a locked note (or a folder holding one)
by anyone but the person is refused too.

## Agents

An agent that meets a locked note reads `locked: true` and a line telling it the text is private.
Only when its task cannot go on without the note does it ask (`src/core/notes/locked-note-ask.ts`,
ops in `src/ops/locked-notes.ts`):

1. `locked_note_ask {path, purpose, access: read | edit}` makes an approval card. It always asks,
   whatever the Approvals switch says, and its card says why and what a yes allows.
2. The person approves in the web console or the Mac app. The yes needs the master password typed
   for it: Approve always opens the unlock sheet, and the server takes the yes only with an unlock
   made in the last two minutes (`needsPasswords`, `src/web/routes/approvals-v1.ts`). The phone
   cannot approve one (it says to approve on the Mac).
3. `locked_note_wait` then answers the text. The same ask reads it again for 10 minutes (a long
   note comes in pages); an `edit` ask reads and saves (`locked_note_save`, the whole text, with
   the hash it read) for 30 minutes. Only the task that asked may wait or save, and only while the
   same note (by its id) is at that path: a note moved or swapped in since gives nothing.
4. The answer is never kept for a resend (`answerNeverKept`, `src/ops/op-calls.ts`): a second copy
   of the call runs again and meets the window and the checks above.

Brakes: at most two asks waiting per task, and three denials in 30 minutes pause that task's asks
for 30 minutes. Asks are kept across a restart (`src/core/kept-asks.ts`, the wait token only as
its hash). Lock all ends every ask, waiting or approved.

## The Notes page

- The tree shows a lock beside a locked note (from `locked` in `/api/notes-v2/list`).
- Opening one shows only its title and a Show button. Show asks for the master password when the
  window has no Passwords unlock, then shows the text in the usual editor. Hide, a note switch,
  and Passwords locking (here or by Lock all) hide it again.
- Edits save sealed (debounced, with a three-way merge when the text changed meanwhile). An edit
  that is not saved when the text hides (a note switch inside the save delay, Passwords locking,
  a cancelled unlock) stays in the page's memory and is saved, or put back on the next Show.
- A plain note open in another window when it is locked here: its next save is refused, and what
  was typed is kept the same way and saved sealed once the person unlocks.
- The header's Lock button locks a plain note (after a confirm); Remove lock puts the text back
  in the file as a plain note.
- The popout window behaves the same.

## Limits

- Locking protects what is written from then on. The note's earlier plain versions stay where
  they already went: the data repo's git history (git sync), a replica's or the phone's copy made
  before the lock, and backups. Removing them means rewriting that history, which Walnut does not
  do on its own.

- Images and attachments in a locked note are not encrypted, and the editor adds none (no Image
  button; a pasted or dropped image is not taken).
- Git sync: when one side of a conflict is locked and the other is a plain copy, the locked side
  stays; the plain copy is in history.
- A change made on a replica while away, to a note locked on the Mac meanwhile, is not applied; its
  text is kept in the offline-conflict entry (it was typed in a plain copy).
- Text typed into a locked note's file outside Walnut (another editor) is not part of its locked
  text and goes on its next sealed save.
- Old plain copies can stay in places Walnut does not wipe: free pages of the search databases,
  this browser's file cache from before the lock, and an older Walnut after a downgrade, which
  has no lock checks and could write over the file if the note is edited there.
- Links and tags inside a locked note are not indexed while it is locked.
- The iPhone shows the stub: it neither shows nor edits a locked note's text.
- `global-notes.md` and notes Walnut writes itself cannot be locked.

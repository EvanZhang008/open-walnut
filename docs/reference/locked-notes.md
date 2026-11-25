# Locked notes

A person can lock one note with their Passwords master password. A locked note's text is
encrypted on disk, hidden on the Notes page until they press Show, and never read by an agent
unless the person approves that one read with their master password.

A note can also be hidden, with no password: its text stays plain on disk, but no Walnut tool
reads or changes it (see [Hidden notes](#hidden-notes)).

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
- The mark is the line `walnut_locked: 1` (also `"1"` or `'1'`) in the note's first frontmatter
  block, at the very top (a BOM aside); nothing below that block counts. A file is a locked note
  when it has the mark and its last non-blank line is the envelope line: readers then answer the
  stub. Every writer refuses a file with the mark, whatever its envelope line looks like, and
  refuses new text that has it. A note that quotes the format (this page, a code block) is plain
  (`src/core/notes/locked-note-format.ts`, string operations only: no pattern runs over the whole
  text).
- An unknown version or a broken envelope reads as locked and opens nowhere: nothing treats it as
  plain text.
- No ordinary write may write a locked note's file as new text (400 `locked_note_text`): only Lock
  makes one, so a copied file never turns a plain note into one nobody can edit.
- Every write replaces the file whole (a temp file, flushed, renamed, the folder flushed).

### An agent that reads the files directly

The user asked (2026-11-25): what if an agent skips Walnut's tools and reads the disk? After a lock,
these hold no plain text of the note (`tests/e2e/locked-notes-disk-scan.test.ts` scans every byte
of a test's Walnut folder, its logs and its git objects for a note that was plain, indexed and
searched first, then locked, edited and read by an approved agent):

- the note's file: the stub and the ciphertext;
- the Passwords vault: the key, sealed with the master password;
- the notes index and the search index (`notes-index.sqlite`, `search.sqlite` and their `-wal`
  files): once both hold the stub, `src/core/notes/locked-note-residue.ts` merges their full-text
  segments, writes zeros over their free pages and truncates their write-ahead logs, in small
  steps; both open with `secure_delete = FAST`, so a later delete zeroes what it frees in a page;
- Walnut's logs: they carry paths, never a note's text;
- git commits made after the lock: the ciphertext only.

What still holds the earlier plain text is in Limits (git history first).

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

### Backup of the key

The vault lives on this computer only (`docs/reference/passwords.md`, "Where it lives"), while a
locked note's ciphertext goes wherever the data folder syncs. So the key and the master password
hint are also kept in the data folder, in `locked-notes-key-backup.json`
(`src/core/vault/locked-notes-key-backup.ts`; the user's pick, 2026-11-25: back up the key and the
hint). It holds what the phone is given of the vault, for the key items only: the vault's id, its
KDF settings, `aukSalt`, the password wrap and each key item sealed as stored, plus the hint in
plain text as in `vault.json`. No machine wrap, no recovery wrap, no other item. Opening it needs
the master password and the Secret Key, as the vault does. It is written after every vault write
while a key item exists, only when its bytes change, so a new master password rewraps it.

On a new computer, or a vault set up again, a locked note's Show finds no key (410
`locked_key_missing`), and the Notes page shows "Restore the key" in its place
(`web/src/components/notes/LockedNoteKeyRestore.tsx`): the backup's hint, the master password and
the Secret Key of the vault that locked the note (from its recovery kit), and with backups of more
than one vault a pick of which. `GET /api/v1/vault/notes/key-backup` answers each backup's vault
id, KDF and hint, the newest first (`earlier` holds the vaults a restore replaced); `POST
/api/v1/vault/notes/restore-key {passwordKey | password, secretKey, vaultId?}` (person, vault
session, the wrong-password brake) adds each key that backup holds to this vault, unless an item
already holds the same key, and the note opens. The page sends the password as its derived key,
as an unlock does. With no backup in the data folder the card says so and points to a Passwords
backup or its trash. The git history keeps earlier copies of the file: anyone with an earlier master password and
the Secret Key could open one of those, and the key itself never changes, so after a leak of both,
locking notes again under a new key is the only cure.

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
the offline host copy, the offline merge, Inbox Triage's Runs note and the Files panel, each under
the same per-file lock (`withUserFileLock`). Only the person deletes, moves or renames a locked
note, or a folder holding one; nobody copies one; and a locked note never moves onto a note Walnut
writes itself (`src/core/notes/locked-note-moves.ts`, shared by the notes routes and the Files
panel). `tests/core/notes/locked-note-writers-guard.test.ts` finds every function that changes a
file under the notes folder and requires one of these checks in it.

## Agents

An agent that meets a locked note reads `locked: true` and a line telling it the text is private.
Only when its task cannot go on without the note does it ask (`src/core/notes/locked-note-ask.ts`,
ops in `src/ops/locked-notes.ts`):

1. `locked_note_ask {path, purpose, access: read | edit}` makes an approval card. It always asks,
   whatever the Approvals switch says, and its card says why and what a yes allows.
2. The person approves in the web console or the Mac app. The yes needs the master password typed
   for it: Approve always opens the unlock sheet, and the server takes the yes only with an unlock
   made in the last two minutes (`needsPasswords`, `src/web/routes/approvals-v1.ts`). The phone
   cannot approve one: its Approve is refused (401 `master_password_needed`), so the person approves
   on the Mac.
3. `locked_note_wait` then answers the text, in pages of at most 8,000 characters, so no agent
   client writes it to a file on its host. The same ask reads it again for 10 minutes from the yes,
   not from the first read: an ask not read in time gives nothing. An `edit` ask reads and saves for
   30 minutes from the yes (`locked_note_save`, the whole text, with the hash it read; no hash is
   400 `expected_hash_required`). Only the task that asked may wait or save, and only while the same
   note (by its id) is at that path. A call that names a task's session must be seen inside it (403
   `unverified_session`, `src/core/approvals/seen-inside.ts`); one that names no session asks as its
   host.
4. No answer of these routes is kept for a resend, whichever op reached them (`api` too): every
   `/vault/notes` route marks its answer `x-walnut-answer-not-kept` (`src/lib/answer-not-kept.ts`),
   and `src/ops/op-calls.ts` keeps nothing of a call that reached one.

Brakes: at most two asks waiting per task, and three denials in 30 minutes pause that task's asks
for 30 minutes. Asks are kept across a restart (`src/core/kept-asks.ts`, the wait token only as
its hash). Lock all ends every ask, waiting or approved.

## The Notes page

- The tree, Recent, Bookmarks and search rows show a lock beside a locked note (from `locked` in
  `/api/notes-v2/list`).
- Opening one shows only its title and a Show button. Show asks for the master password when the
  window has no Passwords unlock, then shows the text in the usual editor (no images, no dictation).
  Hide, a note switch, and Passwords locking (here or by Lock all) hide it again; a read that comes
  back after Passwords locked is never shown.
- Edits save sealed, debounced, and never open the unlock sheet: a save made while the window has
  no unlock waits in the page's memory (never storage) and goes once an unlock comes back. Every
  save is written to that memory before it is sent and dropped only when it is saved, so a note
  switch, a failed save or a Passwords lock loses nothing; a reload asks first while one waits.
- Another window's save merges into the open editor at once, the cursor kept
  (`web/src/components/notes/editor-merge.ts`, shared with plain notes). An edit that cannot merge
  comes back on the next Show with "Keep mine" or "Use the other version".
- A rename takes a waiting edit along; a delete drops it.
- The header's Lock control (behind the `locked_notes` experiment) is a lock button with a short
  menu (`web/src/components/notes/NoteProtectMenu.tsx`): Hide from AI and Encrypt on a plain note,
  Encrypt and Unhide on a hidden one. Encrypt locks the note after a confirm that says to lock a
  note before writing private text in it; Remove lock puts the text back in the file as it was
  before the lock (a hidden note comes back hidden). The editor is read-only while any of them
  runs. A note already locked or hidden always opens covered with Show, whatever the experiment
  says, and the server's protections never depend on it.
- The popout window behaves the same.

## Hidden notes

The user's words (2026-11-25): there are two kinds, one encrypted, one hidden; the hidden one is
plain text, but no tool may use it. A hidden note needs no password: the person hides it, and the
Notes page shows it after they press Show.

### What is on disk

A hidden note is a plain Markdown note whose first frontmatter block has the line
`walnut_hidden: 1` (also `"1"` or `'1'`, read by the same rule as the lock mark,
`src/core/notes/locked-note-format.ts`):

```
---
id: n_...
tags: [journal]
walnut_hidden: 1
---
The note's own text, in the clear.
```

A text with both marks is a locked note: the lock wins. Hide adds the line at the end of the first
block (a new block when the note has none, its id stamped first); Unhide takes it out
(`src/core/notes/hidden-note-store.ts`).

### Who reads and writes it

| Who | Reads | Writes |
|---|---|---|
| The person on the Notes page (`/api/notes-v2/content`, from their own window: no session caller, no automation mark, no browser under automation, no test run) | the whole text and `hidden: true` | the notes PUT; its new text keeps the mark (409 `hidden_mark_kept`: Unhide shows it again) |
| Everyone else: an agent's notes read, `/api/v1/notes`, note_read, `/api/file-content` (raw and download too), plugins, replicas, the offline host copy, search, the index, embeddings, the journal context | its first frontmatter block, the stub and `hidden: true` | refused: 423 `note_hidden`; new text with the mark, 400 `hidden_note_text` |

- note_read answers the stub with a `next` line saying it is the person's private note and no
  tool reads it; note_edit and note_write are refused; locked_note_ask answers 409 `note_hidden`
  (no ask opens a hidden note).
- Only the person moves, renames, deletes or copies one, as for a locked note
  (`src/core/notes/locked-note-moves.ts`). A hidden note never goes onto a note Walnut writes
  itself, and those notes are never hidden (400 `not_lockable`).
- `POST /api/v1/notes/hide {path, expectedHash?}` and `POST /api/v1/notes/unhide {path,
  expectedHash?}` (`src/web/routes/hidden-notes-v1.ts`) answer `{path, contentHash, updatedAt,
  hidden, changed}`. The person only (403 `human_only`), on the Mac only (503 `not_here` on a
  replica), no Passwords session. A locked note answers 409 `note_locked`. After a hide, the
  indexes' freed copies of the text are wiped as after a lock.
- Lock works on a hidden note: its whole text is sealed, the mark with it, so Remove lock gives
  back the hidden note.
- In a git sync conflict a hidden side stays over a plain one, and a locked side over both.
- Its frontmatter tags are indexed; links and tags in its body are not. A tag rename leaves it as
  it is.

### On the Notes page

- The tree, Recent, Bookmarks and search rows show an eye-off beside a hidden note (from `hidden`
  in `/api/notes-v2/list`), unlike a locked note's lock (`web/src/components/notes/LockedMark.tsx`).
- Opening one shows its title, the line "Hidden from AI. Agents cannot read it, and its text is
  stored unencrypted." and Show, which needs no password
  (`web/src/components/notes/HiddenNoteCover.tsx`). Show puts the text in the ordinary editor,
  whose saves go through the notes route and keep the mark. Hide, a note switch, closing and
  reopening the note, or a reload covers it again: being shown lives in the page's memory, for that
  one open.
- While it is shown nothing hands it to a model: no dictation, the Notes page's chat is not told
  which note is open, and the tree's right-click menu offers no Note Agent chat or Claude Code
  session on it (nor on a locked note). The popout window covers it the same way, and a project's
  tracking pane shows the line above in place of its text.
- Unhide asks first: agents, search and the index can read the text again.
- `tests/web/hidden-note-surfaces-guard.test.ts` finds every web reader of a note's text and fails
  on one that is not classified, so a new surface cannot show a hidden note's text without Show.

### What it does not protect

The text is plain on disk, so these hold it in the clear: the note's file, the data folder's git
history (every commit since it was written), every machine the data folder syncs to (the cloud
companion's copy and each host replica's), and backups. An agent that reads files directly (a
shell, `host_exec`, a file copy between hosts) can read it; Walnut's tools cannot. That is the
difference from a locked note, whose file holds only ciphertext: a note that must stay out of
reach of anything an agent runs is locked, not hidden.

- The iPhone and the cloud companion show the stub: a replica never answers the text.
- An older Walnut (after a downgrade) has no hidden checks and shows the text to everyone.

## Limits

- Locking protects what is written from then on. The note's earlier plain versions stay where
  they already went: the data repo's git history (git sync commits every 30 seconds, so a note
  written plain is in it), a replica's or the phone's copy made before the lock, and backups
  outside Walnut. Walnut keeps that history as the person's backup and never rewrites it on its
  own (the user, 2026-11-25: git history "is needed, it has to be the backup"). To keep a note's
  text out of it from the start, lock the note while it is still empty, then write in it.
- Pages of the search databases written before this version may still hold pieces of a note's
  old text inside pages still in use; the wipe after a lock clears free pages, deleted full-text
  entries and the write-ahead logs, not those.
- A program that deliberately digs the window's Passwords unlock token out of the browser's
  storage and calls Walnut as that window reads the note while Passwords stays unlocked. Lock
  Passwords when done, or keep its unlock short ("Keep Passwords unlocked" in Settings).

- Images and attachments in a locked note are not encrypted, and the editor adds none (no Image
  button; a pasted or dropped image is not taken).
- Git sync: when one side of a conflict is locked and the other is a plain copy, the locked side
  stays, in a pull and in the replay after a history rewrite alike; the plain copy is in history.
- A change made on a replica while away, to a note locked on the Mac meanwhile, is not applied; its
  text, plain as it was typed on that device, is kept in the offline-conflict log file the letter
  names (`<data folder>/offline-conflicts/<drain>.ndjson`).
- Text typed into a locked note's file outside Walnut (another editor) is not part of its locked
  text and goes on its next sealed save.
- Old plain copies can stay in places Walnut does not wipe: free pages of the search databases
  and this browser's file cache from before the lock.
- An older Walnut (after a downgrade) has no lock checks: it shows the stub as the note and keeps
  the file as it is, but an edit or rewrite of the note there (by the person or an agent) can drop
  the ciphertext line and lose the note. The stub itself says not to edit the file anywhere else.
- Links and tags inside a locked note are not indexed while it is locked.
- The iPhone shows the stub: it neither shows nor edits a locked note's text.
- Notes Walnut writes itself cannot be locked: `global-notes.md`, memory folders, skills, and Inbox
  Triage's `State.md` and Runs notes (`walnutWritesNote`, `src/core/notes/vault-files.ts`).

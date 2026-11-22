# Standby copy of the data folder

A standby copy is a second, complete copy of this Walnut's home, kept current in batches,
in a folder on this machine or on another host, so another machine could one day take over
as the leader. This phase builds the copy and
keeps it honest; it does not switch leaders. Code: `src/core/standby/`. Behind the
experiment `switchable_leader` (off by default).

## What it does

- **Copies what the manifest says, nothing else.** Every path the data-location manifest
  (`src/core/home-manifest/`, [data-locations.md](./data-locations.md)) classes
  `leader-data` is copied; `machine` and `rebuildable` places are never read. A SQLite
  database rides as a consistent snapshot; its `-wal`, `-shm` and `-journal` never do.
- **One batch is one moment.** Everything in a batch is as it was at the batch's moment, or
  the batch is void.
- **The target keeps complete batches only.** It switches to a new batch in one step after
  checking every byte; a crash at any point leaves the previous batch whole.
- **Direct edits of the copy are found and undone (A3).** The copy is read-only on disk. A
  verify pass saves any file changed there under `drift/<time>/`, puts the batch's version
  back, and reports it once to Walnut Health.

## One moment

A batch runs in six steps (`batch.ts`):

1. **Scan.** Walk the home (`scan.ts`, about 0.4 s for 100k files) and compare each file's
   stat with the last batch: size, mtime, **ctime** and inode. Each dir's stat is noted too,
   before it is listed.
2. **Hold.** Hold Walnut's own gated writes for an instant (`src/utils/write-gate.ts`: every
   `withFileLock` section and every `writeTextFile`/`writeJsonFile`), wait for the ones under
   way, let 15 ms pass, read the filesystem's clock (the ctime of a probe file in
   `tmp/standby-staging/`: that is the batch's **moment**), then pin every database at once
   (`sqlite-pin.ts`: a worker thread holds a read-only connection to each and starts a read
   transaction on all of them; a commit that lands between the first pin and the last, seen
   by the `-wal` size or its header, which a WAL restart changes, makes it pin again; a
   database replaced since the scan voids the batch). Then the **names at the moment**
   (`moment-names.ts`): every dir whose stat moved since the scan, or whose ctime is at or past
   the filesystem clock read just before the scan (a second change in the tick the scan listed
   it does not move a coarse ctime), is listed again, so a file made after the scan is known to
   have existed at the moment even if it is replaced or removed right after. A dir listed again
   that changed after the moment too voids the batch: a name made and removed around the moment
   is in neither listing. Changed plain files and such new files, smallest first, up to 8 MB and 200 ms, are read
   into memory (the staging area) while the hold is on. Then writes go on.
3. **Stage.** Read the changed files the hold did not.
4. **Re-scan.** Walk again and place every path of either scan or of the moment's names: a
   path that did not exist at the moment is the next batch's; a file whose last change came
   before the moment is taken now; anything else (changed after the moment with no copy from
   before it, a dir whose names at the moment cannot be told) voids the batch.
5. **Databases.** Copy each changed database as pinned (`sqlite3_serialize` inside its read
   transaction, in the worker's memory: page for page, so only the chunks whose pages changed
   are new). The pins hold since the moment, so this comes after the re-scan: the window in
   which a plain file's change can void the batch is the scan time, not the databases' copy.
6. **Send.** Fixed 1 MiB chunks named by their sha256 (`chunks.ts`), sent as they are read,
   only those the target lacks. Then commit. Fixed, not content-defined like the backup's
   chunker: cutting by content is a JavaScript pass over every byte, and made one batch of a
   1.2 GB database take about 100 s; a home's large files (databases, appended logs,
   recordings) change in place or at the end, where fixed chunks dedupe as well.

**The rule every read follows** (`stage.ts`): before the read, the file's ctime must be below
the moment; after it, its size, mtime, ctime and inode are unchanged and as many bytes were
read as its size. No program can set a ctime, so this proves nothing touched the file from
before the moment until the read ended. The moment is read on the filesystem's own clock
because a ctime comes from a coarse kernel clock: on clouddev a write's ctime lagged the wall
clock by 10 ms, enough to place a write made after a wall-clock moment before it (seen in a
test, 2026-11-21). The content is hashed once, while it is read; a second hash after the read
would cost a second full read and prove nothing the unchanged ctime does not. The hold makes a void batch
rarer; this rule, with the names at the moment, is what keeps a committed batch to one
moment, whatever the writer: the notes app, a plugin's process, a person. It rests on the
filesystem keeping ctimes as POSIX says (a name added to or removed from a dir moves the dir's
ctime); tested on Linux ext4, not yet on APFS.

**Changes the scan sees.** Any write, rename or `utimes` moves a file's ctime, so a rewrite
that keeps the size and the mtime is still seen. Not seen: a change while the system clock
was set back to the exact nanosecond of the old ctime.

**Append-only files.** A file the manifest marks `appendOnly` (logs Walnut and other processes
append to, outside the write gate: the session audit log, time samples, replay step logs, the
voice vocabulary; `src/core/home-manifest/`) changes after the moment almost every time. Its
size (cut back to the end of its last whole line: an appender outside the gate may be in the
middle of a write), inode and the hash of its last 4 KiB are noted in the hold just before the
moment, and the batch takes its first that many bytes (`append-only.ts`), checked: the same inode and at
least that size before and after the read, the noted tail unchanged, and, when the last batch
holds the same inode, its first (last batch's size) bytes still the last batch's content. A
file replaced by a compacted copy (a new inode) is taken as the new file. One that did not only
grow (cut, rewritten in place) goes to the general rule: taken if it was quiet since before the
moment, else the batch is void, so one rewrite never voids every batch after it. Not caught: a
rewrite in place, after the mark, of bytes between the last batch's end (the file's start, when
the last batch holds no copy of this inode) and the noted tail. A marked file whose stat is the
last batch's is only stat'ed in the hold; the marks run 64 at a time.
An entry is marked only after reading every writer of it (2026-11-21: `session-audit.jsonl`,
`time-tracking/` day logs, `browser/replays/*/index.jsonl`, `offline-conflicts/*.ndjson`,
`config/share/stt-vocab.txt`, `cache/suggest-accuracy.jsonl`); files people edit (notes, the
daily log) are not marked, since an editor may write in place.

**A void batch** commits nothing, the target's position does not move, and the runner tries
again two seconds later (three times), then at the next period. Void when: a file or
database cannot be read; a database cannot be pinned or copied (a damaged one, one that went
away); a file changed while it was copied; a change cannot be placed before or after the
moment; the writes under way did not end within 300 ms.

## The target

```
<target>/standby.json       which batch is current: written last, the one step
<target>/batches/<n>.json   the current batch's manifest (path, size, sha256, chunks, stat)
<target>/chunks/<aa>/<id>   chunks, checked against their sha256 when they arrive and when read
                            (a damaged one is removed, so the next batch sends it again)
<target>/copy/              the copy of the home: files 0400 (0500 executable), dirs 0500
<target>/copy-stat.json     each copied file's stat as written: a cheap verify compares it
<target>/.apply/            a batch being made current: journal.json, new/, old/
<target>/drift/<time>/      what a verify pass (or a commit, `<time>-commit`) found changed in
                            copy/, and report.json
```

The whole target is its owner's only (0700): it holds the home's credentials.

**Commit** (`target.ts`): build every new or changed file in `.apply/new/` from its chunks
(each chunk and the whole file checked against their hashes), write the manifest and a
journal of the swap, move each file into `copy/` (what it replaces goes to `.apply/old/`),
then write `standby.json`. Every caller (commit, verify) runs recovery first: with a journal
and no state write, every path goes back to the previous batch; with the state write done,
only the cleanup is left. A batch with no change writes no chunk, no file and no manifest:
only the position (`batch`, `takenAt`) moves.

A changed file of two chunks or more whose copy is still as commit wrote it (copy-stat) is made
from that copy (`buildPatched`): cloned (shared blocks on APFS and reflink filesystems; on
ext4 the kernel copies it, which still writes the whole file but never through the process),
its changed chunks written, cut to size, and its whole hash checked. A copy edited directly is
not cloned: the file is built from its chunks and the edit saved to drift. A kill between the
clone and the patch leaves `.apply/new/` only, which recovery removes.

Before the swap, each path the batch replaces or removes is compared with what the last commit
wrote (`copy-stat.json`): a file edited in the copy is saved to `drift/<time>-commit/` first,
so a commit never drops an edit silently, and an entry that is not a dir on the way to a path
(a link someone put there) is moved there whole, so nothing is ever written through it. A
failure of the state write rolls the swap back unless the write had landed; a failure of the
cleanup after it leaves the batch current, and the next caller's recovery finishes it.

Tested (`tests/core/standby/target-crash.test.ts`): a process killed with SIGKILL after the
files are built, after the journal, between moving a file's old version out and its new one
in, halfway through the swap, after the swap, and after the state write; the disk full while
chunks arrive and while files are built. Each leaves one whole batch that verifies.

## Verify (A3)

`verifyStandby` (`verify.ts`) works in an order that never writes through an entry someone put
in the copy. First it moves to `drift/<time>/files/`, as they are, every entry that is neither
a file nor a dir (a link is moved, never followed), every dir where a file of the batch
belongs, every dir no file of the batch lies under, and every other file the batch does not
have. Such a dir holding no file is removed quietly (nothing in it to save; a crash during a
commit can leave one), as is a repair's temp file a crash left. Then it compares each file of the batch with what commit wrote:
its stat first (an edit, a chmod, a replace moves the ctime or the inode), its sha256 when the
stat moved or with `--deep`. A changed file is copied to drift, then built again from its
chunks; a missing one is built again; one it cannot read is opened and read, or moved to drift
and built again; a dir it cannot read is opened. Last, every dir gets its read-only mode back
(quietly: the edit inside is what is reported). One `report.json` per pass that found drift;
the server hands each report, a commit's included, to Walnut Health once
(`publishErrorNotification`, no `needsYou`: it never pops up to the person). A CLI pass leaves
its report for the server's next pass. The runner verifies after every batch; `--deep` also
removes chunks no file uses any more, once they are six hours old (a batch cut off part way
sent them, and the next batch takes them instead of sending them again).

## A target on another host

With `standby.host` set, the target folder is on that host, reached through its session
daemon over the link Walnut already keeps to it (`src/core/hosts/link.ts`: SSH or the host
network alike). It opens no port, needs no credential of its own and adds no daemon command
(`remote-transport.ts`, the leader's side; `receive.ts`, the host's side).

**Before you turn it on: the host needs the walnut program.** The receiving side is
`walnut standby receive <op> <dir>`, the same `StandbyTarget` code a local target runs, so it
needs Walnut installed there (`standby.walnut` names it when it is not `walnut` on the PATH a
script there sees). A host that runs only Walnut's session daemon has no such program yet; once
the daemon and the server are one program, every host has it.

| Step | How it goes | Why that way |
|---|---|---|
| Read the target | `walnut standby receive init` (run by the daemon's `exec.script`) makes the target owner-only, finishes an apply a kill cut off, and writes into `.incoming/` the chunk ids it holds and its current files, only those the leader does not hold already; the leader reads that file with `fs.readRange` | One run and one read per batch; an unchanged batch reads about 100 bytes back |
| Send chunks | `fs.writePart`, one 1 MiB chunk a part, eight in flight and up to 256 MiB held to send: the daemon stages it, checks its sha256 (the chunk's name), and renames it into `chunks/` | A chunk is there whole or not at all, so a batch cut off part way leaves every chunk it sent for the next batch; the batch reads its files right after its moment while a slow link sends (reading at the link's pace voided 4 of 5 batches under a steady writer at 20 Mbit/s). A batch that changed more than the 256 MiB reads at the link's pace again once the buffer is full, so a large incremental batch over a slow link can still be void; the leader then holds the largest database being copied plus those 256 MiB |
| Send the batch | an upload (`BatchUpload`: the files that differ from the target's batch, and the paths gone), gzipped, written the same way | An incremental batch sends its few changed entries, not a manifest of every file |
| Make it current | `walnut standby receive apply` rebuilds the whole manifest from its own current batch and the upload, takes it only when its sha256 is the leader's, then runs `StandbyTarget.commit` and a verify pass | The same rules as a local target, word for word: every chunk and file checked, one switch, a kill or a full disk leaves the batch before whole |

A dropped link is dialled again and the command sent again for up to two minutes; only commands
that do the same thing twice are sent twice. A host Walnut does not know fails at once. When the
target replaces a file's version it removes the chunks only the old version used, and the leader
forgets them too, so a file put back to an old version sends them again. The receiving side
refuses a target folder that lies in that machine's own Walnut home or holds it, as a local
target is refused, with symlinks resolved; "its own Walnut home" is the one the receive run
sees (`OPEN_WALNUT_HOME` in the environment the daemon gives its scripts, else `~/.open-walnut`),
so a host whose Walnut runs on another home must give its daemon that variable. Turning the
standby off, or changing its host or folder, drops the chunks still waiting to go there: only
the parts already on the wire finish. An apply whose answer was lost (the link went
while it ran) is never sent again: the leader asks the target which batch it holds and takes
the answer from there. A target another leader moved meanwhile refuses the upload (it is
against another batch), and the next batch reads it again. A chunk the leader believed the
target held, gone there, fails one batch; the next reads the target's list again and sends it.

Limits:

- An apply runs within the daemon's script limit (10 minutes). The first batch of the 20 GB
  synthetic home applied in 339 s on a busy dev box; a home whose apply takes longer there is
  stopped each time, keeps the batch before (none, for a first batch) and never gets further.
  The way past it is an apply that is not a script, once the standby host runs Walnut itself.
- While a database's changed chunks wait to go, its pin stays open: on the first batch over a
  slow link (a 1.5 GB database at 20 Mbit/s, about ten minutes) the leader's WAL cannot be
  checkpointed meanwhile and grows. Incremental batches send a database's few changed chunks.
- After any failure the leader reads the target's whole chunk list again (about 33 bytes a
  chunk, gzipped, one read).
- A host out of reach is reported behind once, about five minutes after its last batch plus the
  two minutes a dropped link is waited for, naming the last batch known there; its batches are
  not tried again until the next tick.
- Answers carry at most 50 drift items and 20 reports a pass (the rest wait on that host for the
  next pass), so a large drift never overflows the script's output.

## Running it

Settings › Experimental › "Standby copy of this Walnut", and in `config.yaml`:

```yaml
standby:
  dir: /path/to/standby   # on this machine, outside the home, or on `host`
  host: my-standby-box    # optional: a host Walnut knows (it needs the walnut program, above)
  walnut: /opt/walnut/bin/walnut   # optional: the walnut program there (default `walnut`)
  interval_seconds: 30    # optional
```

Off, nothing runs: no timer, no write gate, no file. On a replica, or an ephemeral server
(unless `WALNUT_EPHEMERAL_STANDBY=1`), it never runs. The setting is read again at every
config change. More than five minutes behind is reported to Walnut Health once.

CLI (works on any home, an ephemeral server's included):

```bash
walnut standby snapshot --to <dir> [--home <dir>]   # one batch (exit 2: void)
walnut standby verify <dir> [--deep]                # exit 3: drift found and repaired
walnut standby status <dir>
```

From the CLI the batch cannot hold the server's writes (the gate lives in the server's
process), so on a busy server a batch is void more often; it is never wrong.

## Measured

`scripts/standby-bench.ts <work dir> [--gb 20] [--files 100000] [--append-ms 20]` builds a
synthetic home and measures. On clouddev (ext4 on a shared, busy disk, 2026-11-21), a 21.8 GB
home with 99,896 leader files and four WAL databases of 1.8 GB together:

| What | Measured |
|---|---|
| Scan of the home | 1.0 to 1.1 s |
| First batch (5 GB of unique chunks, 21.8 GB copy built) | 1,072 s, hold 99 ms |
| Incremental batch, notes and two databases written all the time | hold p50 82 ms, p95 111 ms, max 111 ms (of it, names at the moment p50 55 ms); 2 of 20 void |
| Incremental batch time | p50 28 s, p95 37 s: the two changed databases (1.5 GB) are serialized, hashed and built again in the copy whole |
| Verify / deep verify | 1.1 s / 77 s, no drift |
| Target size | 27.2 GB (the copy plus its chunks) |
| An ungated writer appending to one file every 20 ms | 20 of 20 void ("late"): see below |

A smaller home (1.85 GB, 4,897 files, the same four databases), 10 batches each, after the
hold learnt to read stats in changed dirs (`heldStats`) and to read small files first: gated
writes 0 of 10 void, hold p50 39 ms, p95 50 ms; with an ungated append every second 0 of 10
void; every 200 ms, 2 of 10 void. The real server test (`tests/e2e/standby-real-server.test.ts`)
gives 0 of 8 void, hold p50 28 ms, p95 61 ms.

The same 20 GB home, 10 incremental batches each, before (mac/main at 2026-11-21) and after
the patched large files and the append-only marks:

| What | Before | After |
|---|---|---|
| Incremental batch time | p50 32.1 s, p95 41.1 s | p50 23.7 s, p95 24.7 s |
| Written into the copy's files by the process per batch | the changed files whole (1.5 GB) | p50 2.6 MB (20 files patched) |
| Disk writes per batch (`/proc/self/io`) | p50 1,485 MB | p50 1,479 MB: ext4 has no reflink, so the clone is a kernel copy of the whole file |
| Hold | p50 89 ms, p95 158 ms | p50 82 ms, p95 96 ms |
| An ungated append every 20 ms to the session audit log | 10 of 10 void | 0 of 10 void (8,819 appends during the batches) |

On APFS the clone shares the blocks, so the disk writes should fall to the patched chunks too:
not measured yet.

**Writes the gate does not hold** void a batch when they land on a file between the moment
and its read, unless the file is marked append-only (above). Before the marks, one append
every 20 ms to the session audit log voided every batch.

## Not done yet

- No promotion: swapping the copy in at boot (`src/core/backup/restore-switch.ts`) and making
  it writable is phase B.
- A target on another host needs the walnut program there (above), and its real bandwidth
  between two machines is not measured yet (the numbers above are a real daemon on one machine
  over a link slowed in the transport); that is for phase B's drill on the Mac's own link.
- Chunks travel base64 inside the daemon's JSON frames, a third more bytes than the chunk.
- No change log ("about to change" / "done" lines): the scan is fast enough every 30 s.
- A changed database is copied whole into the pin worker's memory each batch it changed (its
  size in memory for a moment, then hashed; only changed chunks travel). On ext4 its file in
  the copy is still copied whole by the kernel each batch (no reflink); APFS shares the blocks.
- An appended file not marked append-only (one a person may edit, a file outside the manifest's
  marks) still voids a batch when it changes between the moment and its read.
- The target needs up to twice the home's size (the copy, and its chunks, which dedupe repeated content).
- A rollback-journal (not WAL) database holds its writers while it is copied.
- Debounced writes that are still in memory are not in a batch (the same as at a crash);
  a manual switch must flush first (phase B).
- Symlinks in the home are skipped, as the backup skips them.
- Reading a WAL database read-only needs its `-wal` file: when one is missing, the pin worker
  creates it empty in the home (the copy's one write to the leader's side; SQLite would do the
  same on its next open).
- The write gate knows a held write by an async context: a timer or a detached promise started
  inside a gated section inherits it and passes the gate later. That only makes a void batch
  more likely, never a wrong one (the rule above does not rely on the gate).

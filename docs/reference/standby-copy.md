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

A home of real size takes minutes to read (about 4.5 minutes for 20 GB), and the leader never
stops writing meanwhile: its git auto-commit every 30 s, its stores, sessions, notes. So a
batch **reads first and fixes its moment after**, when little is left to read (`batch.ts`,
`batch-round.ts`):

1. **Pass.** Walk the home (`scan.ts`, about 0.4 s for 100k files) and compare each file's
   stat with the last batch: size, mtime, **ctime** and inode. Each dir's stat is noted too,
   before it is listed. Then the **catch-up read**: every changed file the batch holds no copy
   of is read, four at a time, by the read rule below against the filesystem's clock read just
   before (a first batch reads the whole home here, with no hold). A catch-up that took over a
   second is followed by another pass, which reads only what changed meanwhile (at most eight
   such passes), so the round below starts with little left to read.
2. **Round: hold.** Hold Walnut's own gated writes for an instant (`src/utils/write-gate.ts`:
   every `withFileLock` section and every `writeTextFile`/`writeJsonFile`), wait for the ones
   under way, let 15 ms pass, mark the append-only files, read the filesystem's clock (the
   ctime of a probe file in `tmp/standby-staging/`: that is the round's **moment**), then pin
   every database at once (`sqlite-pin.ts`: a worker thread holds a read-only connection to
   each and starts a read transaction on all of them; a commit that lands between the first
   pin and the last, seen by the `-wal` size or its header, which a WAL restart changes, makes
   it pin again). Then the stat of each **hot** file (changed in the minute before the batch
   started or since, or a read of it was not taken; at most 4,096, the newest first), and a
   read of each hot file that changed before the moment since its copy. Then the **names at
   the moment** (`moment-names.ts`): every dir whose stat moved since the walk, or whose ctime
   is at or past the filesystem clock read just before the walk (a second change in the tick
   the walk listed it does not move a coarse ctime), is listed again with the stat of each of
   its files, so a file made after the walk is known to have existed at the moment even if it
   is replaced or removed right after. A dir listed again that changed after the moment too
   fails the round (a name made and removed around the moment is in neither listing), except a
   dir of git's object store (below). The listed files that changed since their copy, and the
   git objects new since the walk, are read too. Every read in the hold goes smallest first, up
   to 8 MB and 200 ms, into memory. Then writes go on.
3. **Round: databases.** Copy each changed database as pinned (`sqlite3_serialize` inside its
   read transaction, in the worker's memory: page for page, so only the chunks whose pages
   changed are new); each pin ends once its database is copied.
4. **Round: place.** Walk again and give each path that existed at the moment its content then,
   by its kind's rule (the table below). A path no rule places fails the round.
5. **Commit.** Fixed 1 MiB chunks named by their sha256 (`chunks.ts`) went to the target as they
   were read, only those it lacks; the commit names them. Fixed, not content-defined like the
   backup's chunker: cutting by content is a JavaScript pass over every byte, and made one
   batch of a 1.2 GB database take about 100 s; a home's large files (databases, appended
   logs, recordings) change in place or at the end, where fixed chunks dedupe as well.

**A failed round** is not a void batch: the batch goes back to step 1 and keeps every copy it
read, so the next pass reads only what changed again, and the next round has a moment of its
own. The batch is void after ten failed rounds (`maxRounds`), with the last round's reason.

### Changes while a batch reads

Each kind of leader data has one answer to "this changed after the moment, or while the batch
read it" (`change-rules.ts`; `tests/core/standby/change-rules.test.ts` fails for a manifest entry
or kind with none):

| Kind | Which files | Answer |
|---|---|---|
| Snapshot | every SQLite database (manifest kind `sqlite`, or a database by name and header) | pinned at the moment in a read transaction; commits after it never reach the copy |
| Prefix | files the manifest marks `appendOnly` | their bytes up to their size at the mark, while they only grew (below) |
| Content-addressed | git's loose objects (`.git/objects/xx/<hash>`) and pack files (`pack-<hash>.pack`, `.idx`, `.rev`, `.bitmap`, `.mtimes`) | git names each by the hash of its content and writes it once (a temp file renamed into place), so any whole copy of that name is its content: its times do not count (git freshens an object by touching it), only that the same file was read whole at one size. A dir of the object store need not have known names at the moment: an object new after it is one more object no ref names yet, and one removed after it (a repack) is taken from the copy the batch read; one the batch saw and never read fails the round |
| Not copied | a git command's scratch: every `*.lock` in `.git`, `tmp_*` objects, packs and commit graphs, `incoming-*` quarantine dirs, `gc.pid` | there only while that command runs, which does not run on the standby: a copied `index.lock` would stop every git command there, a copied `gc.pid` its gc for 12 hours. The walk skips them |
| Quiet through the moment | every other file: Walnut's stores, notes, config, git's refs, index and logs | a copy counts when a stat read after the moment equals the one its read proved (ctime only moves forward, so nothing wrote it between); else, when its last change came before the moment, it is read now; else the round fails |

The git answers rest on git's own rule: it deletes an object file only once the object is in a
pack, or once it is unreachable and older than the prune age (an hour in `git-maintenance.ts`).
A history rewrite (`git-compaction.ts`, `gc --prune=now`) during a batch only fails its rounds:
an object the batch saw at the moment and holds no copy of is never left out silently.

**The rule every read follows** (`stage.ts`): before the read, the file's ctime must be below
the filesystem's clock read just before (the moment itself, for a read in or after the hold);
after it, its size, mtime, ctime and inode are unchanged and as many bytes were read as its
size. No program can set a ctime, so this proves nothing touched the file from before that
clock reading until the read ended; a catch-up copy then counts at the moment while a stat
read after the moment still equals it. The moment is read on the filesystem's own clock
because a ctime comes from a coarse kernel clock: on clouddev a write's ctime lagged the wall
clock by 10 ms, enough to place a write made after a wall-clock moment before it (seen in a
test, 2026-11-21). The content is hashed once, while it is read; a second hash after the read
would cost a second full read and prove nothing the unchanged ctime does not. The hold makes a failed round
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
moment, else the round fails, so one rewrite never voids every batch after it. Not caught: a
rewrite in place, after the mark, of bytes between the last batch's end (the file's start, when
the last batch holds no copy of this inode) and the noted tail. A marked file whose stat is the
last batch's is only stat'ed in the hold; the marks run 64 at a time.
An entry is marked only after reading every writer of it (2026-11-21: `session-audit.jsonl`,
`time-tracking/` day logs, `browser/replays/*/index.jsonl`, `offline-conflicts/*.ndjson`,
`config/share/stt-vocab.txt`, `cache/suggest-accuracy.jsonl`); files people edit (notes, the
daily log) are not marked, since an editor may write in place.

**A void batch** commits nothing, the target's position does not move, and the runner tries
again two seconds later (three times), then at the next period. Void at once when a file or
database cannot be read, or a database cannot be opened or copied (a damaged one); void after
ten failed rounds, each failed by a change it could not place at its moment (a file changed
after the moment with no copy from before, a database replaced or not pinned, a dir whose
names at the moment cannot be told, writes under way that did not end within 300 ms).

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
| Stage chunks | each chunk to send is written to the leader's disk first, in the home's `tmp/standby-spool/` (rebuildable), and removed once the host has it (`remote-spool.ts`) | The batch reads its files and its databases at the disk's pace, whatever the link's: its files are read right after its moment (reading at a slow link's pace voided 4 of 5 batches under a steady writer at 20 Mbit/s), however much the batch changed, and its database pins end once the databases are read, so the leader's WAL is checkpointed again while the link still sends. Before each chunk the disk's free space is read: one that would leave less than the reserve (2 GiB or 1% of the disk, the larger) free is refused, the batch is void and says so, and the chunks staged already still go. A folder of a leader killed mid-batch is removed by the next batch |
| Send chunks | `fs.writePart` from the spool, one 1 MiB chunk a part, eight in flight: the daemon stages it, checks its sha256 (the chunk's name), and renames it into `chunks/` | A chunk is there whole or not at all, so a batch cut off part way leaves every chunk it sent for the next batch |
| Send the batch | an upload (`BatchUpload`: the files that differ from the target's batch, and the paths gone), gzipped, written the same way | An incremental batch sends its few changed entries, not a manifest of every file |
| Make it current | `walnut standby receive apply` (the first batch, one changing 512 MiB or more, and the one after a script apply ran past its limit start it as a background job with the daemon's `exec.run`, `remote-apply.ts`; the rest run it as one `exec.script` run, which leaves no job, log or audit line there, so a batch every 30 s never fills the daemon's table of 200 jobs) rebuilds the whole manifest from its own current batch and the upload, takes it only when its sha256 is the leader's, then runs `StandbyTarget.commit` and a verify pass; it keeps its state in a status file in `.incoming/` (running with a heartbeat every 10 s, then done with its answer, or failed), which the leader reads every 2 to 5 s; when the heartbeat stops changing for 20 s, the leader asks the host (`walnut standby receive job`) whether the apply's process still lives there, judged on that machine's clock. The daemon's job record is never read (that is a task's `host_exec`, under its grant) | The same rules as a local target, word for word: every chunk and file checked, one switch, a kill or a full disk leaves the batch before whole. No command stays open for the apply, so an apply is not stopped at a command's limit (a script's 10 minutes) |

A dropped link is dialled again and the command sent again for up to two minutes; only commands
that do the same thing twice are sent twice. A host Walnut does not know fails at once. When the
target replaces a file's version it removes the chunks only the old version used, and the leader
forgets them too, so a file put back to an old version sends them again. The receiving side
refuses a target folder that lies in that machine's own Walnut home or holds it, as a local
target is refused, with symlinks resolved; "its own Walnut home" is the one the receive run
sees (`OPEN_WALNUT_HOME` in the environment the daemon gives its scripts, else `~/.open-walnut`),
so a host whose Walnut runs on another home must give its daemon that variable. Turning the
standby off, or changing its host or folder, drops the chunks still waiting to go there: only
the parts already on the wire finish. One batch is one job id (from the target, the batch, its
moment and its manifest's hash): a start sent again after its answer was lost is refused
`job_exists` by the daemon, which knows the ids of the runs it and the daemon before it ran,
so an apply never runs twice. A job that ends without writing its answer (killed there) fails
the batch, and the target's journal leaves the batch before whole for the next one. While an
apply runs there, `init`, `verify` and `reported` say the target is busy at once (its process
lives and its heartbeat is fresh) instead of waiting on the target's lock: a leader that
restarted meanwhile has void batches until the apply ends, then goes on from the batch it made.
An apply whose end the leader could not follow (the link went for longer than it waits, or the
start was refused in a way that leaves it unsure) is judged by the batch the target holds
afterwards: one that ended counts as it ended there, and one that still runs there answers
"busy", so this batch counts as failed and the next starts from whatever it left. The job is
started as `host_exec` starts one: its process group ended with it, detached only where the
daemon can do both, and logged there for the caller `standby-copy`; a daemon that cannot run
background commands (older than `host-exec-v1`) fails each batch saying to update Walnut there.
Until the apply's CLI writes its first status (about a second), another op there waits on the
lock instead of hearing "busy": safe, only slower. A target another leader moved meanwhile refuses the upload (it is
against another batch), and the next batch reads it again. A chunk the leader believed the
target held, gone there, fails one batch; the next reads the target's list again and sends it.

Limits:

- An apply runs within the daemon's limit for a background job (2 hours, `BACKGROUND_MAX_MS`); a
  small batch's, run as a script, within 10 minutes (one that runs past it fails its batch, and the
  next batch runs as a job).
  The first batch of the 20 GB synthetic home applied in 339 to 390 s on a busy dev box (below),
  so the limit is about 20 times that; a home whose apply takes longer is stopped each time and
  keeps the batch before. A daemon update there waits for the job (it is not resumable), unless
  the job runs detached (the `work_survives_restart` experiment and `host-exec-detach-v1`).
- The spool takes up to the batch's new chunks not sent yet on the leader's disk (about 4 GB
  for the first batch of the 20 GB home at 20 Mbit/s; an incremental batch its few MB), written
  once more than before; see Measured. A spool or staging folder of a leader that is gone is
  removed by the next batch, and one of another process left untouched for a day (its pid
  reused by some other program) too.
- After any failure the leader reads the target's whole chunk list again (about 33 bytes a
  chunk, gzipped, one read).
- A host out of reach is reported behind once, about five minutes after its last batch plus the
  two minutes a dropped link is waited for, naming the last batch known there; its batches are
  not tried again until the next tick.
- A batch that runs past five minutes while the standby holds nothing newer (the first batch
  over a slow link sends for about an hour) is reported behind once while it still runs, with
  how much of what it staged went, or that its apply runs there. A batch that lands late is
  progress, not a new report; the episode ends with the first batch that lands fresh.
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

### A target on another host

`--remote [--mbit 20] [--down-mbit 100] [--rtt-ms 50] [--fast-first] [--big-mb N]` sends the
batches to a real session daemon (the standalone twin, run from its source) on the same
machine, and the real walnut CLI there takes them. The link is slowed in the transport, not in
the system's network: each frame waits for its bytes at the given rate, and half the round trip
each way. `--fast-first` sends the first batch unslowed; `--big-mb N` adds one batch after a new
file of N MiB, with the writers on. The same 21.8 GB home on clouddev (2026-11-22, host load 40
to 100 on 48 cores), the chunks staged in the spool and the apply a background job:

| What | At 20 Mbit/s up, 50 ms round trip | Unslowed (loopback) |
|---|---|---|
| One 1 MiB chunk, one at a time / eight in flight | 655 ms / 562 ms: the wire (1.4 MB of base64 takes 559 ms) | 34 to 94 ms / 14 to 37 ms |
| First batch | 3,505 s (58 min): 104,299 commands, 6.71 GB up for 5.0 GB of chunks | 838 s |
| Its database pins (from the pins to the last one's end) | 45 s | 53 s |
| Its apply there (a background job) | 256 s | 251 s |
| Its spool: most held at once / time its writes took | 3.97 GB / 160 s | 0.14 GB / 231 s |
| Incremental batch, notes and two databases written all the time | 1 of 3 void (a note changed after the moment and not read in the hold: the general rule, not the link); 31 s, pins 11 s, apply 13 s | 0 of 3 void; p50 31 s, pins p50 13 s |
| The same plus an ungated append every 20 ms | 0 of 3 void; p50 30 s, pins 11 s | 0 of 3 void; p50 31 s, pins 13 s |
| A batch after a new 400 MiB file, writers on | not void: 251 s, 541 MB up, pins 11 s | not void: 39 s, pins 12 s |
| Verify / deep verify there | 1.2 s / 73 s, no drift | 1.7 s / 85 s, no drift |

The pins end once the databases are copied (each one's with its copy, the databases first),
so they last as long as the local copy, whatever the link: 45 s at 20 Mbit/s and 53 s unslowed
for the first batch (the second number is the busier run). Before the spool the first batch's
pins lasted 458 s at 20 Mbit/s with the files read under them, and before that until the last
chunk went (about an hour). Before the send queue, the batch read its files only as fast as
the window of eight chunks went out, and at 20 Mbit/s 4 of 5 incremental batches were void
("late"); a batch larger than the queue's 256 MiB would have been read at the link's pace
again, and the spool has no such size. An apply ran 1,261 s as a background job on the real
daemon (the test `an apply that runs longer than a command may`, run once by hand with
`STANDBY_LONG_APPLY_MS=1260000`), past a script's 10-minute limit. The spool costs one more
local write of each new chunk (5 GB for the first batch here), and holds what the link has not
sent yet: up to about 4 GB at 20 Mbit/s, a few MB for an incremental batch.

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

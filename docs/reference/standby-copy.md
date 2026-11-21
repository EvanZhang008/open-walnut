# Standby copy of the data folder

A standby copy is a second, complete copy of this Walnut's home, kept current in batches,
so another machine could one day take over as the leader. This phase builds the copy and
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
   is in neither listing. Changed plain files and such new files, up to 8 MB in total, are read
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
removes chunks no file uses any more.

## Running it

Settings › Experimental › "Standby copy of this Walnut", and in `config.yaml`:

```yaml
standby:
  dir: /path/to/standby   # on this machine, outside the home
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

`scripts/standby-bench.ts <work dir> [--gb 20] [--files 100000]` builds a synthetic home and
measures. On clouddev (ext4, 2026-11-21) see the numbers in the task's report; the scan of
100k files is about 0.4 s, and the hold stays under the 0.5 s target because the scan runs
outside it.

## Not done yet

- No remote transport: the target is a directory on this machine (`StandbyTransport` in
  `types.ts` is the interface a remote one implements). No promotion: swapping the copy in at
  boot (`src/core/backup/restore-switch.ts`) and making it writable is phase B.
- No change log ("about to change" / "done" lines): the scan is fast enough every 30 s.
- A changed database is copied whole into the pin worker's memory each batch it changed (its
  size in memory for a moment, then hashed; only changed chunks travel).
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

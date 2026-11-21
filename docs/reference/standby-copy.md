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

A batch runs in five steps (`batch.ts`):

1. **Scan.** Walk the home (`scan.ts`, about 0.4 s for 100k files) and compare each file's
   stat with the last batch: size, mtime, **ctime** and inode.
2. **Hold.** Hold Walnut's own gated writes for an instant (`src/utils/write-gate.ts`: every
   `withFileLock` section and every `writeTextFile`/`writeJsonFile`), wait for the ones under
   way, let 15 ms pass, read the filesystem's clock (the ctime of a probe file in
   `tmp/standby-staging/`: that is the batch's **moment**), then pin every database at once
   (`sqlite-pin.ts`: a worker thread holds a read-only connection to each and starts a read
   transaction on all of them; a commit that lands between the first pin and the last makes
   it pin again). Changed plain files up to 8 MB in total are read into memory (the staging
   area) while the hold is on. Then writes go on.
3. **Stage.** Copy each changed database as pinned (`sqlite3_serialize` inside its read
   transaction, in the worker's memory: page for page, so only the chunks whose pages changed
   are new) and read the changed files the hold did not.
4. **Re-scan.** Walk again and place every move since step 1: a file whose last change came
   before the moment is taken now; a file born after the moment is the next batch's; anything
   else (changed after the moment with no copy from before it, removed around the moment)
   voids the batch.
5. **Send.** Fixed 1 MiB chunks named by their sha256 (`chunks.ts`), sent as they are read,
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
rarer; this rule makes a wrong batch impossible, whatever the writer: the notes app, a
plugin's process, a person.

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
<target>/drift/<time>/      what a verify pass found changed in copy/, and report.json
```

The whole target is its owner's only (0700): it holds the home's credentials.

**Commit** (`target.ts`): build every new or changed file in `.apply/new/` from its chunks
(each chunk and the whole file checked against their hashes), write the manifest and a
journal of the swap, move each file into `copy/` (what it replaces goes to `.apply/old/`),
then write `standby.json`. Every caller (commit, verify) runs recovery first: with a journal
and no state write, every path goes back to the previous batch; with the state write done,
only the cleanup is left. A batch with no change writes no chunk, no file and no manifest:
only the position (`batch`, `takenAt`) moves.

Tested (`tests/core/standby/target-crash.test.ts`): a process killed with SIGKILL after the
files are built, after the journal, between moving a file's old version out and its new one
in, halfway through the swap, after the swap, and after the state write; the disk full while
chunks arrive and while files are built. Each leaves one whole batch that verifies.

## Verify (A3)

`verifyStandby` (`verify.ts`) compares each file of the current batch with what commit wrote:
its stat first (an edit, a chmod, a replace moves the ctime or the inode), its sha256 when the
stat moved or with `--deep`. A changed file is copied to `drift/<time>/files/`, then built
again from its chunks; a file the batch does not have is moved there; a missing one is built
again. One `report.json` per pass that found drift; the server hands each report to Walnut
Health once (`publishErrorNotification`, no `needsYou`: it never pops up to the person). A CLI
pass leaves its report for the server's next pass. The runner verifies after every batch;
`--deep` also removes chunks no file uses any more.

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

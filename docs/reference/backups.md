# Backups

Walnut backs up its data folder (`~/.open-walnut`: notes, tasks, sign-ins, settings) to a
place the user already has: Cloudflare R2, Google Drive, or an Amazon S3 bucket (or any
S3-compatible service). Only the data folder: the password vault and the fleet secrets of a
real install live outside it (`~/.local/state/open-walnut/`, `src/core/vault/paths.ts`) and
are in no backup; only a throwaway server (a test, an ephemeral server) keeps its vault inside
its data folder. `open-walnut backup drill` lists everything backups leave out. Encryption is a switch, off by default: off, the
files go up as they are and there is no key to keep; on, everything is encrypted on the
computer before it is uploaded, and only the recovery key opens it. Settings, Backup can
list the backups and restore any of them into a new folder.

Code: `src/core/backup/` (engine), `src/web/routes/backup*.ts` (routes),
`web/src/components/settings/sections/BackupSection.tsx` and `sections/backup/` (the pane),
`src/commands/backup.ts` (`open-walnut backup run | list | restore | drill`).

## Setting it up

1. Settings, Backup, "Where backups go": pick a service.
   - **Cloudflare R2**: Account ID, bucket, and an R2 API token's access key ID and secret
     (the steps are in the pane under "Where to find these in Cloudflare"). "Test and save"
     writes, reads back and deletes a small test file, and only then makes R2 the destination.
   - **Google Drive**: "Connect Google Drive" opens Google's sign-in. Walnut asks only for
     `drive.file`, so it sees only the files it makes, all in one "Walnut Backup" folder.
   - **Amazon S3**: bucket, an optional region (empty: the SDK follows the bucket's own region), and the AWS credential chain, a profile, or keys.
2. That is all when "Encrypt backups" is off (the default): the first backup starts within a
   minute. With it on, the recovery key appears first (Show, Copy, Download); keep it outside
   this computer, and backups start once you say it is saved.
3. The first backup uploads everything; after that only changes upload. A first backup cut
   short (Walnut restarted, the connection dropped) keeps what it uploaded: the next run
   uploads only what is still missing.

Looking at another service in the pane never changes where backups go: a bucket is saved
by a passing "Test and save", Google Drive by a finished sign-in (or, when another service
is in use, by "Use Google Drive"). The service left behind is kept in
`backup.other_destinations`, so switching back needs no retyping. "Back up automatically"
saves the moment it is switched. Only the person at this computer can change where backups
go: a config write from an agent session that moves them (or the kept services) is refused.

## Encrypted or not

"Encrypt backups" in Settings, Backup (`backup.encrypt` in config.yaml) chooses the kind.

| | Off (the default) | On |
|---|---|---|
| What goes up | the files as they are, each object with a SHA-256 checksum bound to its name, so a changed or moved object is refused on restore | every object sealed with AES-256-GCM under a key made from the recovery key |
| What you keep | nothing | the recovery key: nobody can open the backups without it, Walnut included |
| Who can read them | anyone who can open the bucket or the Google account | only someone with the recovery key |
| Where at the destination | under `plain/` (on Google Drive, file names starting `plain/` in the "Walnut Backup" folder) | at the top (`walnut-backup.json`, `packs/`, `index/`, `snapshots/`) |

Both kinds can live at one destination, and switching never touches the other kind: backups
made before stay where they are, are listed beside the new ones (an "Encrypted" tag marks
those), and restore whichever is set now. "Latest" is the newest of both. Each kind keeps
its own history and prunes only its own objects. Without its recovery key on this computer,
the encrypted ones are listed only as "Encrypted backups are here too", with how to open them.

Not set (`backup.encrypt` absent, as on an install from before the switch existed), the kind
follows the setup: a recovery key saved before, or encrypted backups already at the
destination, keep it encrypted; otherwise it is unencrypted. The scheduler writes what it
found to config.yaml once, so later runs and the pane agree. The data folder includes
`auth.json` (the sign-ins Walnut holds), so with encryption off, use a bucket or a Google
account only you can open.

## What it costs and the limits

| Service | Free | Notes |
|---|---|---|
| Cloudflare R2 | 10 GB-month storage, 1 million writes and 10 million reads a month, no download (egress) fees | Turning R2 on in the Cloudflare dashboard asks for a payment method. Past the free tier: $0.015 per GB-month. |
| Google Drive | 15 GB per Google account, shared with Gmail and Photos | 750 GB of uploads a day per user. |
| Amazon S3 | none beyond the AWS free tier | Billed by AWS. |

## The format, and why

A real data home measured about 7.3 GB in 22,600 files (notes with videos, a 1 GB usage
database, plugin data); another, 10 GB in 33,500 files. A zip of all of it every day would
upload the whole home every day and keep tens of GB of history, past every free tier, and a
zip cut short by a restart is lost whole. So the backup is incremental and deduplicated,
in either kind:

- Files are cut into content-defined chunks (about 512 KB on average; files up to 1 MB are
  one chunk). A chunk is stored once, whatever file or backup it is in, so an unchanged file
  costs nothing and a changed one costs only its changed chunks.
- Chunks are compressed (except formats that already are: video, images, archives), sealed
  (encrypted with AES-256-GCM, or with a SHA-256 checksum when encryption is off), and
  packed about 16 MB to an object, so a destination holds a few hundred objects, not tens
  of thousands.
- An index says which chunk is in which pack. A run writes one for every ~256 MB it
  uploads, so a run cut short leaves its packs findable for the next.
- Each backup (a snapshot) lists its files and their chunks, sealed the same way. A
  snapshot is written last: one that exists names only chunks already uploaded.
- SQLite databases are copied with SQLite's own backup API first, so a database being
  written is never backed up torn.

Layout at the destination, for each kind: `walnut-backup.json` (the format version, a random
repository id, a key check or `"encryption": "none"`, and the writer machine's random id; no
names, no paths), `packs/`, `index/`, `snapshots/`. The unencrypted kind's are under `plain/`.

## History kept

Every backup of the last 24 hours (at most 48), the newest 3, the newest of each of the last
7 days, and the newest of each of the last 4 weeks. So pressing "Back up now" a few times
never pushes out the morning's backup. Older backups are forgotten and their space given back (a pack still mostly
needed is kept; one mostly unneeded is repacked). A prune never runs when it could be
wrong: a backup it cannot read, the new backup not listed yet, or another machine now the
writer; and it never deletes a pack written in the last 6 hours.

## The recovery key

Only for encrypted backups ("Encrypt backups" on).

- Made on this computer the first time a destination with no backups is set up: 32 random
  bytes, shown as `WB1-` and then 53 letters and digits in groups of 5, the last one a check
  character.
  Typing mistakes between look-alike characters (O and 0, I and L and 1) are forgiven.
- Kept at `~/.open-walnut/local/backup/recovery-key` (mode 0600). `local/` never rides
  git sync. The key also rides inside the encrypted backup itself, so a home restored from
  a backup can keep backing up.
- Nobody can open the backups without it, Walnut included. Keep it in a password manager or
  print the downloaded kit.
- On a new computer, see "Restore on a new computer" below.

## One computer writes

Only one computer writes to a destination (its random machine id is in
`walnut-backup.json`), so two computers never prune each other's backups. Another computer
can list and restore. When a backup finds another writer (a restore on a new computer, say),
the pane says so at the next check, not when the schedule comes round: the scheduler runs at
once when the destination holds backups this machine does not write. "Back up this computer"
asks first, then moves the role and runs a backup within a minute; the other computer then
stops backing up there. A service chosen while Walnut runs backs up within a minute too
(the newest backup there may be older than the data).

## Restore

Settings, Backup, "Choose a backup": pick one, optionally a folder, Restore. It goes into a
new, empty folder (by default `open-walnut-restored-<date>` next to the data folder), never
over the data Walnut runs on. Every chunk is checked on the way back (the AES-GCM tag, then
its id) and every file's size; mtimes and executable bits come back. A restore under way can
be cancelled (`POST /api/backup/restore/cancel`, the person's step): it stops within a chunk
and removes the folder it was writing, which was new or empty when it began.

"Use this data" makes the restored folder the data folder, after a confirm. A running
Walnut cannot swap its own folder, so it writes a small request beside the data folder
(`~/.open-walnut.restore-switch.json`) and restarts when it can (the Mac app and installed
builds can; a source checkout says to quit and open it again). The page asks Walnut every 2
seconds while it restarts and loads again once the switch is done (after 20 seconds it also
offers Reload). The confirm says that settings go back to that backup's time too, like the
rest of the data. At the next start, before
anything reads the data folder (`src/commands/web.ts`, `core/backup/restore-switch.ts`),
the current folder is renamed to `.open-walnut-before-restore-<time>` (kept, never
deleted) and the restored folder into its place. A start that died between the two
renames finishes the switch; a rename that fails puts the old folder back and says why in
`~/.open-walnut.restore-switch-error.txt`. This machine's writer id moves with the switch,
so it stays the writer of its backups. "Advanced: switch it yourself in a terminal" shows the
same as one shell command, chained with `&&` so a failed step stops the rest.
After the switch the pane says it runs on the restored data, with "Keep it" and "Delete it"
for the folder set aside. "Delete it" asks first and removes only that folder: it must sit
beside the data folder, be named `<data folder>-before-restore-<time>` and not be a link
(`deletePreviousData` in `core/backup/restore-switch.ts`, route
`POST /api/backup/restore/use/delete-previous`, the person's step).
A service set up before and kept (`other_destinations`) can be restored from too: "From"
appears above the list.

## Restore on a new computer

In the app:

1. Install Walnut and open it (a new, empty data folder is fine).
2. Settings, Backup, "Where backups go": choose the same service. For R2 or S3, the same
   bucket and keys. For Google Drive, "Connect Google Drive" with the same Google account;
   the build's own Google client sees the "Walnut Backup" folder it made before (a client of
   your own sees only what that same client made, so use that one again).
3. Backups made by an encrypted setup: turn on "Encrypt backups" and enter the recovery key
   you saved; Walnut checks it against the backups before keeping it. Unencrypted backups
   need nothing more.
4. "Choose a backup", pick one (the newest is first), Restore, then "Use this data" (above).
   Walnut then says another computer writes these backups: "Back up this computer" moves the
   role here.

From a terminal, also with no Walnut data yet:

```bash
# Cloudflare R2 (S3 the same with --type s3 --bucket <bucket> [--profile <p>])
open-walnut backup list --type r2 --account-id <id> --bucket <bucket> --access-key-id <key>
open-walnut backup restore --type r2 --account-id <id> --bucket <bucket> --access-key-id <key>
# Google Drive: prints Google's sign-in link the first time, then lists or restores
open-walnut backup list --type gdrive
open-walnut backup restore --type gdrive
```

On Google Drive, a computer that never connected it signs in from the terminal: the command
prints a link, the browser goes back to the command when access is allowed, and the
connection is kept for the app too. With the browser on another computer (over SSH), paste
the address the browser ends on into the terminal instead.

Add `--key <recovery key>` for encrypted backups. The restore lands in
`~/open-walnut-restored-<date>` (or `--to <folder>`, `--at <backup id>` from the list), and
the command prints the one line that makes it the live data. `--encrypt` / `--no-encrypt`
choose the kind for `run`.

`WALNUT_BACKUP_SECRET_ACCESS_KEY` and `WALNUT_BACKUP_RECOVERY_KEY` keep the secrets out of
the shell history. The `restore-backup` skill walks a Claude Code session through it.

## Restore drill

A backup is otherwise only proven when someone restores it. The restore drill proves it on an
ordinary day: `open-walnut backup drill` (`--snapshot <id>` for another backup than the
newest, `--key` for encrypted ones, `--json`, `--no-boot` to leave out the boot check), and once a week while the experiment "Weekly
restore drill" (`restore_drill`, off by default) is on. Code: `src/core/backup/restore-drill*.ts`.

The restored copy is as large as the backup, so the drill looks at the disk first: when the
backup's size plus 10 GB does not fit where its folder goes, it fetches nothing and says so (the
schedule tries again in a day). Once it holds the lock and has the room, the schedule writes its
record before the first byte is fetched, so a drill the server's stop cut short is also tried
again in a day, not at the next start; three cut short in a row are told to Walnut Health once
(a drill run from a terminal is not stopped by a restart of the server). "Every experiment
on" does not turn the weekly drill on: it downloads all of your data, so it keeps its own switch
(`keepsOwnSwitch` in `src/core/experimental.ts`; the standby copy is the other one).

It restores the backup into a new folder under the OS temp dir (never the data folder), then:

- **files**: the restored tree against the backup's own list: the same files, each of its
  size, and each file's chunks hash back to the ids the backup recorded;
- **databases**: every database passes `PRAGMA integrity_check` (on a worker thread). The
  format records no row counts at backup time, so rows are counted and reported, not compared;
- **must-have**: every file of the data folder that the data-location manifest
  (`src/core/home-manifest/`) classes leader-data and the backup's rules take, and that existed
  6 hours before the backup finished, must be in it. This catches a backup whose own list
  missed something, which the files check cannot. A missing file whose inode changed since
  then (a rename keeps the birth time: an old note moved to a new folder) counts as changed,
  not missing; backups another computer writes are not compared with this data folder;
- **read-back**: the newest task of `tasks/tasks.sqlite` and a note are read from the
  restored folder;
- **boot**: once the checks above ran, the restored copy is started once as a real server in
  the boot policy's trial column (the one the leader switch's trial uses, `src/core/boot-policy.ts`):
  HTTP, the databases and their migrations, nothing else; no plugin, session daemon, schedule,
  watcher or git job, and every outward door refuses for the life of the process. It runs as a
  child process on loopback, on a port the OS picks (never 3456), with its own instance lock (the
  copy's `server.lock.json`), and with its user home, XDG folders, temp dir, session daemon folder
  and task folders all inside the drill's folder; strings in the copy's `config.yaml` that name the
  live data folder are pointed at the copy first, as a restore in place would have them. Through
  it the drill reads back the same task and a note as the files hold them (the read-back the
  switch's trial shares, `src/core/trial-start/read-back.ts`), stops it (SIGTERM, then SIGKILL after
  15 s) and runs `integrity_check` on every database again after its migrations. The check keeps
  how long each step took (`timings`: start, the server's own boot, read-back, stop, total). A
  copy that does not boot within 3 minutes, exits during its start, or comes up as anything but
  the drill's trial fails it, with the last lines of the server's log; it is "not run" (`ok: null`)
  only when there was no copy to boot (the restore failed) or `--no-boot` asked so. A drill killed
  while its server runs leaves no server: the server stops once its parent is gone. The server it
  starts is the program on disk at that moment (the checkout's `src/cli.ts`, the installed bundle, or
  the compiled file itself): after an update installed in place and not yet restarted into, that is
  the new version, which is also the one the next start would run.

  Nothing but the drill enters the trial (`src/core/trial-start/ticket.ts`): the server must be
  started with the hidden `walnut web --_trial-start` flag (argv, which no child inherits), find in
  the home it boots on a ticket the drill wrote a moment before (`local/trial-start.json`, used up as
  it is read) naming the drill's pid as its parent and a nonce its environment carries, and that
  home must be a drill's copy (`<tmp>/walnut-restore-drill-XXXXXX/home`), never the user's data
  folder (`~/.open-walnut`, or the data folder the drill names in the ticket), and the ephemeral
  identity (`--_ephemeral-child`, which keeps it off the write permission, a standby and backups)
  must come with it. Without the flag none of this is read, so an environment variable alone never moves a
  server into the trial; with it, any part missing refuses the start, so a drill's server never
  boots as a normal one on a restored copy.

It also lists what backups leave out by design, read from the code: the leader-data places the
backup's rules skip (everything under `cache/`, the applied-ops ledger included, `browser/`,
`tmp/` recordings and file history, `.git`, `config.yaml.history`), the folders kept on the
machine that collected them (`health/`, `places/`), and every leader-data place outside the
data folder (the password vault, the fleet secrets). The list is reported, nothing changes.

The drill only reads: the destination is opened through a store that refuses every write and
the data folder is only walked (the boot writes only into the drill's folder). Like a restore, the command and the schedule hold the backup
lock (`local/backup/run.lock`, a machine file no backup takes) so a backup's prune never deletes
packs the drill reads; a drill asked while a backup runs in another process is refused, and the
schedule tries at its next check. On Google Drive, reading may refresh the stored sign-in, as
listing backups in Settings does. The folder is removed at the end, also after a failure; one a
killed drill left behind is removed when the server starts and by the next drill. The result (when,
which backup, each check, the not-in-backups list, how long) is kept in
`local/restore-drill.json` and returned by `GET /api/backup/status` as `restoreDrill`. A
scheduled drill that fails is a Walnut Health notice, retired by the next one that passes (from
the command too); a drill that could not run at all (the destination did not answer, no key) is
tried again after a day instead of a week.

## Earlier versions of config.yaml

Apart from the backup, Walnut keeps copies of `config.yaml` on this computer, so a bad
write never leaves only a bad file behind (`src/core/config-history.ts`):

- `config.yaml.bak`: the last write. Walnut puts it back by itself when `config.yaml` goes
  missing or empty.
- `config.yaml.history/`: dated copies, named `config-<UTC time>-<hash>.yaml`. A copy is
  saved after every write that changes the file (and an outside edit Walnut accepts); the
  first write after an upgrade also saves what the file held before. Walnut keeps the 10
  newest, plus the oldest and the newest of each of the last 7 days (UTC) that have one, so
  the version a day started from outlasts any number of writes later that day.

To go back to an earlier version, copy the file you want over `config.yaml`; a running
Walnut takes it up like any edit of the file. Both copies hold the same keys as `config.yaml`: owner only, never
synced (the data repo's `/config.yaml.*` rule covers the folder), and left out of the
encrypted backup, which already has `config.yaml` and its own history of it.

## The older S3 copy

Installs that set up the earlier S3 backup (`backup.bucket` in config.yaml) keep it,
unchanged: an unencrypted mirror of the files, with S3 versioning as its history. The pane
shows that form and a "Switch to encrypted" button. An encrypted setup never writes
`backup.bucket` (config writes drop it beside `backup.destination`), so an older Walnut
reading the config sees no backup configured and uploads nothing.

## Walnut's own Google client

For "Connect Google Drive" to be one click, the build carries Walnut's own OAuth client
(`BUILTIN_GOOGLE_CLIENT` in `src/core/backup/gdrive-oauth.ts`; `WALNUT_GDRIVE_CLIENT_ID` and
`WALNUT_GDRIVE_CLIENT_SECRET` override it). Without one, the pane walks the user through
making their own client and pasting its ID and secret. To make Walnut's:

1. Google Cloud console: create a project, enable the Google Drive API.
2. Google Auth Platform, Get started: app name, support email, Audience External.
3. Audience: Publish app. In testing mode Google ends every sign-in after 7 days. `drive.file`
   is a non-sensitive scope, so publishing needs no Google verification (only the app's name
   and logo on the consent screen need brand verification).
4. Clients, Create client, Desktop app. A desktop client's secret is not secret by Google's
   rules (it ships inside the app); the sign-in is protected by PKCE and a loopback redirect
   to `http://127.0.0.1:<random port>`.

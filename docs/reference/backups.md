# Backups

Walnut backs up its data folder (`~/.open-walnut`: notes, tasks, passwords, sign-ins,
settings) to a place the user already has: Cloudflare R2, Google Drive, or an Amazon S3
bucket (or any S3-compatible service). Everything is encrypted on the computer before it
is uploaded, and Settings, Backup can list the backups and restore any of them into a new
folder.

Code: `src/core/backup/` (engine), `src/web/routes/backup*.ts` (routes),
`web/src/components/settings/sections/BackupSection.tsx` and `sections/backup/` (the pane),
`src/commands/backup.ts` (`open-walnut backup run | list | restore`).

## Setting it up

1. Settings, Backup, "Where backups go": pick a service.
   - **Cloudflare R2**: Account ID, bucket, and an R2 API token's access key ID and secret
     (the steps are in the pane under "Where to find these in Cloudflare"). "Test and save"
     writes, reads back and deletes a small test file, and only then makes R2 the destination.
   - **Google Drive**: "Connect Google Drive" opens Google's sign-in. Walnut asks only for
     `drive.file`, so it sees only the files it makes, all in one "Walnut Backup" folder.
   - **Amazon S3**: bucket, region, and the AWS credential chain, a profile, or keys.
2. The recovery key appears (Show, Copy, Download). Keep it outside this computer.
3. "Back up automatically" turns on once there is a destination and a key. The first backup
   uploads everything; after that only changes upload.

Looking at another service in the pane never changes where backups go: a bucket is saved
by a passing "Test and save", Google Drive by a finished sign-in (or, when another service
is in use, by "Use Google Drive"). The service left behind is kept in
`backup.other_destinations`, so switching back needs no retyping. "Back up automatically"
saves the moment it is switched. Only the person at this computer can change where backups
go: a config write from an agent session that moves them (or the kept services) is refused.

## What it costs and the limits

| Service | Free | Notes |
|---|---|---|
| Cloudflare R2 | 10 GB-month storage, 1 million writes and 10 million reads a month, no download (egress) fees | Turning R2 on in the Cloudflare dashboard asks for a payment method. Past the free tier: $0.015 per GB-month. |
| Google Drive | 15 GB per Google account, shared with Gmail and Photos | 750 GB of uploads a day per user. |
| Amazon S3 | none beyond the AWS free tier | Billed by AWS. |

## The format, and why

A real data home measured about 7.3 GB in 22,600 files (notes with videos, a 1 GB usage
database, plugin data). A zip of all of it every day would upload 7.3 GB a day and keep
tens of GB of history, past every free tier. So the backup is incremental and deduplicated:

- Files are cut into content-defined chunks (about 512 KB on average; files up to 1 MB are
  one chunk). A chunk is stored once, whatever file or backup it is in, so an unchanged file
  costs nothing and a changed one costs only its changed chunks.
- Chunks are compressed (except formats that already are: video, images, archives), sealed
  with AES-256-GCM, and packed about 16 MB to an object, so a destination holds a few
  hundred objects, not tens of thousands.
- Each backup (a snapshot) lists its files and their chunks, also encrypted. A snapshot is
  written last: one that exists names only chunks already uploaded.
- SQLite databases are copied with SQLite's own backup API first, so a database being
  written is never backed up torn.

Layout at the destination: `walnut-backup.json` (the format version, a random repository
id, a key check, and the writer machine's random id; no names, no paths), `packs/`,
`index/`, `snapshots/`.

## History kept

Every backup of the last 24 hours (at most 48), the newest 3, the newest of each of the last
7 days, and the newest of each of the last 4 weeks. So pressing "Back up now" a few times
never pushes out the morning's backup. Older backups are forgotten and their space given back (a pack still mostly
needed is kept; one mostly unneeded is repacked). A prune never runs when it could be
wrong: a backup it cannot read, the new backup not listed yet, or another machine now the
writer; and it never deletes a pack written in the last 6 hours.

## The recovery key

- Made on this computer the first time a destination with no backups is set up: 32 random
  bytes, shown as `WB1-` and then 53 letters and digits in groups of 5, the last one a check
  character.
  Typing mistakes between look-alike characters (O and 0, I and L and 1) are forgiven.
- Kept at `~/.open-walnut/local/backup/recovery-key` (mode 0600). `local/` never rides
  git sync. The key also rides inside the encrypted backup itself, so a home restored from
  a backup can keep backing up.
- Nobody can open the backups without it, Walnut included. Keep it in a password manager or
  print the downloaded kit.
- On a new computer: install Walnut, open Settings, Backup, choose the same destination
  (for Google Drive, the same Google account and client). Walnut finds backups there and
  asks for the key; it checks the key against the backups before keeping it.

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
its id) and every file's size; mtimes and executable bits come back.

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

From a terminal, also on a new computer with no Walnut data yet:

```bash
open-walnut backup list --type r2 --account-id <id> --bucket <bucket> --access-key-id <key> --key <recovery key>
open-walnut backup restore --type r2 --account-id <id> --bucket <bucket> --access-key-id <key> --key <recovery key>
```

The restore lands in `~/open-walnut-restored-<date>` (or `--to <folder>`, `--at <backup id>`
from the list), and the command prints the one line that makes it the live data.

`WALNUT_BACKUP_SECRET_ACCESS_KEY` and `WALNUT_BACKUP_RECOVERY_KEY` keep the secrets out of
the shell history. The `restore-backup` skill walks a Claude Code session through it.

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

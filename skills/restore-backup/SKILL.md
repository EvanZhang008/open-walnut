---
name: restore-backup
description: Hands-on disaster-recovery agent for Open Walnut S3 backups. Paste into your OWN Claude Code session — it finds your backup in S3, restores it to a fresh folder, verifies every file and database, and helps you adopt it as the live data folder. Works on a brand-new machine with nothing installed. Use when a user lost their Walnut data, got a new machine, or wants to verify their backups actually restore.
---

# Restore Open Walnut from an S3 backup

**Goal:** get the user's Walnut data back, verified, with zero chance of making things worse.
You are doing the restore *for* the user. Be **proactive**: run the commands yourself, verify
integrity yourself, and only ask when the answer is genuinely theirs (which bucket, which
restore point, whether to adopt).

## Two safety rules (never break these)

1. **Restore NEVER overwrites live data.** Always download into a fresh folder first, verify
   it, and only then (with the user's explicit go-ahead) swap it into place. If
   `~/.open-walnut` still exists, treat it as precious even if the user says it's broken:
   rename it aside, never delete it.
2. **Never delete anything in the bucket.** The bucket is the last copy. Read-only access is
   all a restore needs.

## What's in the bucket (so you can reason about it)

Under the configured prefix (default `walnut`):

- `<prefix>/backup-manifest.json` — the file list of the last complete backup. Written LAST,
  so if it exists, that backup finished. With bucket versioning on, each old version of this
  one key is an earlier restore point.
- `<prefix>/data/<relative path>` — every backed-up file, mirroring the data folder layout.
- `<prefix>/data/.sqlite-snapshots/<relative path>` — safe online snapshots of the SQLite
  databases (sessions, tasks, usage). The restore command puts these back at their real paths
  automatically. Search/index databases are absent on purpose: Walnut rebuilds them.

Backed up: tasks, notes and attachments, chat and session history, memory, config, and
credentials (`auth.json` — treat the restored folder as secret). Not backed up: caches, temp
files, search indexes, and the internal git-sync history.

## Step 1 — Get a working `open-walnut` CLI

The restore tool ships with Walnut itself.

```bash
open-walnut --version 2>/dev/null && echo CLI-OK
```

If that fails (fresh machine), clone and build:

```bash
git clone https://github.com/EvanZhang008/open-walnut.git && cd open-walnut
npm install && npm run build
alias open-walnut='node dist/cli.js'   # or use node dist/cli.js directly
```

Node 22+ is required. You do NOT need a running server or any Walnut config to restore —
the CLI takes everything as flags.

## Step 2 — Find the backup

You need three things: **bucket**, **region**, and **credentials that can read it**.

- If `~/.open-walnut/config.yaml` survives, read its `backup:` section — bucket, region,
  prefix, and auth method are all there.
- Otherwise ask the user for the bucket name, and check what credentials exist:
  `aws sts get-caller-identity` (default chain) or list profiles with
  `grep -E '^\[' ~/.aws/config ~/.aws/credentials`.

Then list restore points:

```bash
open-walnut backup list --bucket <bucket> --region <region> [--profile <name>]
```

Each line is a complete backup with a timestamp and a `versionId`. If it prints "versioning
is off", only the latest is available. If the list is empty, check the prefix
(`--prefix <name>`, default `walnut`) — the user may have used one prefix per machine.

Show the user the list and let them pick (default: latest).

## Step 3 — Restore to a fresh folder

```bash
open-walnut backup restore --bucket <bucket> --region <region> [--profile <name>] \
  [--at <versionId>] --to ~/walnut-restored
```

- Refuses a non-empty target (that's correct behavior, not an error — pick a fresh path).
- Downloads every manifest file, checks each file's size against the manifest, and fails
  loudly on any mismatch. A partial restore is reported as incomplete, never as success.

## Step 4 — Verify before adopting (a backup you haven't verified isn't a backup)

```bash
# File count matches what the restore reported
find ~/walnut-restored -type f | wc -l

# Databases open and pass integrity check
for db in ~/walnut-restored/sessions.sqlite ~/walnut-restored/tasks/tasks.sqlite ~/walnut-restored/usage.sqlite; do
  [ -f "$db" ] && echo "$db => $(sqlite3 "$db" 'PRAGMA integrity_check;')"
done

# The user's actual content is there
ls ~/walnut-restored/notes ~/walnut-restored/config.yaml ~/walnut-restored/auth.json
```

Show the user what you found (file count, backup date, a couple of recognizable note names)
so THEY can confirm it's their data.

## Step 5 — Adopt it (only with the user's explicit OK)

```bash
# Stop the Walnut server first if one is running on this machine.
[ -d ~/.open-walnut ] && mv ~/.open-walnut ~/.open-walnut.pre-restore-$(date +%Y%m%d-%H%M%S)
mv ~/walnut-restored ~/.open-walnut
```

Start Walnut. Search indexes rebuild on first use; a first slow search is normal. The
pre-restore folder is the rollback: keep it until the user confirms everything works.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `No backups found` | Wrong prefix, or wrong bucket | Try the other prefix names; `aws s3 ls s3://<bucket>/` to see what's there |
| `AccessDenied` / `ExpiredToken` | Credentials can't read the bucket, or SSO expired | Refresh (`aws sso login`), or use `--profile` with one that can |
| Restore refuses the target | Target folder is not empty | Point `--to` at a fresh path — never force over real data |
| `size mismatch` on a file | Interrupted download | Re-run the restore to a fresh folder; if it repeats on the same file, tell the user which file and continue with the rest only if they say so |
| Only one restore point listed | Bucket versioning is off | Latest is still fully restorable; suggest enabling versioning in Settings afterwards |

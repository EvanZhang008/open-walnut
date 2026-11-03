# One daemon, several Walnuts

A host runs one session daemon per OS account. When two Walnuts reach the same account
(your own Walnut and a colleague's, or a Mac and an older install on the same machine),
they share that daemon. This page says what each Walnut keeps to itself there, how a
Walnut decides whether to replace the daemon with its own build, and what is shared
because the account is.

## What each Walnut keeps to itself

A Walnut is named by its data dir (`home`). Every setting a server pushes names it, and
the daemon keeps one copy per Walnut (`src/providers/walnut-scope-core.ts`): the trigger
set and each trigger's memory, the hook rules, the cloud bridge link, turn snapshot
settings, workspace providers, the offline copy and journal, the leader record, the host
replica and the plugin jobs. A Walnut's sockets hear only their own Walnut's fires and
events, and a command that names another Walnut than its socket speaks for is refused.

A server older than this split pushes with no `home`. Its settings go to the unnamed
scope, which keeps the files an older daemon used, so it works as before beside a named
Walnut. The guard is `tests/providers/daemon-walnut-scope-ratchet.test.ts`: every push and
every file the daemon keeps is classified there.

## When a Walnut replaces the daemon

A daemon's version is a hash of its sources, so two builds have no order. Before this
rule, each Walnut replaced the running daemon with its own build whenever they differed,
and two Walnuts of different builds swapped it back and forth on every connect, which
cut the other's link each time.

The daemon writes `daemon.serves.json` beside `daemon.version` (`served-walnuts-core.ts`):
its version, its capabilities, and when each Walnut last pushed to it, by key (`-` for a
server that names no home). The hello carries the same record. A server that finds
another build running (`src/providers/daemon-shared.ts`):

- keeps it when another Walnut used it in the last 3 days and it has every capability
  this server's build of the daemon has, or when it has a capability this build lacks
  (neither build covers the other, so replacing would only start a swap);
- replaces it otherwise, as before: a daemon that lacks a capability is still updated,
  so a new feature works, and a host only this Walnut uses still runs exactly its build.
- stops replacing for a day once it replaced a shared daemon and another build came back
  (something on that host keeps putting its own build back).

Replacing never ends a session: the new daemon adopts every running CLI, and the update
still waits for open ACP turns, `host_exec` runs and a held gate. The same check runs on
every update path: SSH hosts, this Mac's own daemon, and machines on the host network
(where `host_daemon_update` still updates on request). `WALNUT_DAEMON_KEEP_SHARED=0`
turns the rule off for one server. The cloud companion's tunnel daemon is exempt
(`soleManager` in `local-daemon.ts`): its record names the Mac, whose pushes come
through the companion, so a companion on a new build always replaces it.

The trade: on a shared host, a newer build that only fixes the daemon (no new capability)
does not replace the build already running there. It arrives once the other Walnut has
not used the daemon for 3 days, or with the next build that adds a capability.

A server older than this rule has no such check and still replaces the daemon whenever
it would have before (for example an older Walnut on the same Mac, when it restarts its
own daemon). The swapping ends once that Walnut is updated.

Guard: `tests/providers/daemon-shared-tug.test.ts` (two builds reconnecting 20 times, the
daemon is swapped at most once) and `tests/providers/daemon-served-walnuts-twins-e2e.test.ts`
(both daemon builds write and read the record).

## What the account shares

Some things belong to the OS account, not to a Walnut, and a shared daemon cannot keep
them apart:

- **Files.** `fs.read`, `fs.write`, the file tree and git commands take a path, and the
  daemon runs them with the account's own permissions. Either Walnut can read or write
  any file the account can, the other Walnut's data dir included. Two people who must
  not see each other's files need two OS accounts (each with its own daemon), not one.
- **The engines' own stores.** `~/.claude` (skills, transcripts, settings) and other
  engine homes are the account's, read by every session there.
- **The host network identity and the secrets store** are one per account; each secret
  records the Walnut that wrote it.

## After a downgrade

A daemon older than the per-Walnut split keeps one set of everything. When a host goes
back to such a build, every Walnut's push lands in that one set again, as it did before
the split. Each trigger's memory (what it already reported) is also written where an
older daemon reads it, from the trigger's first check, so the older daemon does not
report the same items again. Moving forward again, the newer of the two copies wins.

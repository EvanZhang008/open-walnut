/**
 * Canonical list of WebSocket commands a remote daemon MUST implement to be
 * protocol-compatible with the current server. The daemon returns this list
 * from `hello`; the server checks it after connecting. Any missing capability
 * forces a redeploy.
 *
 * This is the final safety net under version-hash checks: even if the version
 * string somehow matches but the binary is stale/corrupted/hand-swapped, a
 * capability gap will catch it before the first broken `sendRaw` hangs a
 * permission prompt for 30 minutes.
 *
 * Hand-maintained (not derived from the daemon's switch statement) because
 * daemon-standalone is a bun-compiled binary and daemon-source is an embedded
 * string template evaluated on the remote host — neither can introspect its
 * own switch at distribution time.
 *
 * When you add a new `case 'foo':` to daemon-standalone.ts / daemon-source.ts,
 * add 'foo' here too. Forgetting to add it here only costs you one extra
 * redeploy, not a silent hang.
 */
export const REQUIRED_DAEMON_CAPABILITIES = [
  'start',
  'attach',
  'send',
  'sendRaw',
  'stop',
  'status',
  'getState',
  'rename',
  'read-history',
  'subscribe-agent',
  'unsubscribe-agent',
  'write-inbox',
  'fs.read',
  'fs.write',
  'fs.mkdir',
  'fs.ls',
  'fs.find',
  'fs.stat',
  'fs.readRange',
  'git.diff',
  'list',
  'ping',
  'hello',
  'setMode',
  'appendUserMarker',
  'bridge.configure',
  'bridgeResume',
  'stt',
  // ACP worker command family (in-process ACP host worker per session). Local
  // daemons only: the binary, or the source twin with its acp-daemon-core.cjs
  // sidecar. A daemon without the sidecar (remote source deploys) answers these
  // with a structured acp_unsupported error.
  'acpStart',
  'acpSend',
  'acpCancel',
  'acpRespond',
  'acpSetConfigOption',
  'acpState',
  'acpNewSession',
  'acpStop',
  'acpSubscribe',
] as const

/**
 * Full capability list a CURRENT daemon advertises on `hello`. Superset of
 * REQUIRED_DAEMON_CAPABILITIES: optional capabilities live ONLY here so that
 * old daemons (which don't advertise them) stay usable — the server gates the
 * corresponding feature on presence instead of forcing a redeploy.
 *
 * 'snapshot-v1' — C1 session-snapshot push/pull (docs/plan/
 * session-snapshot-source-of-truth.md §4). Walnut treats hosts without it as
 * legacy: no snapshot flow, old status writers stay authoritative. Do NOT
 * move it into REQUIRED until the C4 soak completes.
 *
 * 'image.save' — narrow bridge-safe image save (phone → cloud → daemon).
 * Optional: a pre-image.save daemon answers with an unknown-command error,
 * which the cloud route maps to 400 images_need_daemon_upgrade (self-heals
 * on the next Mac reconnect via the normal auto-deploy).
 *
 * 'session.launch' — narrow bridge launch relay (phone → cloud → daemon →
 * connected walnut server, which runs the full quick-start chain). Optional:
 * a pre-session.launch daemon answers with an unknown-command error, which
 * the cloud route maps to 400 session_launch_needs_upgrade (self-heals on
 * the next primary reconnect via the normal auto-deploy).
 *
 * 'session.control' — narrow bridge control relay (model/effort/fork/
 * model-options; same forward-to-walnut-server shape as session.launch).
 * Optional: a pre-session.control daemon answers with an unknown-command
 * error, which the cloud route maps to 400 session_control_needs_upgrade
 * (self-heals on the next primary reconnect via the normal auto-deploy).
 *
 * 'mobile-event' — reverse relay for the mobile events feed: the walnut
 * server pushes slim task/session frames DOWN to the daemon, which forwards
 * them over the bridge to the cloud box (events-v1 → phones). Optional: the
 * feed checks hasCapability before pushing, so an old daemon just means the
 * cloud feed degrades to snapshot + heartbeats until the next auto-deploy.
 *
 * 'agent-gateway' — on-host unix-socket gateway for the `walnut` peer-session
 * CLI (daemon relays `gateway-request` events UP; the server answers with
 * the `gateway-result` command). Optional: on an old daemon `walnut` simply
 * exits 6 (socket absent) until the next auto-deploy upgrades it.
 *
 * 'hooks-v1' — declarative daemon-hook rules (hooks.configure command). The
 * server compiles ~/.open-walnut/hooks/*.yaml (runtime:daemon) into a rules
 * JSON and pushes it at connect + on change; the daemon evaluates the rules
 * at its intercept points (cron.create/cron.created/cron.fire/session.reap).
 * Optional: an old daemon falls back to the WALNUT_ENFORCE_SESSION_CRON env
 * (set at spawn), which covers only the built-in cron policy.
 *
 * 'session.message' — narrow bridge message relay (phone → cloud → daemon →
 * connected walnut server, which enqueues into the DURABLE session message
 * queue — same store, delivery paths, and reconnect redelivery as web sends).
 * This is the asymmetry fix for the 2026-08-13 phone-send data-loss family:
 * the old direct marker+send/bridgeResume sequence had no queue, so a daemon
 * death between steps lost the message. Optional: on an old daemon the cloud
 * route falls back to the direct sequence (now marker-after-delivery).
 *
 * 'fs.readBounded' — narrow bridge-safe file read (path sandbox + 2MB cap,
 * both enforced HOST-SIDE by the daemon: traversal/absolute checks, realpath
 * secret-path denylist (~/.ssh, ~/.aws, key files, config.yaml, …), regular
 * files only). Lets the cloud replica serve GET /api/v1/file-content (JSON +
 * raw preview) for files on any bridged exec host — the phone HTML/text
 * preview path. NOT fs.read: a compromised cloud box must never get
 * arbitrary/unbounded reads on exec hosts. Optional: a pre-fs.readBounded
 * daemon answers with an unknown-command error, which the cloud route maps to
 * 501 not_supported_cloud (self-heals on the next primary reconnect via the
 * normal auto-deploy).
 *
 * 'changes-v1' — host-local session-changes compute (changes.compute /
 * changes.file). The daemon parses the session's JSONLs + reads file contents
 * ON ITS OWN HOST and returns a light list / one file's diff — the design-
 * principle path (host-local work belongs to the daemon; only small results
 * cross the tunnel). Binary daemons bundle the pipeline; source-deployed
 * daemons require() a sidecar (changes-core.cjs, shipped by deploySource) and
 * advertise this capability only when that load succeeds — otherwise the
 * server uses its reader-based fallback compute (old daemons likewise).
 *
 * 'rewind-probe-v1' — host-local transcript rewind probe
 * (transcript.rewindProbe). The daemon streams the session's OWN JSONL and
 * answers rewind's three questions from it: is this uuid on the chain the CLI
 * would resume, what is the last tree line right now (the cut anchor), and which
 * lines are dead for display. Only the small answer crosses the tunnel. Without
 * it the server shuttles the whole transcript through DaemonFileReader, which
 * REFUSES anything past its byte ceiling — so on a long transcript rewind used
 * to fail with the raw limit error and a rewound session's history rendered
 * unfiltered. Binary daemons bundle the probe; source-deployed daemons require()
 * a sidecar (transcript-rewind-core.cjs) and advertise this only when that load
 * succeeds. Optional: without it the server falls back to the whole-file read
 * (and says "the host needs the current daemon" when that read is refused).
 *
 * 'external-describe-v1' — sessions.describeExternal: re-read specific
 * transcripts by session id regardless of age. The scan is windowed by mtime,
 * so an import that got a placeholder title (fallback name or a compaction
 * summary) and whose file then aged out of the window would keep it forever;
 * the server asks for exactly those ids and retitles from the answer. Optional:
 * without it only sessions still inside the scan window are retitled.
 *
 * 'external-scan-v1' — host-local discovery of sessions started OUTSIDE
 * Walnut (sessions.discoverExternal). The daemon walks its own
 * ~/.claude/projects + ~/.codex/sessions, classifies each transcript by its
 * recorded entrypoint/originator, and returns a SMALL descriptor list — the
 * host has thousands of transcript files, so neither the walk nor the parse
 * may happen server-side. Binary daemons bundle the scanner; source-deployed
 * daemons require() a sidecar (external-scan-core.cjs) and advertise this only
 * when that load succeeds. Optional: a host without it simply contributes no
 * external sessions (the importer skips it on capability) until the next
 * auto-deploy.
 *
 * 'path-resolve-v1' — host-local layered path resolution (fs.resolvePath). The
 * daemon turns "whatever the model wrote" into a real path using its OWN files:
 * the session transcript (paths the CLI already opened), the ancestor walk, the
 * git index (--recurse-submodules, so any depth and any submodule), and a pruned
 * find. One RPC replaces the server's old ~2-stats-per-ancestor-level walk, which
 * routinely spent its whole time budget on round trips and then handed back a
 * path that did not exist (the "cwd is A/, ref is 1/2/3, file is at A/B/C/1/2/3"
 * failure). Binary daemons bundle the resolver; source-deployed daemons require()
 * a sidecar (path-resolve-core.cjs) and advertise this only when that load
 * succeeds. Optional: without it the server uses its own RPC-based walk.
 *
 * 'fs-mutate-v1' — host-local file MUTATION for the session Files panel
 * (fs.rename / fs.rm / fs.copy, plus the `exclusive` flags on fs.mkdir and
 * fs.write). Each command runs the same input floor host-side before touching
 * the disk (absolute path, no '.'/'..' segment, never '/' or HOME, at least two
 * segments) and refuses to clobber an existing target, so a rename can never
 * silently delete a file and a delete can never walk off into a system root.
 * NOT sidecar-gated: both twins implement it inline over fs.promises, so a
 * current daemon of either flavor can always answer. Deliberately NOT on the
 * bridge allowlist either — a compromised cloud box must never mutate exec-host
 * files. Optional: without it the route answers 501 daemon_needs_upgrade, which
 * self-heals on the next auto-deploy.
 *
 * 'fs-write-atomic-v1' — fs.write learns `~` expansion, an `atomic` flag (write a
 * temp file in the same directory, then rename it over the target, preserving the
 * old file's mode), an `expectSha256` precondition (the sha256 the caller read, or
 * the literal 'absent' for "must not exist yet") and a `sha256` echo of the bytes
 * written. Why: the server edits engine config files such as ~/.claude/settings.json
 * that RUNNING CLIs watch and rewrite themselves — a plain writeFile is observable
 * half-done, so the watcher reads it as invalid JSON, and an unconditional write
 * clobbers the edit that CLI just made. The rename makes the swap atomic for the
 * watcher; the precondition turns a concurrent edit into a refusal
 * ('fs.write refused: file changed since it was read (EMODIFIED)') instead of data
 * loss, and the echoed sha256 lets a caller chain a second conditional write with no
 * re-read. NOT sidecar-gated: both twins implement it inline over fs.promises +
 * crypto, so a current daemon of either flavor can always answer. Deliberately NOT
 * on the bridge allowlist either — fs.write has never been reachable from a
 * compromised cloud box and this does not change that. Optional: without it the
 * engine-settings route answers 501 daemon_needs_upgrade, which self-heals on the
 * next auto-deploy.
 *
 * 'git-exclude-v1' — git.ensureExcluded {cwd, path}: when a file Walnut just created
 * inside a checkout (a project's .claude/settings.local.json) is not already ignored,
 * append it to .git/info/exclude, the per-repo ignore list that is never committed.
 * Why: Claude Code keeps that file out of git with a rule in ~/.config/git/ignore,
 * which git reads only while core.excludesFile is unset; a user who points that at
 * their own file (common) has the rule silently disabled and the local settings show
 * up untracked in every repo. Answers 'already' | 'added' | 'not-a-repo'; never
 * touches a tracked file or any .gitignore. Same bridge rule as the file-history
 * family: NOT reachable from the cloud box. Optional: without it the write still
 * lands and the response says gitExclude 'unavailable'.
 *
 * 'grep-v1' — host-local symbol search (fs.grep), backing "find references" in
 * the Files viewer. The daemon runs `git grep` (or a pruned `grep -r` outside a
 * repo) next to the files and returns only the small match list, never the
 * searched bytes. NOT sidecar-gated: both twins implement it inline over
 * child_process, so a current daemon of either flavor can always answer.
 * Optional: without it the route answers 503 "daemon needs upgrade for
 * reference search" until the next auto-deploy.
 *
 * 'triggers-v1' — walnut-trigger: the daemon owns the clock and runs a routine's
 * `check` shell command on a cadence (triggers.configure / triggers.test /
 * triggers.run / triggers.ack, plus the trigger.fired / trigger.checked events).
 * A check reads that host's files and runs that host's tools, and it must keep
 * polling while the server restarts or the tunnel flaps, so neither the clock nor
 * the run may live on the server; only the fire (a few hundred bytes of JSON)
 * crosses the tunnel. Optional: without it the server answers 400 "upgrade the
 * daemon on <host> (it auto-deploys on the next send)" on trigger_create for that
 * host, and every other routine kind keeps working on the server's own timer.
 * Sidecar-gated in the source twin (trigger-check-core.cjs): the parse, dedup and
 * process runner can't be inlined into that template, so a source deploy without
 * the sidecar answers the four commands with "triggers unsupported" and never
 * advertises this.
 *
 * 'git-file-history-v1' — host-local git history for ONE file (git.fileLog /
 * git.fileShow), backing the History panel of the Files viewer. Same rule as
 * git.diff: git and the file must live on the same host, so the daemon runs the
 * two invocations and only the small commit list (or one version's text) crosses
 * the tunnel. NOT sidecar-gated: both twins implement it inline over
 * child_process. Deliberately NOT on the bridge allowlist either — it reads
 * arbitrary host paths. Optional: without it the History panel still shows
 * Walnut's own snapshots and reports git as unavailable
 * (reason 'daemon_needs_upgrade') until the next auto-deploy.
 */
export const ADVERTISED_DAEMON_CAPABILITIES = [
  ...REQUIRED_DAEMON_CAPABILITIES,
  'snapshot-v1',
  'snapshot-memory-v1',
  'cron-metadata-v1',
  'image.save',
  'session.launch',
  'cancel-pending-start-v1',
  'session.control',
  'mobile-event',
  'agent-gateway',
  // 'offline-host-v1' (docs/plan/daemon-first-hosts.md): the trusted server
  // pushes `host.slice` (its read copy for this host, which also tags the socket
  // with its data dir), and drains what the daemon did while it was away with
  // `offline.drain` / `offline.ack`. Gateway calls from a Walnut whose server is
  // not connected are answered from the copy (offline-host-core.ts) instead of
  // hub_unreachable, and a connected server of another Walnut never gets them.
  // Both twins implement it (the core is text-injected into the source twin), so
  // it is NOT sidecar-gated. Not bridge-reachable. Optional: without it the
  // server pushes nothing and the gateway answers as before.
  'offline-host-v1',
  'session.message',
  'hooks-v1',
  'changes-v1',
  'rewind-probe-v1',
  'external-scan-v1',
  'external-scan-filter-v1',
  'external-describe-v1',
  'path-resolve-v1',
  // 'vscode-v1' — host-local embedded VS Code (vscode.ensure / vscode.status):
  // the daemon installs/starts code-server bound to 127.0.0.1 and returns
  // {port, token}; the server tunnels the port and the web UI iframes it.
  // Sidecar-gated in the source twin (vscode-server-core.cjs). Optional:
  // without it the UI shows an upgrade hint and the vscode:// deep-link
  // button still works.
  'vscode-v1',
  'grep-v1',
  'triggers-v1',
  'git-file-history-v1',
  'fs-mutate-v1',
  'fs-write-atomic-v1',
  'git-exclude-v1',
  'fs.readBounded',
  // 'skill-sync-v2' — walnut-skill distribution (skills.sync command). The
  // server pushes the current walnut SKILL.md at connect; the daemon keeps
  // ONE canonical copy (~/.open-walnut/skills/walnut/SKILL.md) and symlinks
  // the engines' native skill folders at it (~/.claude/skills/walnut,
  // ~/.agents/skills/walnut — codex's documented user-level dir), marker-
  // guarded and production-dir only, so hand-started sessions on any host
  // know the `walnut` CLI exists. v2 also migrates the v1 layout (real file
  // in ~/.claude/skills, fenced ~/.codex/AGENTS.md section). Optional: an
  // old daemon keeps its previous copies until the next auto-deploy.
  'skill-sync-v2',
  // 'acpSteer' — mid-turn message injection into a live ACP turn (worker
  // 'steer' op → adapter `_session/steering` → codex `turn/steer`). Optional:
  // an old daemon answers unknown-command, and AcpSession.steer() degrades to
  // the queue-until-turn-end path (pre-steering behavior).
  'acpSteer',
  // 'send-markers-v1': send accepts markers and writes them after the body enters the pipe but before the newline; an old daemon ignores the field and keeps using the appendUserMarker RPC after delivery.
  'send-markers-v1',
  // 'agent-commands-v1' — unified agent.* command family (engine-routed aliases
  // over the legacy start/send/... and acp* families). Optional: without it the
  // server keeps speaking the legacy families directly.
  'agent-commands-v1',
  // 'preflight-v1': host.preflight answers what this host can run (is claude
  // installed, native or npm build, a working node for the npm build, a C
  // compiler, dtach), computed host-side with short timeouts. Both twins
  // implement it inline (host-runtime-core.ts, text-injected into the source
  // twin), so it is NOT sidecar-gated. Not bridge-reachable. Optional: without
  // it the host status simply carries no readiness field and shows no hint.
  'preflight-v1',
  // 'hostfix-v1': host.fix runs ONE named fix the preflight asked for
  // (install-claude-native, install-compiler under `sudo -n`, build-dtach),
  // idempotent and one at a time, never a free-form command. Both twins
  // implement it inline (host-fix-core.ts, text-injected into the source twin),
  // so it is NOT sidecar-gated. Not bridge-reachable. Optional: without it the
  // server never fixes anything and the readiness lines keep their commands.
  'hostfix-v1',
  // 'bridge-uplink-v1': the cloud bridge socket is paced (at most 1MB the
  // replica has not confirmed, via bridge-ping markers the replica echoes;
  // bridge-uplink-core.ts), frames over the peer's chunk size are split once
  // the replica opts in with `bridge.peer`, `mobile-event` acks say whether the
  // frame was queued and on which connection (connId), and the trusted
  // `bridge.status` command answers {connected, connId, queuedBytes}. Both twins
  // implement it (the core is text-injected into the source twin), so it is NOT
  // sidecar-gated. Optional: without it the server pushes every self-heal
  // projection as before (no unchanged-content skip).
  'bridge-uplink-v1',
  // 'orphan-stop-v1': `stop` accepts reason 'orphan' plus `expectPid` and
  // `home` (the asking Walnut's data dir). The server never signals a CLI pid
  // it read from its own database (a pid proves nothing about which daemon
  // spawned the process); when a record says a session was deliberately ended
  // while its pid still answers, it asks the owning daemon, which ends it only
  // after proving ownership (its registry pid, the .pgid file it wrote, a spawn
  // journal line naming that same Walnut) and finding nothing that keeps the
  // session alive. The reply is {stopped:true} or {stopped:false,
  // reason:'not_owned'|'not_running'|'recent_output'|'protected', detail}.
  // Both twins implement it inline, so it is NOT sidecar-gated. Optional, and
  // fail-closed: a daemon without it gets no orphan request at all (and would
  // answer 'stop: invalid reason' if it did), so nothing is ended.
  'orphan-stop-v1',
  // 'owner-home-v1': EVERY server-originated `stop` (user, maintenance, idle)
  // carries `home` (the asking Walnut's data dir) and `initiator` ('human' or
  // 'automatic'), and an ephemeral server adds `strict`. The daemon refuses the
  // stop, before touching supervision or fencing a start, when the spawn
  // journal's first line for the sid names a different Walnut; when it names
  // none, `strict` is refused and an unjournaled sid may only be stopped by a
  // human. Why: an ephemeral server over copied data holds the user's session
  // ids, and with remote hosts on it reaches the SAME shared remote daemon.
  // Both twins implement it inline. Optional: the production server sends the
  // old unlabelled stop to a daemon without it; an ephemeral server sends none
  // at all (fail closed).
  'owner-home-v1',
  // 'proc-sample-v1': `proc.sample` answers what each session costs this host
  // (RSS and CPU of the CLI, its children and its process group, from ONE `ps`
  // per sample, proc-sample-core.ts). Both twins implement it (the core is
  // text-injected into the source twin), so it is NOT sidecar-gated. Not
  // bridge-reachable: it names host processes. Optional: without it the
  // Machine readout says the host's daemon needs an upgrade.
  'proc-sample-v1',
  // 'turn-snapshot-v1': at every turn end of a session whose cwd is in a git
  // repo, the daemon records the working tree under a hidden ref
  // (refs/walnut/turns/<sid>/<n>, turn-snapshot-core.ts), and answers
  // turns.list / turns.diff / turns.restore / turns.configure on them, plus
  // turns.guard (the rewind guard, turn-guard-core.ts). Both twins implement
  // it (the cores are text-injected into the source twin), so it is NOT
  // sidecar-gated. Not bridge-reachable: it reads and writes host files.
  // Optional: without it the Changed tab has no Turns view and a rewind
  // restores without the guard, as before.
  'turn-snapshot-v1',
  // 'git-commit-v1': `git.commitPlan` (the files a session changed in each repo
  // it touched, its own hunks attributed), `git.commitStart` (a commit / push /
  // PR job: a commit is built in a private index, hooks run against it, the
  // branch moves by compare-and-swap; a push never forces) and `git.commitJob`
  // (poll a job). Both twins implement it (git-commit-core.ts and
  // git-attribution-core.ts are text-injected into the source twin), so it is
  // NOT sidecar-gated; without the changes sidecar the plan is unattributed.
  // Not bridge-reachable: it writes refs and publishes. Optional: without it the
  // Changed tab says the host's daemon needs an update.
  'git-commit-v1',
  // 'workspace-v1': a task's isolated working copy (workspace-core.ts).
  // `workspace.detect` / `.create` / `.job` / `.status` / `.repos` / `.remove`
  // run the built-in git-worktree provider natively and plugin providers from an
  // allowlist the server pushes with `workspace.configure` (argv, no shell, JSON
  // over stdin/stdout). Both twins implement it (the core is text-injected into
  // the source twin), so it is NOT sidecar-gated. Not bridge-reachable: it runs
  // providers and removes folders on this host. Optional: without it a task
  // asking for an isolated workspace is told the host's daemon needs an update.
  'workspace-v1',
] as const

export type DaemonCapability = typeof REQUIRED_DAEMON_CAPABILITIES[number]

/**
 * Startup sanity check: is dist/daemon-binaries/*.version consistent with
 * the current daemon source code?
 *
 * Why this exists: the build pipeline is now wired so `npm run build` (and
 * `web:build`, `dev:prod`) automatically rebuilds daemon binaries. But a
 * developer can still:
 *   - Edit daemon source, then run the already-built `dist/cli.js` directly
 *     without rebuilding
 *   - Have a stale cached build from a different branch
 *
 * In either case the remote host will get a binary whose protocol doesn't
 * match the server code — silent permission hangs (the exact bug that
 * prompted this whole safeguard stack).
 *
 * We recompute the *expected* version at boot using the same algorithm as
 * scripts/build-daemon.sh (sha256 of daemon source files, truncated to 12
 * chars) and compare it against the .version sidecar. On mismatch we log
 * loudly and auto-rebuild.
 *
 * ⚠️ THIS GUARD MUST NEVER KILL THE SERVER. It used to return false on
 * non-remediable drift and the caller did `process.exit(1)`. A cosmetic
 * disagreement between the two hash-source lists (this file vs.
 * scripts/build-daemon.sh) then made the rebuild unable to ever converge,
 * turning a purely cosmetic bug into a restart-loop total outage (the guard's
 * own error text says the failure means *the guard* is broken — and it killed
 * the process anyway). Now: non-convergence logs loudly and continues, and the
 * caller never exits. A drifted daemon binary degrades remote sessions; a dead
 * server takes down everything.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { log } from '../logging/index.js'
import { DAEMON_BINARIES_DIR } from '../constants.js'
import { isFollower } from '../core/server-role.js'
import { BUILD_INFO_FILE, readBuildInfoFile } from '../lib/build-info.js'

export const DAEMON_SOURCE_FILES = [
  'src/providers/daemon-standalone.ts',
  // The area modules of createDaemonRuntime (its own code, one file per area).
  'src/providers/daemon-module-deps.ts',
  'src/providers/daemon-git.ts',
  'src/providers/daemon-skills.ts',
  'src/providers/daemon-fs-read.ts',
  'src/providers/daemon-fs-write.ts',
  'src/providers/daemon-changes.ts',
  'src/providers/daemon-transcripts.ts',
  'src/providers/daemon-hooks.ts',
  'src/providers/daemon-trigger-store.ts',
  'src/providers/daemon-trigger-runs.ts',
  'src/providers/daemon-trigger-set.ts',
  'src/providers/daemon-trigger-commands.ts',
  'src/providers/daemon-host-transfer.ts',
  'src/providers/daemon-host-services.ts',
  'src/providers/daemon-session-types.ts',
  'src/providers/daemon-session-owner.ts',
  'src/providers/daemon-usage-budget.ts',
  'src/providers/daemon-session-resume.ts',
  'src/providers/daemon-acp-sessions.ts',
  'src/providers/daemon-session-shell.ts',
  'src/providers/daemon-session-start.ts',
  'src/providers/daemon-session-commands.ts',
  'src/providers/daemon-session-stop.ts',
  'src/providers/daemon-session-state.ts',
  'src/providers/daemon-agent-subs.ts',
  'src/providers/daemon-line-checks.ts',
  'src/providers/daemon-session-tailer.ts',
  'src/providers/daemon-idle-scan.ts',
  'src/providers/daemon-cloud-bridge.ts',
  'src/providers/daemon-bridge-relays.ts',
  'src/providers/daemon-spawn-journal.ts',
  'src/providers/daemon-session-snapshot.ts',
  'src/providers/daemon-session-fold.ts',
  'src/providers/daemon-stream-compaction.ts',
  'src/providers/daemon-cloud-bridge-dial.ts',
  'src/providers/daemon-process-groups.ts',
  'src/providers/daemon-core.ts',
  'src/providers/daemon-fold.ts',
  // Fold checkpoints: imported by the binary, text-injected into the source twin.
  'src/providers/fold-checkpoint-core.ts',
  // The capability list itself. Both twins report it on `hello` — the standalone
  // one imports it, the source one has it substituted in — so a capability-only
  // edit changes what every host advertises. Without this entry that edit left
  // the version string identical, no host redeployed, and the server gated the
  // new feature off forever on the very daemons the edit was written for.
  'src/providers/daemon-capabilities.ts',
  // Agent gateway (peer sessions): shared protocol logic + the walnut CLI, both
  // bundled into the daemon binary. Same order as scripts/build-daemon.sh.
  // (The CLI file is still named wn-cli.ts — the rename is deferred; when it
  // happens, this entry and scripts/build-daemon.sh must move in ONE commit or
  // the two hashes disagree and the version guard can never converge.)
  'src/providers/gateway-core.ts',
  'src/providers/wn-cli.ts',
  // Every gateway line the CLI and its MCP server write, with its wait (bundled into the CLI above).
  'src/providers/gateway-request.ts',
  // How `walnut tools call` reads its args (inline / @file / stdin). Bundled
  // into the CLI above, so a change here must move the version — an unchanged
  // version means no host redeploys and @file silently stays unsupported.
  'src/providers/tool-args-source.ts',
  // How the CLI renders the op catalog + the parameters of one op (shared with the
  // hub CLI). Bundled into the CLI above: an unchanged version means remote
  // hosts keep printing the old signature-less catalog.
  'src/ops/op-help.ts',
  // `walnut mcp …` parsing and rendering, bundled into the CLI above.
  'src/providers/mcp-cli-args.ts',
  // `walnut mcp-server` (the Walnut ops as an MCP stdio server over this gateway) and
  // the instructions it hands its client; both bundled into the CLI above.
  'src/providers/walnut-mcp-stdio.ts',
  'src/mcp/instructions.ts',
  // Its answer cap, how the CLI prints an answer, and its call ids, imported by the two above.
  'src/lib/tool-answer-fit.ts',
  'src/lib/tool-answer-size.ts',
  'src/lib/op-call-id.ts',
  // ACP worker stack — compiled into the daemon deploy unit (worker artifact
  // ships with the daemon; version skew impossible by construction).
  'src/providers/acp-daemon.ts',
  'src/providers/acp-survive.ts',
  'src/providers/acp-thread-restore.ts',
  'src/providers/acp-host-artifacts.ts',
  'src/lib/cli-private-tmp.ts',
  // Where the compiled walnut file keeps the worker and adapters it runs as a host daemon.
  'src/lib/single-file.ts',
  'node_modules/@agentclientprotocol/codex-acp/package.json',
  // The adapter itself, as installed: Walnut patches it (patches/), and a patch
  // edit leaves package.json as it was, so only its contents move the version.
  'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
  'src/providers/codex-model-probe.ts',
  // Unified agent.* command routing table (agent-commands-v1) — bundled into
  // the standalone twin and inlined in the source twin; a routing-table-only
  // edit must still move the version or no daemon self-upgrades.
  'src/providers/agent-command-map.ts',
  'src/providers/acp-worker/worker.ts',
  'src/providers/acp-worker/worker-main.ts',
  'src/providers/acp-worker/journal.ts',
  'src/providers/acp-worker/protocol.ts',
  'src/providers/acp-worker/executor-error.ts',
  'src/providers/acp-worker/adapter-env.ts',
  // The client the worker runs for `codex app-server` (a direct Codex session).
  'src/providers/codex-app-server/rpc.ts',
  'src/providers/codex-app-server/launch.ts',
  'src/providers/codex-app-server/controls.ts',
  'src/providers/codex-app-server/connection.ts',
  'src/providers/codex-app-server/events.ts',
  'src/providers/codex-app-server/approvals.ts',
  'src/providers/codex-app-server/errors.ts',
  'src/providers/engine-turn-watch.ts',
  'src/core/service-url.ts',
  'src/providers/acp-worker/adapter-turn-watch.ts',
  'src/providers/child-end.ts',
  'src/providers/codex-app-server/transport.ts',
  'src/providers/codex-app-server/turn.ts',
  'src/providers/codex-app-server/background.ts',
  'src/providers/codex-app-server/commands.ts',
  'src/providers/codex-app-server/goal.ts',
  // Its model menu keeps only what the endpoint serves.
  'src/providers/codex-endpoint-models.ts',
  'src/core/agents/codex-slash-commands.ts',
  'src/providers/codex-app-server/thread-config.ts',
  // Its launch reads the same -c args the server builds, and their request tag.
  'src/providers/codex-engine-config.ts',
  'src/core/sessions/request-tag.ts',
  // The worker names a usage-limit refusal and reads its reset on the host.
  'src/providers/usage-limit-text.ts',
  // The worker redacts provider error words with it before the daemon logs them.
  'src/logging/redact.ts',
  // Session-changes host-local compute (changes.compute / changes.file).
  'src/providers/session-changes-core.ts',
  'src/providers/changes-checkpoint.ts',
  'src/providers/usage-host-core.ts',
  'src/providers/usage-scan-core.ts',
  'src/providers/usage-scan-index.ts',
  'src/providers/session-cost-core.ts',
  'src/providers/usage-reconcile-core.ts',
  'src/providers/usage-budget-persistence.ts',
  'src/providers/usage-budget-runtime.ts',
  'src/providers/usage-budget-store.ts',
  'src/providers/usage-budget-control.ts',
  'src/core/usage/pricing.ts',
  'src/core/usage/price-data.ts',
  'src/core/usage/price-resolve.ts',
  'src/core/usage/session-cost-pricing.ts',
  // External-session scan (sessions.discoverExternal) — bundled into the
  // binary AND shipped as the external-scan-core.cjs sidecar. Missing from
  // this list once: a classifier edit produced an identical version, no
  // daemon self-upgraded, and the new scan rules silently never ran.
  'src/providers/external-session-scan-core.ts',
  // Host-local path resolution (fs.resolvePath) — bundled into the binary AND
  // shipped as the path-resolve-core.cjs sidecar. Was missing from this list
  // (same failure mode as the scan-core note above); keep in lockstep with
  // scripts/build-daemon.sh.
  'src/providers/path-resolve-core.ts',
  // The servers a session started (ports.*): bundled AND shipped as port-scan-core.cjs.
  'src/providers/port-scan-core.ts',
  // Task directories (taskdir.*, WALNUT_TASK_DIR at spawn): bundled into the binary
  // AND shipped as the task-dir-core.cjs sidecar, with the path rules it imports.
  'src/providers/task-dir-core.ts',
  'src/providers/task-dir-sizes.ts',
  'src/providers/transcript-archive.ts',
  'src/providers/transcript-remote-retry.ts',
  'src/providers/transcript-archive-names.ts',
  'src/providers/host-cache-prune.ts',
  'src/lib/task-dir.ts',
  // The page silencer preload, written at every session start (rides the task-dir-core sidecar).
  'src/providers/pw-silence-core.ts',
  'src/providers/pw-noactivate-core.ts',
  'src/lib/machine-hold.ts',
  // Commands for tasks on other hosts (exec.*) — bundled into the binary AND
  // shipped as the host-exec-core.cjs sidecar, with the macOS dialog guards it imports.
  'src/providers/host-exec-core.ts',
  'src/providers/host-exec-line.ts',
  'src/providers/host-exec-guards.ts',
  'src/providers/host-exec-clt.ts',
  'src/providers/host-exec-watch.ts',
  // wait_for: the line scanner, the port and file checks, the pattern rules, and the killable
  // matcher process its lines are tested in.
  'src/providers/host-exec-wait.ts',
  'src/providers/host-exec-probe.ts',
  'src/providers/host-exec-pattern.ts',
  'src/providers/host-exec-matcher.ts',
  // How a run ends: what its shell left running in its process group is stopped with it.
  'src/providers/host-exec-group.ts',
  // A job as the daemon keeps it and as an answer shows it.
  'src/providers/host-exec-job.ts',
  // A plugin script (exec.script): the bounded runner, the same on the server for this machine.
  'src/providers/host-script-core.ts',
  // The exec.script runner on a host: the login shell, the macOS guards, the stop a handover waits for.
  'src/providers/host-exec-script.ts',
  // A job an earlier daemon here ran, read back from the audit.
  'src/providers/host-exec-recall.ts',
  'src/providers/host-exec-adopt.ts',
  // Work that outlives the daemon (a run, a script): its wrapper, its listing for a launcher, and the runner of detached scripts.
  'src/providers/detached-run.ts',
  'src/providers/detached-registry.ts',
  'src/providers/host-script-detached.ts',
  // The id of a host_exec run, chosen by the CLI and the MCP server bundled into the binary.
  'src/providers/host-exec-run-id.ts',
  // The host network (net.*): bundled into the binary AND shipped as net-core.cjs,
  // with the connector download it imports.
  'src/providers/net-core.ts',
  'src/providers/net-binary.ts',
  'src/providers/net-config-core.ts',
  'src/providers/net-control.ts',
  // The stable id of this machine, sent in hello (imported by the binary, inlined by the source twin).
  'src/providers/machine-id-core.ts',
  // A task on another host calling the MCP servers and web services of this host
  // (mcp.*, http.request): bundled into the binary AND shipped as host-reach-core.cjs.
  'src/providers/host-mcp-core.ts',
  'src/providers/host-http-core.ts',
  'src/providers/host-reach-core.ts',
  // Fleet secrets (secrets.*) — bundled into the binary AND shipped as the
  // secrets-core.cjs sidecar.
  'src/providers/secrets-core.ts',
  // Host-local symbol search (fs.grep) — bundled into the binary twin.
  'src/providers/search-grep-core.ts',
  // Embedded VS Code (vscode.ensure) — bundled into the binary AND shipped
  // as the vscode-server-core.cjs sidecar.
  'src/providers/vscode-server-core.ts',
  // Host-local transcript rewind probe (transcript.rewindProbe) — bundled into
  // the binary AND shipped as the transcript-rewind-core.cjs sidecar, together
  // with the chain machinery it computes over. Both files must be hashed: an
  // edit to either changes what the probe answers, and an unchanged version
  // means no host self-upgrades.
  'src/providers/transcript-rewind-core.ts',
  // walnut-trigger check contract (triggers.configure / .test / .run / .ack) —
  // bundled into the binary AND shipped as the trigger-check-core.cjs sidecar.
  // Same lockstep rule as the two above: a rule edit here that leaves the version
  // unchanged means no host self-upgrades and the old dedup rules keep running.
  'src/providers/trigger-check-core.ts',
  // The fire envelope a host builds for a fire no server claimed, and the sidecar
  // entry that ships it to the source twin: same lockstep rule.
  'src/providers/trigger-envelope-core.ts',
  // Clock routines (clock-routine-v1): the rules ride the sidecar, the schedule
  // math is imported by the standalone twin and inlined into the source twin.
  'src/providers/trigger-clock-core.ts',
  // triggers.state.snapshot rules (trigger-state-snapshot-v1), bundled into the binary
  // and shipped in the trigger-check-core.cjs sidecar: same lockstep rule.
  'src/providers/trigger-state-snapshot-core.ts',
  // triggers.state.seed rules (trigger-state-seed-v1): bundled and in the sidecar the same way.
  'src/providers/trigger-state-seed-core.ts',
  'src/providers/clock-schedule-core.ts',
  'src/core/cron/trigger-timing.ts',
  'src/core/transcript-chain.ts',
  'src/core/transcript-chain-leaf.ts',
  // The first-paint history view (history.readyView), bundled into the binary AND shipped as
  // the history-ready-core.cjs sidecar, and the transcript parser it shares with the server
  // with every module that parser imports: a parse edit must move the version.
  'src/providers/history-ready-core.ts',
  'src/providers/history-ready-worker.ts',
  'src/core/history-parse.ts',
  'src/core/history-parser-version.ts',
  'src/core/drained-sends.ts',
  'src/core/sessions/legacy-hint-lines.ts',
  'src/core/sessions/user-text-projection.ts',
  'src/core/hints/hint-format.ts',
  'src/core/org/message-about.ts',
  'src/core/sessions/cli-error-reply.ts',
  'src/core/sessions/prompt-cache.ts',
  'src/core/sessions/side-thread-digest.ts',
  'src/core/sessions/side-thread-warmup.ts',
  'src/core/sessions/walnut-commands.ts',
  'src/core/stream/compaction-notice.ts',
  'src/core/stream/hook-notice.ts',
  'src/core/text-cut.ts',
  // The effort registry the parser (and types.ts) import at run time.
  'src/core/session-effort.ts',
  'src/lib/ai-only-envelope.ts',
  'src/lib/history-injected-banner.ts',
  'src/lib/history-session-envelope.ts',
  'src/lib/history-turn-window.ts',
  'src/lib/internal-lines.ts',
  'src/lib/history-walnut-riders.ts',
  'src/lib/turn-end-marker.ts',
  'src/lib/walnut-added.ts',
  'src/lib/composed-framing.ts',
  'src/lib/attachment-headers.ts',
  'src/core/transcript-chain-prefilter.ts',
  'src/core/bash-file-ops.ts',
  'src/providers/daemon-instance-lock.ts',
  'src/providers/daemon-command-drain.ts',
  'src/providers/demo-daemon-quiesce-core.ts',
  'src/providers/daemon-restart-mark.ts',
  'src/providers/daemon-cron-supervision.ts',
  'src/providers/daemon-cron-store.ts',
  'src/providers/daemon-cron-controller.ts',
  'src/providers/daemon-cron-schedule.ts',
  'src/providers/daemon-cron-transcript.ts',
  'src/providers/daemon-cron-observer.ts',
  'src/providers/daemon-cron-host.ts',
  'src/providers/daemon-cron-runtime.ts',
  'src/providers/daemon-cron-metadata.ts',
  'src/providers/daemon-spawn-barrier.ts',
  'src/providers/daemon-child-spawn.ts',
  // The tailer, clocks, spawn pool and in-process client of the runtime (the daemon body as modules).
  'src/providers/session-tailer.ts',
  'src/providers/daemon-runtime-timers.ts',
  'src/providers/daemon-in-process-client.ts',
  'src/providers/daemon-runtime-types.ts',
  'src/providers/loop-budget.ts',
  'src/providers/spawn-pool.ts',
  'src/providers/session-spawn-files.ts',
  'src/providers/agent-file-chunk.ts',
  'src/providers/daemon-door.ts',
  'src/providers/daemon-service-config.ts',
  'src/providers/daemon-service-manager.ts',
  // launchd and systemd steps the manager takes (bootout settled, bootstrap retried, the unit kept active).
  'src/providers/daemon-service-launchd.ts',
  'src/providers/daemon-service-systemd.ts',
  'src/providers/daemon-service-artifact.ts',
  // The busy words the handover wait of the CLI asks again on.
  'src/providers/daemon-busy-words.ts',
  'src/providers/daemon-service-cli.ts',
  'src/providers/daemon-over-busy.ts',
  // Whether the service daemon answers and stays (daemonReady, daemonStays), bundled into daemon-service-cli.cjs.
  'src/providers/daemon-service-ready.ts',
  // The trial run of a new daemon before any service change, bundled into daemon-service-cli.cjs.
  'src/providers/daemon-boot-proof.ts',
  // Where a trial of the walnut file unpacks its runtime (walnutLineRuntimeDir, RUNTIME_TRIAL_ENV), bundled into daemon-service-cli.cjs.
  'src/binary/runtime-tree.ts',
  'src/binary/asset-archive.ts',
  // The login-shell PATH of the daemon program and of its `walnut daemon ...` commands.
  'src/providers/daemon-cli-path.ts',
  // `walnut daemon handback`: a stand-in hands its sessions to the LaunchAgent job (bundled into daemon-service-cli.cjs).
  'src/providers/daemon-service-handback.ts',
  'src/providers/daemon-update-standin.ts',
  'src/providers/daemon-update-shell.ts',
  'src/providers/daemon-live-sh.ts',
  'src/providers/daemon-service-boot-script.ts',
  'src/providers/daemon-service-cron.ts',
  'src/providers/daemon-service-cron-host.ts',
  'src/providers/daemon-service-scope.ts',
  'src/providers/daemon-service-state-move.ts',
  // The service sets of a host (their names, dirs and the choice of set), bundled into the daemon and daemon-service-cli.cjs.
  'src/providers/service-set.ts',
  'src/providers/service-set-choice.ts',
  'src/providers/service-set-remove.ts',
  'src/providers/daemon-service-uninstall-tail.ts',
  // The walnut-net identity of a service set, for its leader (walnut daemon net-id and net-forget, daemon-service-cli.cjs).
  'src/providers/service-set-net.ts',
  'src/providers/daemon-serves.ts',
  // The account lookup daemon-service-cli.ts refuses a faked home with, bundled into its .cjs.
  'src/lib/account.ts',
  // The runtime dir rule `walnut daemon install` pins (~/.cache/open-walnut for a second user).
  'src/lib/daemon-dir.ts',
  'src/providers/daemon-service-files.ts',
  // The store lock daemon-service-files.ts takes, bundled into daemon-service-cli.cjs: a lock
  // change must redeploy every host, or old and new lock code share the service files.
  'src/utils/file-lock.ts',
  // The write gate file-lock.ts passes through (off unless the standby copy runs).
  'src/utils/write-gate.ts',
  'src/providers/daemon-service-system.ts',
  'src/providers/daemon-service-handover.ts',
  // The service launcher: its script, its control from walnut daemon, the service heartbeat.
  'src/providers/service-launcher-script.ts',
  'src/providers/service-launcher-control.ts',
  'src/providers/service-launcher-beat.ts',
  // Host runtime discovery (daemon PATH order, claude/node spawn gate,
  // host.preflight): imported by the binary, text-injected into the source twin.
  'src/providers/host-runtime-core.ts',
  // The shell a session starts in and its spawn preamble, shell_setup included.
  'src/providers/session-shell.ts',
  // host.fix (install claude / gcc, build dtach): same import-or-inline rule.
  'src/providers/host-fix-core.ts',
  // Its Claude Code installer (resumable download) and dtach build: same rule.
  'src/providers/claude-install-core.ts',
  'src/providers/claude-download-core.ts',
  'src/providers/dtach-build-core.ts',
  // The Claude Code sign-in and version check of host.preflight: same rule.
  'src/providers/claude-check-core.ts',
  // fs.ls with its per-entry and whole-listing budgets: same rule.
  'src/providers/fs-ls-core.ts',
  // The claude argv frame of a resume whose spawn record is lost (bridgeResume).
  'src/providers/claude-session-argv.ts',
  // Per-turn snapshots and the rewind guard: same import-or-inline rule.
  'src/providers/turn-snapshot-core.ts',
  'src/providers/turn-guard-core.ts',
  // Session commit (git.commitPlan / commitStart / commitJob): same import-or-inline rule.
  'src/providers/git-attribution-core.ts',
  'src/providers/git-commit-core.ts',
  // The offline host and the envelope wording it shares with the server: same
  // import-or-inline rule (docs/plan/daemon-first-hosts.md).
  'src/providers/offline-host-core.ts',
  'src/providers/offline-journal-core.ts',
  // The journal store, offline host, boot migration and sweep wired once for both twins: same rule.
  'src/providers/host-journal-core.ts',
  'src/core/peers/envelope-kit.ts',
  // The send rules it runs as the server does (reply default, wake, deadlines): same rule.
  'src/core/sessions/send-rules.ts',
  // The leader book (who leads while the primary is away): same rule
  // (docs/plan/walnut-control-plane.md).
  'src/providers/leader-core.ts',
  'src/providers/walnut-scope-core.ts',
  'src/providers/served-walnuts-core.ts',
  'src/providers/gateway-identity-core.ts',
  // The op catalogs the gateway holds for its sessions (tools-list-held-v1): same rule.
  'src/providers/held-catalogs-core.ts',
  // A model or effort change while the companion leads: same rule.
  'src/providers/live-settings-core.ts',
  // The offline search on a host: same rule.
  'src/providers/offline-search-core.ts',
  'src/providers/offline-board-core.ts',
  'src/providers/host-replica-core.ts',
  // The copy of the pictures in the notes (attachment-copy-v1): same rule.
  'src/providers/attachment-copy-core.ts',
  // Owner-scoped follower reads (replica-reads-v1): same import-or-inline rule.
  'src/providers/follower-reads-core.ts',
  'src/providers/follower-gateway-core.ts',
  // The tokens of the host call entry (host-call-entry-v1) and its client (wn-cli.ts, the plugin
  // job harness; the JS twin inlines both): same rule.
  'src/providers/host-call-token-core.ts',
  'src/providers/host-call-client-core.ts',
  // Trigger fires delivered by the server on the host (follower-trigger-delivery-v1): same rule.
  'src/providers/follower-trigger-delivery-core.ts',
  // The host server the daemon keeps running (host-server-v1): same rule.
  'src/providers/host-server-core.ts',
  // The plugin jobs the daemon keeps running (plugin-jobs-v1) and the harness each job
  // process runs in (imported by the walnut CLI of the standalone, inlined by the JS twin).
  'src/providers/plugin-jobs-core.ts',
  'src/providers/plugin-job-harness.ts',
  'src/providers/plugin-job-door.ts',
  // Streams between servers through the daemon (stream-relay-v1): same rule.
  'src/providers/stream-relay-core.ts',
  // Hub forwards on this machine (hub-forward-v1): same rule.
  'src/providers/hub-forward-core.ts',
  // Terminal streams through the daemon (pty-stream-v1): same rule.
  'src/providers/pty-stream-core.ts',
  'src/providers/feature-relay-core.ts',
  // A stopped session resumed on its host for a trigger fire (trigger-host-resume-v1): same rule.
  'src/providers/host-resume-core.ts',
  'src/providers/cli-owner-core.ts',
  'src/providers/cli-argv-files-core.ts',
  // A new ask while the Mac is away (replica-start-v1): same import-or-inline rule.
  'src/providers/host-start-core.ts',
  // What the Walnut server on a host asks its daemon (follower.*): same import-or-inline rule.
  'src/providers/follower-entry-core.ts',
  // Registry writes and log appends (both twins: import or inline): same rule.
  'src/providers/file-pool-deadline.ts',
  'src/providers/registry-writer-core.ts',
  'src/providers/log-appender-core.ts',
  // What the --service entry runs, the daemon or the Walnut service in either role, its mode file
  // (bundled in daemon-service-cli.cjs), its start hooks and the ready watch of a leading service.
  'src/binary/service-entry.ts',
  'src/binary/service-mode.ts',
  'src/binary/service-mode-lock.ts',
  'src/binary/service-mode-update.ts',
  'src/binary/service-start-hooks.ts',
  'src/binary/service-lead-ready.ts',
  // The roles a version can take as that service (hello serviceRoles, goodRoles of the launcher).
  'src/providers/service-roles.ts',
  // A routine run started on its host while the Mac is away (clock-host-start-v1): same rule.
  'src/providers/clock-host-start-core.ts',
  'src/core/sessions/open-items-text.ts',
  // A letter from a session, checked on the host while the Mac is away: same rule.
  'src/core/human-inbox/letter-check.ts',
  'src/core/routines/trigger-label.ts',
  // How a trigger watches field reads, shared with the server (offline-host-core.ts imports it).
  'src/core/routines/trigger-watches.ts',
  // Which session on a host takes a trigger fire, shared with the server on the host: same rule.
  'src/core/routines/host-trigger-target.ts',
  // git.diff, run host-side: imported by the standalone twin.
  'src/providers/git-diff-core.ts',
  'src/providers/caller-proof-core.ts',
  'src/providers/socket-peer-pid.ts',
  // The paced bridge uplink and loop-drift probe: same import-or-inline rule.
  'src/providers/bridge-uplink-core.ts',
  // Task workspaces (workspace.create / status / remove): same import-or-inline rule.
  'src/providers/workspace-core.ts',
  // What became of a line (send-dedupe-v1): same import-or-inline rule.
  'src/providers/line-fate-core.ts',
  // markers.find (the delivery-marker lookup): imported by the binary,
  // hand-inlined in the source twin.
  'src/providers/marker-find-core.ts',
  // logs.tail (replica-logs-v1, WP14): same import-or-inline rule.
  'src/providers/replica-logs-core.ts',
  // Workspace transfer (fs.writePart, transfer.*) and host.facts: same import-or-inline rule.
  'src/providers/transfer-core.ts',
  'src/providers/transfer-pack-core.ts',
  'src/providers/host-facts-core.ts',
  'src/providers/host-vitals-core.ts',
  'src/providers/desktop-update-core.ts',
  // Stream compaction (stream-compact-core.ts): same import-or-inline rule.
  'src/providers/stream-compact-core.ts',
  // Async stream fold and rotation on resume (stream-fold-core.ts): same rule.
  'src/providers/stream-fold-core.ts',
  // One-shot claude runs (oneshot-v1): same import-or-inline rule.
  'src/providers/oneshot-core.ts',
  // Modules the bundles above import (daemon-version-hash-parity.test.ts walks the
  // imports of every bundle): a change to one changes what a host runs.
  'src/providers/user-line-images-core.ts',
  'src/providers/network-cause-core.ts',
  'src/core/types.ts',
  'src/core/experimental.ts',
  // types.ts re-exports the Inbox name and helpers (the web reads them through it).
  'src/core/inbox-project.ts',
  'src/lib/git-env.ts',
  'src/providers/path-ref-parse.ts',
  'src/providers/host-runtime-types.ts',
  'src/providers/codex-outside-core.ts',
  'src/providers/claude-outside-core.ts',
] as const

/**
 * Compute the expected daemon version from source files.
 * Returns null if sources can't be located (e.g. running from a published
 * npm package where src/ wasn't shipped — in that case the binary is
 * whatever was baked in, and we have to trust it).
 */
export function computeExpectedDaemonVersion(): string | null {
  const repoRoot = findRepoRoot()
  if (!repoRoot) return null

  // Per-file: path + NUL + content + NUL. The separator prevents boundary
  // collisions (e.g. shifting bytes between file A and file B shouldn't
  // produce the same hash). MUST stay in lockstep with scripts/build-daemon.sh
  // — if you change the algorithm here, change it there too.
  const hash = createHash('sha256')
  const NUL = Buffer.from([0])
  for (const rel of DAEMON_SOURCE_FILES) {
    const abs = path.join(repoRoot, rel)
    try {
      hash.update(Buffer.from(rel))
      hash.update(NUL)
      hash.update(fs.readFileSync(abs))
      hash.update(NUL)
    } catch {
      return null  // Source tree not available — skip the check
    }
  }
  return 'walnut-daemon-' + hash.digest('hex').slice(0, 12)
}

/**
 * The commit of the build in the dist beside the daemon binaries, when it was made from a clean
 * tree at a commit that is not the checkout's HEAD; else null (also when HEAD cannot be read).
 */
function builtFromCleanCommitNotHead(): string | null {
  const info = readBuildInfoFile(path.join(path.dirname(DAEMON_BINARIES_DIR), BUILD_INFO_FILE), '')
  if (!info.commit || info.dirty || !/^[0-9a-f]{7,40}$/.test(info.commit)) return null
  const root = findRepoRoot()
  const head = root ? readHeadCommit(root) : null
  return head && !head.startsWith(info.commit) ? info.commit : null
}

/** The commit HEAD names in a checkout, read from its git files (a worktree's `.git` file included). */
export function readHeadCommit(root: string): string | null {
  try {
    let gitDir = path.join(root, '.git')
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))
      if (!m) return null
      gitDir = path.resolve(root, m[1].trim())
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1]
    if (!ref) return null
    // A worktree keeps its refs in the main repository (commondir).
    let common = gitDir
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) } catch { /* not a worktree */ }
    for (const dir of [gitDir, common]) {
      try {
        const v = fs.readFileSync(path.join(dir, ref), 'utf8').trim()
        if (/^[0-9a-f]{40}$/.test(v)) return v
      } catch { /* packed */ }
    }
    const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const [sha, name] = line.split(' ')
      if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha
    }
    return null
  } catch {
    return null
  }
}

function findRepoRoot(): string | null {
  // dist/providers/daemon-version-check.js → ../../
  // Dual marker: package.json alone matches installed npm packages which MUST
  // be skipped (no sources → trust binary). Presence of the daemon source file
  // distinguishes a dev checkout from an npm-installed copy.
  let dir = path.dirname(fileURLToPath(import.meta.url))
  // Belt-and-suspenders: 10 levels covers pnpm/nested/monorepo layouts.
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))
      && fs.existsSync(path.join(dir, 'src', 'providers', 'daemon-standalone.ts'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Same lookup as scripts/build-daemon.sh: PATH, then the usual install prefixes. */
function bunAvailable(): boolean {
  const home = process.env.HOME ?? ''
  const candidates = [
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'bun')),
    path.join(home, '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ]
  return candidates.some((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false } })
}

/**
 * The version files a full `scripts/build-daemon.sh` writes (one per compiled
 * daemon, and the ACP worker's). `daemon.version` is the marker a sidecars-only
 * build leaves (WALNUT_DAEMON_SIDECARS_ONLY): a full build never rewrote it, so
 * one left in this dir read as drift on every boot, ran a blocking rebuild that
 * could never fix it, and filled the Mac app's error screen with this guard's
 * text (2026-11-03). It names no binary here and is not read.
 */
function readBuiltVersions(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    for (const f of fs.readdirSync(DAEMON_BINARIES_DIR)) {
      if (!f.endsWith('.version') || f === 'daemon.version') continue
      const arch = f.slice(0, -'.version'.length)
      const v = fs.readFileSync(path.join(DAEMON_BINARIES_DIR, f), 'utf-8').trim()
      if (v) out.set(arch, v)
    }
  } catch { /* no binaries dir — nothing built yet */ }
  return out
}

const GAVE_UP_FILE = '.version-guard-gave-up'

/** The drift a rebuild could not fix, recorded so the next boots do not rebuild for it again. */
function gaveUpKey(ctx: { expected: string; got: string }): string {
  return `${ctx.expected} ${ctx.got}`
}

function gaveUpOn(ctx: { expected: string; got: string }): boolean {
  try { return fs.readFileSync(path.join(DAEMON_BINARIES_DIR, GAVE_UP_FILE), 'utf8').trim() === gaveUpKey(ctx) } catch { return false }
}

function rememberGaveUp(ctx: { expected: string; got: string }): void {
  try { fs.writeFileSync(path.join(DAEMON_BINARIES_DIR, GAVE_UP_FILE), gaveUpKey(ctx) + '\n') } catch { /* advisory */ }
}

/**
 * Verify dist/daemon-binaries/*.version matches current daemon source.
 *
 * On mismatch, runs `bash scripts/build-daemon.sh` synchronously to rebuild.
 *
 * @returns `true` when startup should continue (which is now ALWAYS the case —
 *          the return value is kept for tests/telemetry, and `false` is only
 *          produced by paths that no longer gate startup). Callers must NOT
 *          exit on `false`; see the file header.
 */
export function verifyDaemonBinaryVersion(): boolean {
  // Cloud REPLICA never deploys daemon binaries to exec hosts — it proxies to
  // Mac/remote daemons over the /bridge WS. The guard protects nothing here,
  // and its rebuild path needs bun + the full source tree, neither of which is
  // guaranteed on the cloud box. Skip it entirely.
  if (isFollower()) {
    log.session.info('cloud mode: skipping daemon binary version check (no local daemon deploys)')
    return true
  }

  const expected = computeExpectedDaemonVersion()
  if (!expected) {
    // Can't locate daemon sources (e.g. installed npm package). Trust the
    // baked-in binary — nothing we can do.
    return true
  }

  const built = readBuiltVersions()

  if (built.size === 0 && !bunAvailable()) {
    // A checkout on a machine without Bun: build-daemon.sh skipped the binaries on
    // purpose and sessions run the source daemon. Nothing has drifted, and running
    // the rebuild would just skip again, so say what is happening once and move on.
    log.session.info('no daemon binaries and no Bun on this machine; sessions use the source daemon', { expected })
    return true
  }

  if (built.size === 0) {
    // No binaries yet. dev:prod always builds them, so this is only hit if
    // someone runs a bare `node dist/cli.js web` after a fresh checkout.
    return handleMismatch({
      reason: 'no daemon binaries built',
      expected,
      got: '(none)',
    })
  }

  const mismatched: Array<{ arch: string, got: string }> = []
  for (const [arch, version] of built) {
    if (version !== expected) mismatched.push({ arch, got: version })
  }

  if (mismatched.length === 0) {
    log.session.info('daemon binary version check OK', { expected })
    return true
  }

  // `expected` is hashed from the checkout's working tree, which is this build's source only
  // when the build was made from it. A dist that records a clean build of ANOTHER commit than the
  // checkout's HEAD was not (a deploy's, built in a clean clone and published into the checkout
  // by scripts/publish-serve-root-dist.mjs, with its own daemon binaries): judged by the tree,
  // which lands move ahead of the deploys, it reads as drift, and the rebuild from the tree then
  // shipped every remote host a daemon of code this server does not run (2026-11-21: a server
  // the Mac app started from the published dist rebuilt the daemons from the tree and updated
  // three hosts with one that lacked acp-host-v1). A build of the checkout's own HEAD (a
  // developer's build, then a daemon edit; a watch build after a pull) is judged as before.
  const build = builtFromCleanCommitNotHead()
  if (build) {
    log.session.info('daemon binaries came with a clean build of another tree; not judged by this checkout', {
      expected, got: mismatched.map(m => `${m.arch}=${m.got}`).join(', '), buildCommit: build,
    })
    return true
  }

  return handleMismatch({
    reason: 'daemon source has drifted from built binaries',
    expected,
    got: mismatched.map(m => `${m.arch}=${m.got}`).join(', '),
  })
}

function handleMismatch(ctx: {
  reason: string
  expected: string
  got: string
}): boolean {
  log.session.error('DAEMON VERSION DRIFT DETECTED', ctx)
  // eslint-disable-next-line no-console
  console.error(
    `\n⚠️  DAEMON VERSION DRIFT: ${ctx.reason}`
    + `\n    expected: ${ctx.expected}`
    + `\n    built:    ${ctx.got}`
    + `\n    Remote hosts would receive a daemon whose protocol doesn't match this server.`
    + `\n    This is the bug that silently hangs permission approvals.`
    + `\n`,
  )

  const repoRoot = findRepoRoot()
  if (!repoRoot) {
    // eslint-disable-next-line no-console
    console.error('    Cannot auto-rebuild (no repo root). Continuing WITHOUT guard.\n')
    return false
  }
  // The same drift a rebuild already failed to fix: rebuilding again only blocks
  // this boot for up to two minutes and ends the same way.
  if (gaveUpOn(ctx)) {
    log.session.warn('daemon version guard: a rebuild already failed to fix this drift; not rebuilding again', ctx)
    // eslint-disable-next-line no-console
    console.error('    A rebuild already failed to fix this; not rebuilding again. Startup continues.\n')
    return true
  }

  // Always attempt to auto-rebuild. Rebuild takes 1-2s with bun compile and
  // the cost of shipping a drifted binary (silent permission hangs) vastly
  // outweighs the inconvenience of an unexpected rebuild at startup.
  // eslint-disable-next-line no-console
  console.error(`    Running: bash scripts/build-daemon.sh ...\n`)
  const res = spawnSync('bash', ['scripts/build-daemon.sh'], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: 120_000,
  })
  if (res.status === null) {
    log.session.error('daemon rebuild timed out — continuing WITHOUT guard', { expected: ctx.expected })
    // eslint-disable-next-line no-console
    console.error('\n⚠️  Daemon rebuild timed out after 120s — is bun installed and on PATH?'
      + '\n    Continuing startup WITHOUT the guard (remote sessions may be degraded).\n')
    return false
  }
  if (res.status !== 0) {
    log.session.error('daemon rebuild failed — continuing WITHOUT guard', {
      expected: ctx.expected,
      exitCode: res.status,
    })
    // eslint-disable-next-line no-console
    console.error('\n⚠️  Daemon rebuild FAILED. Continuing startup WITHOUT the guard —'
      + '\n    remote sessions may be degraded until the binaries are rebuilt.\n')
    return false
  }

  // Re-verify after rebuild. If the rebuild produced a DIFFERENT hash than we
  // expect, the two hash-source lists have drifted — i.e. the guard itself is
  // broken, not the binaries. That is a cosmetic bug and MUST NOT be fatal:
  // exiting here crash-looped a production server 41 times. Log loudly (so it
  // gets fixed) and continue without the guard.
  const builtAfter = readBuiltVersions()
  if (builtAfter.size === 0) {
    // build-daemon.sh exits 0 without Bun, having built nothing; that is a skip, not
    // a rebuild, and must not be reported as one.
    log.session.warn('daemon rebuild produced no binaries (no Bun?); continuing with the source daemon', { expected: ctx.expected })
    // eslint-disable-next-line no-console
    console.error(`    Daemon binaries were not built (Bun is not installed). Sessions use the source daemon. Continuing startup.\n`)
    return true
  }
  const stillOff = [...builtAfter].filter(([, v]) => v !== ctx.expected)
  if (stillOff.length > 0) {
    log.session.error(
      'daemon version guard cannot converge — hash lists have drifted; continuing WITHOUT guard',
      {
        expected: ctx.expected,
        got: stillOff.map(([arch, v]) => `${arch}=${v}`).join(', '),
        sourceFiles: [...DAEMON_SOURCE_FILES],
      },
    )
    rememberGaveUp(ctx)
    // Short: a launcher (the Mac app) shows the last lines of this output when the
    // server fails for another reason, and they must be that reason. The file list
    // is in the log line above.
    // eslint-disable-next-line no-console
    console.error(
      `\n⚠️  DAEMON VERSION GUARD CANNOT CONVERGE — continuing WITHOUT guard.`
      + `\n    Rebuilt, still ${stillOff.map(([a, v]) => `${a}=${v}`).join(', ')}; expected ${ctx.expected}.`
      + `\n    Most likely a stale dist/ (bun run web:build), else the hash lists of scripts/build-daemon.sh`
      + `\n    and daemon-version-check.ts differ (the log names the files). A guard bug, not fatal.\n`,
    )
    return true
  }
  log.session.info('daemon binaries rebuilt after version drift', { expected: ctx.expected })
  // eslint-disable-next-line no-console
  console.error(`    ✓ Daemon binaries rebuilt to ${ctx.expected}. Continuing startup.\n`)
  return true
}

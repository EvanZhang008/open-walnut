#!/bin/bash
# Build cross-compiled daemon binaries for remote Linux hosts and local macOS.
# Requires Bun (https://bun.sh).
#
# Usage:
#   bash scripts/build-daemon.sh
#   bun run build:daemon
#
# Output:
#   dist/daemon-binaries/daemon-linux-x64
#   dist/daemon-binaries/daemon-linux-arm64
#   dist/daemon-binaries/daemon-darwin-arm64
#   dist/daemon-binaries/dtach-<platform>-<arch>  (when a C compiler exists; see build-dtach.sh)
#
# Version strategy: hash of daemon source files. Immune to git dirty state,
# forgotten commits, or branch switches — if any byte of the sources changes
# the version string changes, which forces the remote host to redeploy on
# next connect (see DaemonConnection.shouldUpgradeDaemon).
set -e

cd "$(dirname "$0")/.."

# Resolve bun even under a thin PATH (launchd/cron/systemd give jobs
# /usr/bin:/bin:... without user install prefixes). Same problem class as
# src/core/stt/spawn-env.ts — never assume the caller's shell PATH.
# A bun of the version package.json pins or newer (scripts/lib/find-bun.sh): the
# daemon binaries carry the runtime of the bun that compiles them, and the first
# bun on PATH can be an older one than the bun running the build.
# shellcheck source=lib/find-bun.sh
. scripts/lib/find-bun.sh
# shellcheck source=lib/bun-compile.sh
. scripts/lib/bun-compile.sh
BUN=""
if walnut_find_bun "$PWD"; then BUN="$BUN_BIN"; fi
if [ -z "$BUN" ]; then
  # Bun only cross-compiles the daemon binaries. A checkout without them still runs its
  # local daemon from source (local-daemon.ts), and hosts get the walnut file instead
  # (daemon-connection.ts deployDaemon). Failing here used to stop the first build dead
  # on any machine that had never installed Bun, which is every new user's machine.
  # Release flows set WALNUT_REQUIRE_BUN=1 so a published tarball can never miss them.
  echo "build-daemon.sh: $(walnut_bun_missing)" >&2
  if [ "${WALNUT_REQUIRE_BUN:-0}" = 1 ]; then
    echo "build-daemon.sh: WALNUT_REQUIRE_BUN=1 is set, so this is fatal. Install Bun: https://bun.sh" >&2
    exit 1
  fi
  echo "build-daemon.sh: skipping the daemon binaries. Walnut still runs its local daemon from source; remote hosts need the compiled daemon, which needs Bun." >&2
  echo "build-daemon.sh: install Bun (https://bun.sh) and re-run \`bun run build:daemon\` to get the faster prebuilt path." >&2
  exit 0
fi

"$BUN" scripts/build-pi-acp.mjs

SOURCES=(
  src/providers/daemon-standalone.ts
  src/providers/daemon-module-deps.ts
  src/providers/daemon-git.ts
  src/providers/daemon-skills.ts
  src/providers/daemon-fs-read.ts
  src/providers/daemon-fs-write.ts
  src/providers/daemon-changes.ts
  src/providers/daemon-transcripts.ts
  src/providers/daemon-hooks.ts
  src/providers/daemon-trigger-store.ts
  src/providers/daemon-trigger-runs.ts
  src/providers/daemon-trigger-set.ts
  src/providers/daemon-trigger-commands.ts
  src/providers/daemon-host-transfer.ts
  src/providers/daemon-host-services.ts
  src/providers/daemon-process-groups.ts
  src/providers/daemon-core.ts
  src/providers/daemon-fold.ts
  src/providers/fold-checkpoint-core.ts
  src/providers/daemon-capabilities.ts
  src/providers/gateway-core.ts
  src/providers/wn-cli.ts
  src/providers/gateway-request.ts
  src/providers/tool-args-source.ts
  src/ops/op-help.ts
  src/providers/mcp-cli-args.ts
  src/providers/walnut-mcp-stdio.ts
  src/mcp/instructions.ts
  src/lib/tool-answer-fit.ts
  src/lib/tool-answer-size.ts
  src/lib/op-call-id.ts
  src/providers/acp-daemon.ts
  src/providers/acp-survive.ts
  src/providers/acp-thread-restore.ts
  src/providers/acp-host-artifacts.ts
  src/lib/cli-private-tmp.ts
  src/lib/single-file.ts
  node_modules/@agentclientprotocol/codex-acp/package.json
  node_modules/@agentclientprotocol/codex-acp/dist/index.js
  src/providers/codex-model-probe.ts
  src/providers/agent-command-map.ts
  src/providers/acp-worker/worker.ts
  src/providers/acp-worker/worker-main.ts
  src/providers/acp-worker/journal.ts
  src/providers/acp-worker/protocol.ts
  src/providers/acp-worker/executor-error.ts
  src/providers/acp-worker/adapter-env.ts
  src/providers/codex-app-server/rpc.ts
  src/providers/codex-app-server/launch.ts
  src/providers/codex-app-server/controls.ts
  src/providers/codex-app-server/connection.ts
  src/providers/codex-app-server/events.ts
  src/providers/codex-app-server/approvals.ts
  src/providers/codex-app-server/errors.ts
  src/providers/engine-turn-watch.ts
  src/core/service-url.ts
  src/providers/acp-worker/adapter-turn-watch.ts
  src/providers/child-end.ts
  src/providers/codex-app-server/transport.ts
  src/providers/codex-app-server/turn.ts
  src/providers/codex-app-server/background.ts
  src/providers/codex-app-server/commands.ts
  src/providers/codex-app-server/goal.ts
  src/providers/codex-endpoint-models.ts
  src/core/agents/codex-slash-commands.ts
  src/providers/codex-app-server/thread-config.ts
  src/providers/codex-engine-config.ts
  src/core/sessions/request-tag.ts
  src/providers/usage-limit-text.ts
  src/logging/redact.ts
  src/providers/session-changes-core.ts
  src/providers/changes-checkpoint.ts
  src/providers/usage-host-core.ts
  src/providers/usage-scan-core.ts
  src/providers/usage-scan-index.ts
  src/providers/session-cost-core.ts
  src/providers/usage-reconcile-core.ts
  src/providers/usage-budget-persistence.ts
  src/providers/usage-budget-runtime.ts
  src/providers/usage-budget-store.ts
  src/providers/usage-budget-control.ts
  src/core/usage/pricing.ts
  src/core/usage/price-data.ts
  src/core/usage/price-resolve.ts
  src/core/usage/session-cost-pricing.ts
  src/providers/external-session-scan-core.ts
  src/providers/path-resolve-core.ts
  src/providers/port-scan-core.ts
  src/providers/task-dir-core.ts
  src/providers/task-dir-sizes.ts
  src/providers/transcript-archive.ts
  src/providers/transcript-remote-retry.ts
  src/providers/transcript-archive-names.ts
  src/providers/host-cache-prune.ts
  src/lib/task-dir.ts
  src/providers/pw-silence-core.ts
  src/providers/pw-noactivate-core.ts
  src/lib/machine-hold.ts
  src/providers/host-exec-core.ts
  src/providers/host-exec-line.ts
  src/providers/host-exec-guards.ts
  src/providers/host-exec-clt.ts
  src/providers/host-exec-watch.ts
  src/providers/host-exec-wait.ts
  src/providers/host-exec-probe.ts
  src/providers/host-exec-pattern.ts
  src/providers/host-exec-matcher.ts
  src/providers/host-exec-group.ts
  src/providers/host-exec-job.ts
  src/providers/host-script-core.ts
  src/providers/host-exec-script.ts
  src/providers/host-exec-recall.ts
  src/providers/host-exec-adopt.ts
  src/providers/detached-run.ts
  src/providers/detached-registry.ts
  src/providers/host-script-detached.ts
  src/providers/host-exec-run-id.ts
  src/providers/net-core.ts
  src/providers/net-binary.ts
  src/providers/net-config-core.ts
  src/providers/net-control.ts
  src/providers/machine-id-core.ts
  src/providers/host-mcp-core.ts
  src/providers/host-http-core.ts
  src/providers/host-reach-core.ts
  src/providers/secrets-core.ts
  src/providers/search-grep-core.ts
  src/providers/vscode-server-core.ts
  src/providers/transcript-rewind-core.ts
  src/providers/trigger-check-core.ts
  src/providers/trigger-envelope-core.ts
  src/providers/trigger-clock-core.ts
  src/providers/trigger-state-snapshot-core.ts
  src/providers/trigger-state-seed-core.ts
  src/providers/clock-schedule-core.ts
  src/core/cron/trigger-timing.ts
  src/core/transcript-chain.ts
  src/core/transcript-chain-leaf.ts
  src/providers/history-ready-core.ts
  src/providers/history-ready-worker.ts
  src/core/history-parse.ts
  src/core/history-parser-version.ts
  src/core/drained-sends.ts
  src/core/sessions/legacy-hint-lines.ts
  src/core/sessions/user-text-projection.ts
  src/core/hints/hint-format.ts
  src/core/org/message-about.ts
  src/core/sessions/cli-error-reply.ts
  src/core/sessions/prompt-cache.ts
  src/core/sessions/side-thread-digest.ts
  src/core/sessions/side-thread-warmup.ts
  src/core/sessions/walnut-commands.ts
  src/core/stream/compaction-notice.ts
  src/core/stream/hook-notice.ts
  src/core/text-cut.ts
  src/core/session-effort.ts
  src/lib/ai-only-envelope.ts
  src/lib/history-injected-banner.ts
  src/lib/history-session-envelope.ts
  src/lib/history-turn-window.ts
  src/lib/internal-lines.ts
  src/lib/history-walnut-riders.ts
  src/lib/turn-end-marker.ts
  src/lib/walnut-added.ts
  src/lib/composed-framing.ts
  src/lib/attachment-headers.ts
  src/core/transcript-chain-prefilter.ts
  src/core/bash-file-ops.ts
  src/providers/daemon-instance-lock.ts
  src/providers/daemon-command-drain.ts
  src/providers/demo-daemon-quiesce-core.ts
  src/providers/daemon-restart-mark.ts
  src/providers/daemon-cron-supervision.ts
  src/providers/daemon-cron-store.ts
  src/providers/daemon-cron-controller.ts
  src/providers/daemon-cron-schedule.ts
  src/providers/daemon-cron-transcript.ts
  src/providers/daemon-cron-observer.ts
  src/providers/daemon-cron-host.ts
  src/providers/daemon-cron-runtime.ts
  src/providers/daemon-cron-metadata.ts
  src/providers/daemon-spawn-barrier.ts
  src/providers/daemon-child-spawn.ts
  src/providers/session-tailer.ts
  src/providers/daemon-runtime-timers.ts
  src/providers/daemon-in-process-client.ts
  src/providers/daemon-runtime-types.ts
  src/providers/loop-budget.ts
  src/providers/spawn-pool.ts
  src/providers/session-spawn-files.ts
  src/providers/agent-file-chunk.ts
  src/providers/daemon-door.ts
  src/providers/daemon-service-config.ts
  src/providers/daemon-service-manager.ts
  src/providers/daemon-service-launchd.ts
  src/providers/daemon-service-systemd.ts
  src/providers/daemon-service-artifact.ts
  src/providers/daemon-busy-words.ts
  src/providers/daemon-service-cli.ts
  src/providers/daemon-over-busy.ts
  src/providers/daemon-service-ready.ts
  src/providers/daemon-boot-proof.ts
  src/binary/runtime-tree.ts
  src/binary/asset-archive.ts
  src/providers/daemon-cli-path.ts
  src/providers/daemon-service-handback.ts
  src/providers/daemon-update-standin.ts
  src/providers/daemon-update-shell.ts
  src/providers/daemon-live-sh.ts
  src/providers/daemon-service-boot-script.ts
  src/providers/daemon-service-cron.ts
  src/providers/daemon-service-cron-host.ts
  src/providers/daemon-service-scope.ts
  src/providers/daemon-service-state-move.ts
  src/providers/service-set.ts
  src/providers/service-set-choice.ts
  src/providers/service-set-remove.ts
  src/providers/daemon-service-uninstall-tail.ts
  src/providers/service-set-net.ts
  src/providers/daemon-serves.ts
  src/lib/account.ts
  src/lib/daemon-dir.ts
  src/providers/daemon-service-files.ts
  src/utils/file-lock.ts
  src/utils/write-gate.ts
  src/providers/daemon-service-system.ts
  src/providers/daemon-service-handover.ts
  src/providers/service-launcher-script.ts
  src/providers/service-launcher-control.ts
  src/providers/service-launcher-beat.ts
  src/providers/host-runtime-core.ts
  src/providers/session-shell.ts
  src/providers/host-fix-core.ts
  src/providers/claude-install-core.ts
  src/providers/claude-download-core.ts
  src/providers/dtach-build-core.ts
  src/providers/claude-check-core.ts
  src/providers/fs-ls-core.ts
  src/providers/claude-session-argv.ts
  src/providers/turn-snapshot-core.ts
  src/providers/turn-guard-core.ts
  src/providers/git-attribution-core.ts
  src/providers/git-commit-core.ts
  src/providers/offline-host-core.ts
  src/providers/offline-journal-core.ts
  src/providers/host-journal-core.ts
  src/core/peers/envelope-kit.ts
  src/core/sessions/send-rules.ts
  src/providers/leader-core.ts
  src/providers/walnut-scope-core.ts
  src/providers/served-walnuts-core.ts
  src/providers/gateway-identity-core.ts
  src/providers/held-catalogs-core.ts
  src/providers/live-settings-core.ts
  src/providers/offline-search-core.ts
  src/providers/offline-board-core.ts
  src/providers/host-replica-core.ts
  src/providers/attachment-copy-core.ts
  src/providers/follower-reads-core.ts
  src/providers/follower-gateway-core.ts
  src/providers/host-call-token-core.ts
  src/providers/host-call-client-core.ts
  src/providers/follower-trigger-delivery-core.ts
  src/providers/host-server-core.ts
  src/providers/plugin-jobs-core.ts
  src/providers/plugin-job-harness.ts
  src/providers/plugin-job-door.ts
  src/providers/stream-relay-core.ts
  src/providers/hub-forward-core.ts
  src/providers/pty-stream-core.ts
  src/providers/feature-relay-core.ts
  src/providers/host-resume-core.ts
  src/providers/cli-owner-core.ts
  src/providers/cli-argv-files-core.ts
  src/providers/host-start-core.ts
  src/providers/follower-entry-core.ts
  src/providers/file-pool-deadline.ts
  src/providers/registry-writer-core.ts
  src/providers/log-appender-core.ts
  src/binary/service-entry.ts
  src/binary/service-mode.ts
  src/binary/service-mode-lock.ts
  src/binary/service-mode-update.ts
  src/binary/service-start-hooks.ts
  src/binary/service-lead-ready.ts
  src/providers/service-roles.ts
  src/providers/clock-host-start-core.ts
  src/core/sessions/open-items-text.ts
  src/core/human-inbox/letter-check.ts
  src/core/routines/trigger-label.ts
  src/core/routines/trigger-watches.ts
  src/core/routines/host-trigger-target.ts
  src/providers/git-diff-core.ts
  src/providers/caller-proof-core.ts
  src/providers/socket-peer-pid.ts
  src/providers/bridge-uplink-core.ts
  src/providers/workspace-core.ts
  src/providers/line-fate-core.ts
  src/providers/marker-find-core.ts
  src/providers/replica-logs-core.ts
  src/providers/transfer-core.ts
  src/providers/transfer-pack-core.ts
  src/providers/host-facts-core.ts
  src/providers/host-vitals-core.ts
  src/providers/desktop-update-core.ts
  src/providers/stream-compact-core.ts
  src/providers/stream-fold-core.ts
  src/providers/oneshot-core.ts
  src/providers/user-line-images-core.ts
  src/providers/network-cause-core.ts
  src/core/types.ts
  src/core/experimental.ts
  src/core/inbox-project.ts
  src/lib/git-env.ts
  src/providers/path-ref-parse.ts
  src/providers/host-runtime-types.ts
  src/providers/codex-outside-core.ts
  src/providers/claude-outside-core.ts
)

# sha256 of daemon source files, per-file path + NUL + content + NUL, then
# truncated to 12 hex chars (48 bits) — enough uniqueness for this small file
# set, short in logs. The NUL separators prevent boundary collisions between
# files (shifting bytes between file A and B should yield a different hash).
#
# Keep in sync with daemon-version-check.ts:computeExpectedDaemonVersion().
# Both must hash the SAME bytes in the SAME order.
if command -v sha256sum >/dev/null 2>&1; then
  HASHER="sha256sum"
else
  HASHER="shasum -a 256"
fi
HASH=$(
  for f in "${SOURCES[@]}"; do
    # Fail loudly if a source file is missing.
    if [ ! -f "$f" ]; then
      echo "build-daemon.sh: missing source file: $f" >&2
      exit 1
    fi
    printf '%s\0' "$f"
    cat "$f"
    printf '\0'
  done | $HASHER | cut -c1-12
)
VERSION="walnut-daemon-${HASH}"
# WALNUT_DAEMON_SIDECARS_ONLY=1 builds only the JS artifacts below (ACP worker and
# adapters) into WALNUT_DAEMON_OUTDIR, without the three compiled daemons or
# dtach: the compiled Walnut file runs its own daemon (scripts/build-binary.mjs).
OUTDIR="${WALNUT_DAEMON_OUTDIR:-dist/daemon-binaries}"
SIDECARS_ONLY="${WALNUT_DAEMON_SIDECARS_ONLY:-0}"
mkdir -p "$OUTDIR"

if [ "$SIDECARS_ONLY" != 1 ]; then
# An ACP-files-only build's marker describes no binary: a full build leaves none
# behind (daemon-version-check.ts read a stale one as drift on every boot).
rm -f "$OUTDIR/daemon.version" "$OUTDIR/.version-guard-gave-up"
echo "Building daemon binaries (version: $VERSION)..."

bun_compile --target=bun-linux-x64 --minify \
  --define "process.env.DAEMON_VERSION='$VERSION'" \
  --outfile "$OUTDIR/daemon-linux-x64" \
  src/providers/daemon-standalone.ts src/providers/history-ready-worker.ts
echo "$VERSION" > "$OUTDIR/daemon-linux-x64.version"

bun_compile --target=bun-linux-arm64 --minify \
  --define "process.env.DAEMON_VERSION='$VERSION'" \
  --outfile "$OUTDIR/daemon-linux-arm64" \
  src/providers/daemon-standalone.ts src/providers/history-ready-worker.ts
echo "$VERSION" > "$OUTDIR/daemon-linux-arm64.version"

bun_compile --target=bun-darwin-arm64 --minify \
  --define "process.env.DAEMON_VERSION='$VERSION'" \
  --outfile "$OUTDIR/daemon-darwin-arm64" \
  src/providers/daemon-standalone.ts src/providers/history-ready-worker.ts
# Walnut's own fixed Mach-O UUID and identifier, so a Mac's Local Network choice
# for the daemon survives its updates (scripts/lib/macho-identity.mjs).
"$BUN" scripts/lib/macho-identity.mjs stamp "$OUTDIR/daemon-darwin-arm64" daemon-darwin-arm64 --where-signable
echo "$VERSION" > "$OUTDIR/daemon-darwin-arm64.version"

# The same daemon as a module a built server loads to run it in its own process (experiment
# in_process_daemon, src/providers/in-process-daemon.ts): plain ESM for Bun, not compiled, with
# its history-ready worker beside it. The compiled Walnut file carries its own and needs none.
rm -rf "$OUTDIR/daemon-runtime"
"$BUN" build --target=bun --format=esm --minify \
  --define "process.env.DAEMON_VERSION='$VERSION'" \
  --outdir "$OUTDIR/daemon-runtime" \
  src/providers/daemon-standalone.ts src/providers/history-ready-worker.ts
echo "$VERSION" > "$OUTDIR/daemon-runtime/daemon-standalone.js.version"
fi

# ACP worker artifact — a plain JS bundle (NOT bun-compiled): the daemon spawns
# it with the system `node`, and one bundle serves every platform.
"$BUN" build --minify --target=node \
  --outfile "$OUTDIR/acp-worker.js" \
  src/providers/acp-worker/worker-main.ts
echo "$VERSION" > "$OUTDIR/acp-worker.js.version"

# What the compiled walnut file carries so a host runs ACP engines itself
# (src/providers/acp-host-artifacts.ts ACP_HOST_FILES). The worker gets its own
# name: the compiled walnut file keeps a placeholder at acp-worker.js
# (src/binary/bundled-modules.ts). codex-acp is one self-contained ESM file; with
# CODEX_PATH set it needs nothing else.
cp "$OUTDIR/acp-worker.js" "$OUTDIR/acp-worker.mjs"
cp node_modules/@agentclientprotocol/codex-acp/dist/index.js "$OUTDIR/codex-acp.mjs"
cp node_modules/@agentclientprotocol/codex-acp/LICENSE "$OUTDIR/codex-acp.LICENSE"

if [ "$SIDECARS_ONLY" = 1 ]; then
  echo "$VERSION" > "$OUTDIR/daemon.version"
  echo "Done. Daemon ACP files (version: $VERSION) in $OUTDIR"
  exit 0
fi

# Prebuilt dtach for the session terminal, so a Mac without the Command Line Tools
# still gets a persistent shell (the tarball ships it; the big daemon binaries it
# sits next to do not). No compiler means one info line and no prebuilt, never a
# failed build: the terminal still compiles dtach on demand.
bash scripts/build-dtach.sh "$OUTDIR" \
  || echo "build-daemon.sh: the prebuilt dtach step failed; continuing (the terminal compiles dtach on demand)." >&2

# walnut-net, the host network connector the daemon runs (net-core.ts), for this
# machine, only on request (WALNUT_BUILD_NET=1, needs cargo): a daemon without one
# downloads the pinned release build the first time it is asked (net-binary.ts).
if [ "${WALNUT_BUILD_NET:-0}" = 1 ]; then
  bash scripts/build-walnut-net.sh \
    || echo "build-daemon.sh: the walnut-net step failed; continuing (the daemon downloads its release build)." >&2
fi

# The budget E2Es (tests/e2e/session-budget*.test.ts) run these artifacts only as this
# build made them: the manifest names their hashes and the sources' version. An ACP-files-only
# build, a machine whose daemon binary this build does not make, or a tree without the
# tests (a published package), writes none.
HOST_DAEMON="daemon-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/aarch64/arm64/' -e 's/x86_64/x64/')"
if [ "$SIDECARS_ONLY" != 1 ] && [ -f "$OUTDIR/$HOST_DAEMON.version" ] && [ -f tests/e2e/fixtures/budget-artifacts.ts ]; then
  BUDGET_MANIFEST_DIR="$OUTDIR" "$BUN" -e "const m = await import('./tests/e2e/fixtures/budget-artifacts.ts'); m.writeBudgetManifest(process.env.BUDGET_MANIFEST_DIR)" \
    || echo "build-daemon.sh: the budget E2E manifest was not written; those tests will say so." >&2
fi

# Invalidate stale .gz caches — DaemonConnection.deployBinary reuses them
# if present, which would ship an old binary under a new version label.
rm -f "$OUTDIR"/daemon-linux-*.gz

echo "Done. Binaries:"
ls -lh "$OUTDIR"/daemon-*
ls -lh "$OUTDIR"/dtach-* 2>/dev/null || true
ls -lh "$OUTDIR"/walnut-net-* 2>/dev/null || true

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
BUN=""
if walnut_find_bun "$PWD"; then BUN="$BUN_BIN"; fi
if [ -z "$BUN" ]; then
  # Bun only cross-compiles the daemon binaries, and a host without one still gets a
  # working daemon over the source-deploy fallback (daemon-connection.ts: "no binary
  # found, falling back to source deploy"). Failing here used to stop the first build dead
  # on any machine that had never installed Bun, which is every new user's machine.
  # Release flows set WALNUT_REQUIRE_BUN=1 so a published tarball can never miss them.
  echo "build-daemon.sh: $(walnut_bun_missing)" >&2
  if [ "${WALNUT_REQUIRE_BUN:-0}" = 1 ]; then
    echo "build-daemon.sh: WALNUT_REQUIRE_BUN=1 is set, so this is fatal. Install Bun: https://bun.sh" >&2
    exit 1
  fi
  echo "build-daemon.sh: skipping the daemon binaries. Walnut still runs: sessions deploy the daemon from source instead." >&2
  echo "build-daemon.sh: install Bun (https://bun.sh) and re-run \`bun run build:daemon\` to get the faster prebuilt path." >&2
  exit 0
fi

"$BUN" scripts/build-pi-acp.mjs

SOURCES=(
  src/providers/daemon-standalone.ts
  src/providers/daemon-core.ts
  src/providers/daemon-fold.ts
  src/providers/fold-checkpoint-core.ts
  src/providers/daemon-source.ts
  src/providers/daemon-capabilities.ts
  src/providers/gateway-core.ts
  src/providers/wn-cli.ts
  src/providers/tool-args-source.ts
  src/ops/op-help.ts
  src/providers/mcp-cli-args.ts
  src/providers/acp-daemon.ts
  src/providers/acp-thread-restore.ts
  src/providers/acp-host-artifacts.ts
  node_modules/@agentclientprotocol/codex-acp/package.json
  node_modules/@agentclientprotocol/codex-acp/dist/index.js
  src/providers/codex-model-probe.ts
  src/providers/agent-command-map.ts
  src/providers/acp-worker/worker.ts
  src/providers/acp-worker/worker-main.ts
  src/providers/acp-worker/journal.ts
  src/providers/acp-worker/protocol.ts
  src/logging/redact.ts
  src/providers/session-changes-core.ts
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
  src/providers/task-dir-core.ts
  src/lib/task-dir.ts
  src/providers/search-grep-core.ts
  src/providers/vscode-server-core.ts
  src/providers/transcript-rewind-core.ts
  src/providers/trigger-check-core.ts
  src/providers/trigger-envelope-core.ts
  src/providers/trigger-check-sidecar.ts
  src/providers/trigger-clock-core.ts
  src/providers/clock-schedule-core.ts
  src/core/cron/trigger-timing.ts
  src/core/transcript-chain.ts
  src/core/transcript-chain-leaf.ts
  src/core/transcript-chain-prefilter.ts
  src/core/bash-file-ops.ts
  src/providers/daemon-instance-lock.ts
  src/providers/daemon-command-drain.ts
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
  src/providers/daemon-service-config.ts
  src/providers/daemon-service-manager.ts
  src/providers/daemon-service-artifact.ts
  src/providers/daemon-service-cli.ts
  src/lib/account.ts
  src/lib/daemon-dir.ts
  src/providers/daemon-service-files.ts
  src/utils/file-lock.ts
  src/providers/daemon-service-system.ts
  src/providers/daemon-service-handover.ts
  src/providers/host-runtime-core.ts
  src/providers/host-fix-core.ts
  src/providers/claude-check-core.ts
  src/providers/fs-ls-core.ts
  src/providers/turn-snapshot-core.ts
  src/providers/turn-guard-core.ts
  src/providers/git-attribution-core.ts
  src/providers/git-commit-core.ts
  src/providers/offline-host-core.ts
  src/providers/offline-journal-core.ts
  src/core/peers/envelope-kit.ts
  src/providers/leader-core.ts
  src/providers/live-settings-core.ts
  src/providers/offline-search-core.ts
  src/providers/offline-board-core.ts
  src/providers/host-replica-core.ts
  src/providers/attachment-copy-core.ts
  src/providers/follower-reads-core.ts
  src/providers/host-server-core.ts
  src/providers/plugin-jobs-core.ts
  src/providers/plugin-job-harness.ts
  src/providers/stream-relay-core.ts
  src/providers/feature-relay-core.ts
  src/providers/host-resume-core.ts
  src/providers/cli-owner-core.ts
  src/providers/host-start-core.ts
  src/providers/clock-host-start-core.ts
  src/core/sessions/open-items-text.ts
  src/core/human-inbox/letter-check.ts
  src/providers/git-diff-core.ts
  src/providers/bridge-uplink-core.ts
  src/providers/workspace-core.ts
  src/providers/line-fate-core.ts
  src/providers/marker-find-core.ts
  src/providers/replica-logs-core.ts
  src/providers/transfer-core.ts
  src/providers/transfer-pack-core.ts
  src/providers/host-facts-core.ts
  src/providers/desktop-update-core.ts
  src/providers/stream-compact-core.ts
  src/providers/stream-fold-core.ts
  src/providers/oneshot-core.ts
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
# WALNUT_DAEMON_SIDECARS_ONLY=1 builds only the JS artifacts below (sidecars, ACP
# worker, pi-acp) into WALNUT_DAEMON_OUTDIR, without the three compiled daemons or
# dtach: the compiled Walnut file runs its own daemon (scripts/build-binary.mjs).
OUTDIR="${WALNUT_DAEMON_OUTDIR:-dist/daemon-binaries}"
SIDECARS_ONLY="${WALNUT_DAEMON_SIDECARS_ONLY:-0}"
mkdir -p "$OUTDIR"

if [ "$SIDECARS_ONLY" != 1 ]; then
echo "Building daemon binaries (version: $VERSION)..."

"$BUN" build --compile --target=bun-linux-x64 --minify \
  --define "process.env.DAEMON_VERSION='$VERSION'" \
  --outfile "$OUTDIR/daemon-linux-x64" \
  src/providers/daemon-standalone.ts
echo "$VERSION" > "$OUTDIR/daemon-linux-x64.version"

"$BUN" build --compile --target=bun-linux-arm64 --minify \
  --define "process.env.DAEMON_VERSION='$VERSION'" \
  --outfile "$OUTDIR/daemon-linux-arm64" \
  src/providers/daemon-standalone.ts
echo "$VERSION" > "$OUTDIR/daemon-linux-arm64.version"

"$BUN" build --compile --target=bun-darwin-arm64 --minify \
  --define "process.env.DAEMON_VERSION='$VERSION'" \
  --outfile "$OUTDIR/daemon-darwin-arm64" \
  src/providers/daemon-standalone.ts
echo "$VERSION" > "$OUTDIR/daemon-darwin-arm64.version"
fi

# ACP worker artifact — a plain JS bundle (NOT bun-compiled): the daemon spawns
# it with the system `node`, and one bundle serves every platform.
"$BUN" build --minify --target=node \
  --outfile "$OUTDIR/acp-worker.js" \
  src/providers/acp-worker/worker-main.ts
echo "$VERSION" > "$OUTDIR/acp-worker.js.version"

# What a remote deploy puts beside daemon.cjs so that host runs ACP engines itself
# (src/providers/acp-host-artifacts.ts ACP_HOST_FILES). The worker gets its own
# name: the compiled walnut file keeps a placeholder at acp-worker.js
# (src/binary/bundled-modules.ts). codex-acp is one self-contained ESM file; with
# CODEX_PATH set it needs nothing else.
cp "$OUTDIR/acp-worker.js" "$OUTDIR/acp-worker.mjs"
cp node_modules/@agentclientprotocol/codex-acp/dist/index.js "$OUTDIR/codex-acp.mjs"
cp node_modules/@agentclientprotocol/codex-acp/LICENSE "$OUTDIR/codex-acp.LICENSE"

# ACP supervision sidecar — the same acp-daemon.ts the binary compiles in, as a
# CJS bundle for the source template. The npm package ships no daemon binaries,
# so without this the local daemon of an npm install answered every acp*
# command with acp_unsupported and Codex, Gemini, OpenCode, Goose and Pi could
# not start. local-daemon.ts copies it next to daemon.cjs.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/acp-daemon-core.cjs" \
  src/providers/acp-daemon.ts

# Session-changes sidecar — a plain CJS bundle of session-changes-core.ts.
# Source-template daemons (bun deploys) can't import modules, so deploySource
# ships this next to daemon.cjs and the template require()s it lazily; the
# daemon advertises 'changes-v1' only when the sidecar loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/changes-core.cjs" \
  src/providers/session-changes-core.ts

"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/usage-core.cjs" \
  src/providers/usage-host-core.ts

# usage-core also exports the persistent budget runtime and control ACK helper.
# Both twins use the same accounting and pause policy; source deploy reuses this artifact.

# External-session scan sidecar — same rationale as changes-core.cjs: the
# source template can't import, so deploySource ships this next to daemon.cjs
# and the template require()s it; 'external-scan-v1' is advertised only when
# the sidecar loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/external-scan-core.cjs" \
  src/providers/external-session-scan-core.ts

# Layered path-resolution sidecar — same rationale as the two above: the
# transcript scan + git/find search can't live in the source template, so
# deploySource ships this next to daemon.cjs and the template require()s it;
# 'path-resolve-v1' is advertised only when the sidecar loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/path-resolve-core.cjs" \
  src/providers/path-resolve-core.ts

# Task directories sidecar: the repo checks before a removal run git, which the
# source template does not carry; 'task-dir-v1' is advertised only when it loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/task-dir-core.cjs" \
  src/providers/task-dir-core.ts

# Embedded VS Code sidecar — same rationale: install/spawn/health pipeline
# can't live in the source template; 'vscode-v1' is advertised only when the
# sidecar loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/vscode-server-core.cjs" \
  src/providers/vscode-server-core.ts

# Transcript rewind probe sidecar — same rationale: the chain walk + dead-set
# replay can't live in the source template; 'rewind-probe-v1' is advertised only
# when the sidecar loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/transcript-rewind-core.cjs" \
  src/providers/transcript-rewind-core.ts

# walnut-trigger check-contract sidecar — same rationale: the stdout parse, the
# dedup rules and the process-group runner can't live in the source template;
# 'triggers-v1' is advertised only when the sidecar loads. The entry adds the fire
# envelope, which the daemon builds for a fire no server claimed.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/trigger-check-core.cjs" \
  src/providers/trigger-check-sidecar.ts

"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/daemon-cron-runtime.cjs" \
  src/providers/daemon-cron-runtime.ts

"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/daemon-instance-lock.cjs" \
  src/providers/daemon-instance-lock.ts

"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/daemon-service-cli.cjs" \
  src/providers/daemon-service-cli.ts

if [ "$SIDECARS_ONLY" = 1 ]; then
  echo "$VERSION" > "$OUTDIR/daemon.version"
  echo "Done. Daemon sidecars (version: $VERSION) in $OUTDIR"
  exit 0
fi

# Prebuilt dtach for the session terminal, so a Mac without the Command Line Tools
# still gets a persistent shell (the tarball ships it; the big daemon binaries it
# sits next to do not). No compiler means one info line and no prebuilt, never a
# failed build: the terminal still compiles dtach on demand.
bash scripts/build-dtach.sh "$OUTDIR" \
  || echo "build-daemon.sh: the prebuilt dtach step failed; continuing (the terminal compiles dtach on demand)." >&2

# Invalidate stale .gz caches — DaemonConnection.deployBinary reuses them
# if present, which would ship an old binary under a new version label.
rm -f "$OUTDIR"/daemon-linux-*.gz

echo "Done. Binaries:"
ls -lh "$OUTDIR"/daemon-*
ls -lh "$OUTDIR"/dtach-* 2>/dev/null || true

#!/bin/bash
# Build cross-compiled daemon binaries for remote Linux hosts and local macOS.
# Requires Bun (https://bun.sh).
#
# Usage:
#   bash scripts/build-daemon.sh
#   npm run build:daemon
#
# Output:
#   dist/daemon-binaries/daemon-linux-x64
#   dist/daemon-binaries/daemon-linux-arm64
#   dist/daemon-binaries/daemon-darwin-arm64
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
BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      BUN="$candidate"
      break
    fi
  done
fi
if [ -z "$BUN" ]; then
  echo "build-daemon.sh: bun not found (checked PATH, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin)." >&2
  echo "Install Bun: https://bun.sh" >&2
  exit 1
fi

SOURCES=(
  src/providers/daemon-standalone.ts
  src/providers/daemon-core.ts
  src/providers/daemon-fold.ts
  src/providers/daemon-source.ts
  src/providers/gateway-core.ts
  src/providers/wn-cli.ts
  src/providers/acp-daemon.ts
  src/providers/acp-worker/worker.ts
  src/providers/acp-worker/worker-main.ts
  src/providers/acp-worker/journal.ts
  src/providers/acp-worker/protocol.ts
  src/providers/session-changes-core.ts
  src/providers/external-session-scan-core.ts
  src/providers/path-resolve-core.ts
  src/providers/search-grep-core.ts
  src/providers/vscode-server-core.ts
  src/core/bash-file-ops.ts
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
OUTDIR="dist/daemon-binaries"
mkdir -p "$OUTDIR"

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

# ACP worker artifact — a plain JS bundle (NOT bun-compiled): the daemon spawns
# it with the system `node`, and one bundle serves every platform. The ACP SDK
# and codex-acp adapter resolve from the walnut install's node_modules at
# runtime on the LOCAL host (MVP scope); the remote deploy phase will bundle
# the adapter too.
"$BUN" build --minify --target=node \
  --outfile "$OUTDIR/acp-worker.js" \
  src/providers/acp-worker/worker-main.ts
echo "$VERSION" > "$OUTDIR/acp-worker.js.version"

# Session-changes sidecar — a plain CJS bundle of session-changes-core.ts.
# Source-template daemons (bun deploys) can't import modules, so deploySource
# ships this next to daemon.cjs and the template require()s it lazily; the
# daemon advertises 'changes-v1' only when the sidecar loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/changes-core.cjs" \
  src/providers/session-changes-core.ts

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

# Embedded VS Code sidecar — same rationale: install/spawn/health pipeline
# can't live in the source template; 'vscode-v1' is advertised only when the
# sidecar loads.
"$BUN" build --minify --target=node --format=cjs \
  --outfile "$OUTDIR/vscode-server-core.cjs" \
  src/providers/vscode-server-core.ts

# Invalidate stale .gz caches — DaemonConnection.deployBinary reuses them
# if present, which would ship an old binary under a new version label.
rm -f "$OUTDIR"/daemon-linux-*.gz

echo "Done. Binaries:"
ls -lh "$OUTDIR"/daemon-*

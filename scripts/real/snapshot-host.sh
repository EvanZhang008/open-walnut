#!/usr/bin/env bash
# Snapshot of every Walnut / claude / bun / node process on the real host (pid, start time, command
# line), sorted, so a before and an after can be compared byte for byte. Processes whose command
# line names ~/c5e-real (what this test starts) are listed apart and left out of the comparison.
# Usage: scripts/real/snapshot-host.sh <out-file>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$1"
"$here/host-ssh.sh" 'LC_ALL=C ps -u "$(id -u)" -o pid= -o lstart= -o args= | grep -Ei "walnut|claude|bun|node|daemon|acp|ssh" | grep -v -E "grep -Ei|ps -u|sshd: .*@notty|bash -lc" | sort -n' > "$out.all"
grep -v 'c5e-real' "$out.all" > "$out" || true
grep 'c5e-real' "$out.all" > "$out.ours" || true
echo "production processes: $(wc -l < "$out"), ours: $(wc -l < "$out.ours")"

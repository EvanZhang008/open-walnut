#!/usr/bin/env bash
# Run a command on the real host under test (C5E_HOST, required) over ssh, in a login shell.
# Usage: scripts/real/host-ssh.sh '<command>'   (stdin is passed through)
set -euo pipefail
HOST="${C5E_HOST:?set C5E_HOST to the host under test}"
exec ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o LogLevel=ERROR -o ServerAliveInterval=15 "$HOST" "bash -lc $(printf '%q' "$1")"

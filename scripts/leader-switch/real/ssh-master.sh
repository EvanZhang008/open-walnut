#!/bin/sh
# Rehearsal (b): the one ssh connection to the other machine, held on the clouddev HOST (not in the dev container,
# which has no key and no known_hosts). The driver in the container sends every command and asks for every tunnel
# through this connection's control socket, so the container never authenticates, and a command that finds no
# connection fails instead of opening one (real-world.ts: ProxyCommand=/bin/false on every client).
#
#   sh scripts/leader-switch/real/ssh-master.sh open  <host> <socket>
#   sh scripts/leader-switch/real/ssh-master.sh check <host> <socket>
#   sh scripts/leader-switch/real/ssh-master.sh close <host> <socket>
#
# <socket> must be in a folder the dev container also mounts at the same path (the task's folder), and short: a
# unix socket path has at most 107 bytes on Linux, and ssh adds 17 while it makes it.
# `open` uses only what the account has: its key or agent, and its ~/.ssh/known_hosts with StrictHostKeyChecking=yes.
# When the host's key is not there it stops and says so; it never adds a host key, never asks for a password.
set -eu
CMD=${1:-}
HOST=${2:-}
SOCK=${3:-}
if [ -z "$CMD" ] || [ -z "$HOST" ] || [ -z "$SOCK" ]; then
  echo "usage: ssh-master.sh open|check|close <host> <socket>" >&2
  exit 2
fi
case "$CMD" in
  open)
    if [ ${#SOCK} -gt 90 ]; then echo "ssh-master: the socket path $SOCK is ${#SOCK} bytes: use one of at most 90" >&2; exit 2; fi
    # The name ssh looks the key up by (its HostKeyAlias or HostName, and a port other than 22), as `ssh -G` resolves it: no connection.
    eff=$(ssh -G "$HOST")
    name=$(echo "$eff" | awk '$1 == "hostkeyalias" {print $2; exit}')
    [ -n "$name" ] || name=$(echo "$eff" | awk '$1 == "hostname" {print $2; exit}')
    port=$(echo "$eff" | awk '$1 == "port" {print $2; exit}')
    [ "$port" = 22 ] || name="[$name]:$port"
    if ! ssh-keygen -F "$name" >/dev/null 2>&1; then
      echo "ssh-master: $HOST's host key ($name) is not in ~/.ssh/known_hosts. Nothing was done: this script never adds one." >&2
      exit 3
    fi
    mkdir -p "$(dirname "$SOCK")"
    chmod 700 "$(dirname "$SOCK")"
    ssh -M -N -f -S "$SOCK" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o LogLevel=ERROR "$HOST"
    ssh -S "$SOCK" -O check "$HOST"
    ;;
  check) ssh -S "$SOCK" -O check "$HOST" ;;
  close) ssh -S "$SOCK" -O exit "$HOST" ;;
  *) echo "ssh-master: unknown command $CMD" >&2; exit 2 ;;
esac

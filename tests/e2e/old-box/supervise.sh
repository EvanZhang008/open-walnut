#!/bin/bash
# What systemd does for walnut.service on a v0.6.17 box, in a container that has
# no systemd: run the unit's ExecStart as the walnut user with the unit's
# environment (the base unit, its EnvironmentFile, the harness and launcher
# drop-ins), and start it again 5 s after it ends (Restart=always, RestartSec=5).
# A restart is a SIGTERM to the main pid in /run/box/main.pid, which is all
# KillMode=process signals.
#
# The ExecStart line is /run/box/exec-start, so a test can do what a later run
# of setup.sh does to the unit (another runtime, another launcher) and restart.
# Also starts the front door, the stand-in for Caddy: :8080 to 127.0.0.1:3456.
set -uo pipefail
LIB=/var/lib/walnut
mkdir -p /run/box
[ -f /run/box/exec-start ] || printf '%s\n' \
  "/bin/sh -c 'if [ -f /opt/walnut/scripts/cloud/companion-launch.mjs ]; then exec /usr/local/bin/node /opt/walnut/scripts/cloud/companion-launch.mjs web --port 3456; else exec /usr/local/bin/node /opt/walnut/dist/cli.js web --port 3456; fi'" \
  > /run/box/exec-start

# Its own copy: the mounted /box may be readable by root alone.
install -m 644 /box/front-door.mjs /run/box/front-door.mjs
setpriv --reuid=nobody --regid=nogroup --clear-groups -- /usr/local/bin/node /run/box/front-door.mjs &

stopping=0
main=0
trap 'stopping=1; [ "$main" -gt 1 ] && kill -TERM "$main" 2>/dev/null' TERM INT

# The unit's environment: systemd's own for User=walnut, then the unit's.
unit_env() {
  printf '%s\n' \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME="$LIB" USER=walnut LOGNAME=walnut LANG=C.UTF-8 \
    WALNUT_CLOUD_MODE=1 NODE_ENV=production \
    OPEN_WALNUT_HOME="$LIB/.open-walnut" WALNUT_GIT_HUB_DIR="$LIB/git" \
    WALNUT_SETUP_TOKEN_FILE=/etc/walnut/claim/setup-token
  # EnvironmentFile=-/etc/walnut/walnut.env: KEY=VALUE lines, no shell expansion.
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /etc/walnut/walnut.env 2>/dev/null || true
  # harness.conf and launcher.conf (ensure-harness.sh).
  printf '%s\n' SHELL=/bin/bash WALNUT_COMPANION_MAC_BUILDS=1
}

while [ "$stopping" = 0 ]; do
  env_args=()
  while IFS= read -r line; do env_args+=("$line"); done < <(unit_env)
  cmd="$(cat /run/box/exec-start)"
  printf '[supervise] starting walnut.service: %s\n' "$cmd"
  (cd /opt/walnut && exec setpriv --reuid=walnut --regid=walnut --init-groups -- env -i "${env_args[@]}" /bin/sh -c "exec $cmd") &
  main=$!
  printf '%s\n' "$main" > /run/box/main.pid
  wait "$main"
  code=$?
  # A trap ends the wait early; wait again for the process itself.
  while kill -0 "$main" 2>/dev/null; do wait "$main"; code=$?; done
  printf '[supervise] walnut.service main process %s exited with %s\n' "$main" "$code"
  rm -f /run/box/main.pid
  [ "$stopping" = 0 ] && sleep "${RESTART_SEC:-5}"
done

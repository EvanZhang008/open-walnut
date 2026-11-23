#!/bin/bash
# The main process of a Walnut host container (docs/reference/kubernetes-hosts.md).
#
# Runs as root only to do what cron needs, then everything Walnut does runs as the user:
#   1. the home volume belongs to the user, and a new one gets the shell's start files;
#   2. the crontab directory lives on the volume, so the daemon's @reboot line (written by
#      `walnut daemon install`) is there on every start;
#   3. cron starts, which runs that line: the daemon comes back with everything the volume holds;
#   4. a home that never joined joins once, with the invite mounted at $WALNUT_POD_JOIN_FILE;
#   5. the user's own start scripts run ($HOME/.config/walnut-pod/boot.d/*);
#   6. it then waits on cron: cron ending ends the container, and Kubernetes starts it again.
# A stop (the pod deleted, its node drained) is a shutdown: every process gets TERM and the
# user's processes get $WALNUT_POD_STOP_SECONDS to end, so sessions save and stop cleanly.
#
# The home is the user's, so every step here that runs as root treats what it finds there as
# untrusted: it never follows a link the user could have put in its way, keeps only what root
# itself made, and opens no file there. No process of the user's runs while steps 1 and 2 do
# (a container starts empty, and the volume is mounted by this pod only); from step 3 on they
# do, and root only reads the home (the join's state, the start scripts' names).
set -u

U="${WALNUT_POD_USER:-walnut}"
H="$(getent passwd "$U" | cut -d: -f6)"
JOIN_FILE="${WALNUT_POD_JOIN_FILE:-/etc/walnut-join/invite}"
STOP_SECONDS="${WALNUT_POD_STOP_SECONDS:-45}"
POD_DIR="$H/.walnut-pod"
NET_CONFIG="$H/.local/state/open-walnut/net/config.json"

log() { printf '%s walnut-pod: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
as_user() { runuser -u "$U" -- env -i HOME="$H" USER="$U" LOGNAME="$U" SHELL=/bin/bash \
  LANG="${LANG:-C.UTF-8}" PATH="$H/.local/bin:/usr/local/bin:/usr/bin:/bin" bash -lc "$1"; }
# A directory root must own, as root made it: a link, a file, or a directory of anyone else's
# (the user can rename root's away and make their own) is moved aside, never followed or kept.
root_dir_ok() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u "$1")" = 0 ]; }
set_aside() { mv -f -- "$1" "$1.moved-$(date -u +%Y%m%dT%H%M%SZ)"; log "moved $1 aside: it was not root's own directory"; }

if [ -z "$H" ] || [ ! -d "$H" ] || [ -L "$H" ]; then log "no home for $U (mount the volume at its home)"; exit 1; fi

# 1. A new volume is root's and empty. The start files are copied as the user, so a link
# there points the copy at nothing the user could not write anyway.
if [ "$(stat -c %U "$H")" != "$U" ]; then chown -h "$U:$U" "$H"; log "gave $H to $U"; fi
for f in .bashrc .profile .bash_logout; do
  if [ ! -e "$H/$f" ] && [ ! -L "$H/$f" ] && [ -e "/etc/skel/$f" ]; then runuser -u "$U" -- cp -n "/etc/skel/$f" "$H/$f"; fi
done

# 2. cron reads /var/spool/cron/crontabs; keep it on the volume. cron refuses a crontab that is
# not its user's own file with mode 0600, and the directory must be root:crontab 1730.
if { [ -e "$POD_DIR" ] || [ -L "$POD_DIR" ]; } && ! root_dir_ok "$POD_DIR"; then set_aside "$POD_DIR"; fi
[ -e "$POD_DIR" ] || mkdir "$POD_DIR"
chmod 0755 "$POD_DIR"
if { [ -e "$POD_DIR/crontabs" ] || [ -L "$POD_DIR/crontabs" ]; } && ! root_dir_ok "$POD_DIR/crontabs"; then set_aside "$POD_DIR/crontabs"; fi
[ -e "$POD_DIR/crontabs" ] || mkdir "$POD_DIR/crontabs"
chown -h root:crontab "$POD_DIR/crontabs"; chmod 1730 "$POD_DIR/crontabs"
CRONTAB="$POD_DIR/crontabs/$U"
if [ -f "$CRONTAB" ] && [ ! -L "$CRONTAB" ]; then chown -h "$U:crontab" "$CRONTAB"; chmod 0600 "$CRONTAB"; fi
if [ ! -L /var/spool/cron/crontabs ]; then
  rm -rf /var/spool/cron/crontabs
  ln -s "$POD_DIR/crontabs" /var/spool/cron/crontabs
fi

# 3. cron, in the foreground, as this script's child. Debian's cron runs @reboot lines only
# when its marker is missing; a container started again in place (docker restart) still has it.
rm -f /run/crond.reboot
cron -f &
CRON_PID=$!

stop_all() {
  trap '' TERM INT
  log "stopping: every process gets TERM, as at a shutdown"
  # -1: every process this container's root may signal, except tini (PID 1) and this script.
  # The container has its own process namespace, so nothing outside it is reached.
  kill -TERM -1 2>/dev/null
  waited=0
  while [ "$waited" -lt "$STOP_SECONDS" ] && pgrep -u "$U" >/dev/null; do sleep 1; waited=$((waited + 1)); done
  if pgrep -u "$U" >/dev/null; then log "still running after ${waited}s: $(pgrep -u "$U" -l | tr '\n' ' ')"; else log "every process of $U ended in ${waited}s"; fi
  kill -TERM "$CRON_PID" 2>/dev/null
  wait "$CRON_PID" 2>/dev/null
  exit 0
}
trap stop_all TERM INT

sleep 1
if ! kill -0 "$CRON_PID" 2>/dev/null; then log "cron did not start"; exit 1; fi
if [ -f "$CRONTAB" ]; then log "cron started; it starts the Walnut daemon from $U's crontab"; fi

# 4. Join once. An invite is one use: a failed join is not tried again until the pod restarts
# with a new one (Settings > Remote Hosts > Add a machine makes it).
if [ -s "$NET_CONFIG" ]; then
  log "joined before: this host keeps its network key in $H"
elif [ -s "$JOIN_FILE" ]; then
  invite="$(tr -d '[:space:]' < "$JOIN_FILE")"
  # Only the characters a link or a ticket has: the value goes into a shell line.
  case "$invite" in
    *[!A-Za-z0-9._~:/?=\&%+-]*) cmd="" ;;
    https://*) cmd="curl -fsSL '$invite' | sh" ;;
    wn1-*) cmd="curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/join.sh | sh -s -- '$invite'" ;;
    *) cmd="" ;;
  esac
  if [ -z "$cmd" ]; then
    log "the invite in $JOIN_FILE is neither a join link (https://...) nor a ticket (wn1-...)"
  else
    log "joining the host network with the invite in $JOIN_FILE"
    # pipefail: a download that fails must fail the join, not hand sh an empty script.
    # In the background, waited on: a stop during the join runs stop_all at once, so the
    # join's processes get TERM too.
    as_user "set -o pipefail; $cmd" &
    if wait "$!"; then log "joined"; else log "the join failed; make a new invite, put it in the secret and restart the pod"; fi
  fi
else
  log "not joined yet and no invite at $JOIN_FILE"
fi

# 5. The user's own start scripts, each in the background. The user writes their output, to
# a file of the user's.
if [ -d "$H/.config/walnut-pod/boot.d" ]; then
  for s in "$H"/.config/walnut-pod/boot.d/*; do
    [ -f "$s" ] && [ -x "$s" ] || continue
    log "start script: $s (output in ~/.local/state/walnut-pod/boot.log)"
    as_user "mkdir -p ~/.local/state/walnut-pod && exec '$s' >>~/.local/state/walnut-pod/boot.log 2>&1" &
  done
fi

# 6. A TERM runs stop_all, which ends the script.
wait "$CRON_PID"
status=$?
log "cron ended ($status)"
exit "$status"

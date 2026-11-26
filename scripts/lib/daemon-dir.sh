# shellcheck shell=sh
# Where this machine's Walnut keeps its runtime files, by the server's rule (src/lib/daemon-dir.ts;
# tests/scripts/daemon-dir-sh.test.ts runs both on the same cases). Two places:
#
#   walnut_log_dir     the server's logs and scratch: WALNUT_DAEMON_DIR when it names a dir of its
#                      own (not one of the two below, which a daemon hands to its sessions); else
#                      /tmp/open-walnut, unless another user owns it (or it is a symlink or a file,
#                      or it is free and another account's system unit runs its daemon there), then
#                      $HOME/.cache/open-walnut.
#   walnut_daemon_dir  the local session daemon's own files (daemon.port, daemon.pid, sessions.json,
#                      its logs): WALNUT_DAEMON_DIR when set; else the dir a daemon of ours runs in
#                      (/tmp/open-walnut, then $HOME/.cache/open-walnut; a pid file from before the
#                      last boot is no daemon); else the one a login service of ours pins; else the
#                      one a daemon of ours wrote its files in since this machine booted (the later
#                      one when both); else $HOME/.cache/open-walnut, which no temp cleanup empties;
#                      /tmp/open-walnut only when the home dir cannot hold the daemon.
#
# Root, and a shell with no $HOME, get /tmp/open-walnut for both.
# Usage: dir="$(walnut_log_dir)"; ddir="$(walnut_daemon_dir)"
# Test seams, never set otherwise: _WD_SHARED (the shared dir), _WD_BOOT (boot time, seconds),
# _WD_ETC (where /etc/systemd/system is).

_wd_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# Boot time in seconds: Linux /proc/stat, macOS kern.boottime. Empty: not checked.
_wd_boot_time() {
  if [ -n "${_WD_BOOT:-}" ]; then printf '%s\n' "$_WD_BOOT"; return; fi
  _wd_b=$(sed -n 's/^btime //p' /proc/stat 2>/dev/null)
  [ -n "$_wd_b" ] || _wd_b=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ *sec = \([0-9]*\).*/\1/p')
  printf '%s\n' "$_wd_b"
}

# $HOME/.cache/open-walnut, or nothing for root and a shell with no absolute $HOME.
_wd_home_dir() {
  case "${HOME:-}" in /*) ;; *) return ;; esac
  [ "$(id -u 2>/dev/null)" != 0 ] || return
  printf '%s\n' "${HOME%/}/.cache/open-walnut"
}

# A dir that is ours: a real directory this user owns.
_wd_ours() { [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }

# A system unit of another account pins $1.
_wd_other_account_pins() {
  _wd_unit="${_WD_ETC:-/etc/systemd/system}/open-walnut-daemon.service"
  grep -qsxF "Environment=\"WALNUT_DAEMON_DIR=$1\"" "$_wd_unit" \
    && grep -qs '^User=' "$_wd_unit" \
    && ! grep -qsx "User=\($(id -un 2>/dev/null)\|$(id -u 2>/dev/null)\)" "$_wd_unit"
}

# A login service of ours pins $1: the LaunchAgent (its WALNUT_DAEMON_DIR key, never another
# key's value), the user unit, a system unit that runs this account, or the cron boot script.
_wd_service_pins() {
  _wd_unit="${_WD_ETC:-/etc/systemd/system}/open-walnut-daemon.service"
  _wd_plist="$HOME/Library/LaunchAgents/dev.openwalnut.session-daemon.plist"
  { [ -r "$_wd_plist" ] && sed -e ':a' -e 'N' -e '$!ba' -e 's/>[[:space:]]*</></g' "$_wd_plist" 2>/dev/null \
      | grep -qF "<key>WALNUT_DAEMON_DIR</key><string>$1</string>"; } \
    || grep -qsxF "Environment=\"WALNUT_DAEMON_DIR=$1\"" "$HOME/.config/systemd/user/open-walnut-daemon.service" \
    || grep -qsxF "export WALNUT_DAEMON_DIR='$1'" "$HOME/.local/share/open-walnut/daemon/daemon-boot.sh" \
    || { grep -qsxF "Environment=\"WALNUT_DAEMON_DIR=$1\"" "$_wd_unit" \
      && { ! grep -qs '^User=' "$_wd_unit" || grep -qsx "User=\($(id -un 2>/dev/null)\|$(id -u 2>/dev/null)\)" "$_wd_unit"; }; }
}

# Why the shared dir is not ours to use, or nothing when it is.
_wd_shared_problem() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    _wd_ours "$1" || printf 'taken\n'
  elif _wd_other_account_pins "$1"; then
    printf 'pinned\n'
  fi
}

# A daemon of ours runs in $1 (boot time $2).
_wd_live() {
  _wd_ours "$1" && [ -O "$1/daemon.pid" ] && [ -s "$1/daemon.port" ] || return 1
  _wd_p=$(cat "$1/daemon.pid" 2>/dev/null)
  _wd_m=$(_wd_mtime "$1/daemon.pid")
  if [ -n "$2" ] && [ -n "$_wd_m" ] && [ "$_wd_m" -lt $(($2 - 5)) ] 2>/dev/null; then return 1; fi
  [ -n "$_wd_p" ] && [ "$_wd_p" -gt 1 ] 2>/dev/null && kill -0 "$_wd_p" 2>/dev/null
}

# When a daemon of ours last wrote its files in $1 since the boot ($2), in seconds, or 0.
_wd_used() {
  _wd_new=0
  if _wd_ours "$1"; then
    for _wd_n in daemon.instance sessions.json agent-gateway.sock daemon.port daemon.pid; do
      _wd_f="$1/$_wd_n"
      { [ -e "$_wd_f" ] && [ ! -d "$_wd_f" ] && [ ! -L "$_wd_f" ] && [ -O "$_wd_f" ]; } || continue
      _wd_m=$(_wd_mtime "$_wd_f")
      [ -n "$_wd_m" ] || continue
      if [ -n "$2" ] && [ "$_wd_m" -lt $(($2 - 5)) ] 2>/dev/null; then continue; fi
      [ "$_wd_m" -gt "$_wd_new" ] 2>/dev/null && _wd_new=$_wd_m
    done
  fi
  printf '%s\n' "$_wd_new"
}

# The home dir can hold the daemon: its longest socket path fits, and it (or its nearest parent
# that exists) is a directory this user can write.
_wd_home_usable() {
  _wd_sock="$1/host-call/0123456789abcdef.sock"
  [ "$(printf '%s' "$_wd_sock" | LC_ALL=C wc -c | tr -d ' ')" -le 100 ] || return 1
  _wd_at=$1
  while [ ! -e "$_wd_at" ] && [ "$_wd_at" != / ] && [ -n "$_wd_at" ]; do _wd_at=$(dirname "$_wd_at"); done
  [ -d "$_wd_at" ] && [ -w "$_wd_at" ] && [ -x "$_wd_at" ]
}

walnut_log_dir() {
  _wd_shared=${_WD_SHARED:-/tmp/open-walnut}
  _wd_cache=$(_wd_home_dir)
  # A WALNUT_DAEMON_DIR that names one of the two production dirs is the daemon's own dir, which
  # it hands to every session it starts: it names no log dir.
  if [ -n "${WALNUT_DAEMON_DIR:-}" ] && [ "${WALNUT_DAEMON_DIR%/}" != "$_wd_shared" ] && [ "${WALNUT_DAEMON_DIR%/}" != "${HOME%/}/.cache/open-walnut" ]; then
    printf '%s\n' "$WALNUT_DAEMON_DIR"; return
  fi
  [ -n "$_wd_cache" ] || { printf '%s\n' "$_wd_shared"; return; }
  if [ -n "$(_wd_shared_problem "$_wd_shared")" ]; then printf '%s\n' "$_wd_cache"; else printf '%s\n' "$_wd_shared"; fi
}

walnut_daemon_dir() {
  if [ -n "${WALNUT_DAEMON_DIR:-}" ]; then printf '%s\n' "$WALNUT_DAEMON_DIR"; return; fi
  _wd_shared=${_WD_SHARED:-/tmp/open-walnut}
  _wd_cache=$(_wd_home_dir)
  [ -n "$_wd_cache" ] || { printf '%s\n' "$_wd_shared"; return; }
  _wd_boot=$(_wd_boot_time)
  for _wd_d in "$_wd_shared" "$_wd_cache"; do
    if _wd_live "$_wd_d" "$_wd_boot"; then printf '%s\n' "$_wd_d"; return; fi
  done
  if _wd_service_pins "$_wd_cache"; then printf '%s\n' "$_wd_cache"; return; fi
  _wd_problem=$(_wd_shared_problem "$_wd_shared")
  if [ -z "$_wd_problem" ] && _wd_service_pins "$_wd_shared"; then printf '%s\n' "$_wd_shared"; return; fi
  _wd_us=$(_wd_used "$_wd_shared" "$_wd_boot")
  _wd_uh=$(_wd_used "$_wd_cache" "$_wd_boot")
  if [ "$_wd_us" -gt "$_wd_uh" ] 2>/dev/null; then printf '%s\n' "$_wd_shared"; return; fi
  if [ "$_wd_uh" -gt 0 ] 2>/dev/null; then printf '%s\n' "$_wd_cache"; return; fi
  if _wd_home_usable "$_wd_cache"; then printf '%s\n' "$_wd_cache"; return; fi
  if [ -z "$_wd_problem" ]; then printf '%s\n' "$_wd_shared"; else printf '%s\n' "$_wd_cache"; fi
}

# shellcheck shell=sh
# Where this machine's Walnut keeps its logs and its local daemon's files, by the
# server's rule (src/lib/daemon-dir.ts): WALNUT_DAEMON_DIR when set; else
# /tmp/open-walnut, unless another user owns it (or it is a symlink or a file),
# then $HOME/.cache/open-walnut; a daemon of ours running in either keeps its dir
# (a pid file from before the last boot is no daemon), and so does a login service
# of ours that pins the home one; a free /tmp/open-walnut that another account's
# system unit pins is left to it. Root, and a shell with no $HOME, get /tmp/open-walnut.
# Usage: dir="$(walnut_daemon_dir)"
walnut_daemon_dir() {
  if [ -n "${WALNUT_DAEMON_DIR:-}" ]; then printf '%s\n' "$WALNUT_DAEMON_DIR"; return; fi
  _wd_shared=/tmp/open-walnut
  _wd_cache=
  case "${HOME:-}" in /*) _wd_cache="${HOME%/}/.cache/open-walnut" ;; esac
  [ -n "$_wd_cache" ] && [ "$(id -u 2>/dev/null)" != 0 ] || { printf '%s\n' "$_wd_shared"; return; }
  # Boot time in seconds: Linux /proc/stat, macOS kern.boottime. Empty: not checked.
  _wd_boot=$(sed -n 's/^btime //p' /proc/stat 2>/dev/null)
  [ -n "$_wd_boot" ] || _wd_boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ *sec = \([0-9]*\).*/\1/p')
  for _wd_d in "$_wd_shared" "$_wd_cache"; do
    if [ -d "$_wd_d" ] && [ ! -L "$_wd_d" ] && [ -O "$_wd_d" ] && [ -O "$_wd_d/daemon.pid" ] && [ -s "$_wd_d/daemon.port" ]; then
      _wd_p=$(cat "$_wd_d/daemon.pid" 2>/dev/null)
      _wd_m=$(stat -c %Y "$_wd_d/daemon.pid" 2>/dev/null || stat -f %m "$_wd_d/daemon.pid" 2>/dev/null)
      if [ -n "$_wd_boot" ] && [ -n "$_wd_m" ] && [ "$_wd_m" -lt $((_wd_boot - 5)) ] 2>/dev/null; then continue; fi
      if [ -n "$_wd_p" ] && [ "$_wd_p" -gt 1 ] 2>/dev/null && kill -0 "$_wd_p" 2>/dev/null; then printf '%s\n' "$_wd_d"; return; fi
    fi
  done
  if grep -qsF "<string>$_wd_cache</string>" "$HOME/Library/LaunchAgents/dev.openwalnut.session-daemon.plist" \
    || grep -qsxF "Environment=\"WALNUT_DAEMON_DIR=$_wd_cache\"" "$HOME/.config/systemd/user/open-walnut-daemon.service" \
    || { grep -qsxF "Environment=\"WALNUT_DAEMON_DIR=$_wd_cache\"" /etc/systemd/system/open-walnut-daemon.service \
      && grep -qsx "User=\($(id -un 2>/dev/null)\|$(id -u 2>/dev/null)\)" /etc/systemd/system/open-walnut-daemon.service; }; then
    printf '%s\n' "$_wd_cache"; return
  fi
  if [ -e "$_wd_shared" ] || [ -L "$_wd_shared" ]; then
    if [ ! -d "$_wd_shared" ] || [ -L "$_wd_shared" ] || [ ! -O "$_wd_shared" ]; then printf '%s\n' "$_wd_cache"; return; fi
  elif grep -qsxF "Environment=\"WALNUT_DAEMON_DIR=$_wd_shared\"" /etc/systemd/system/open-walnut-daemon.service \
    && grep -qs '^User=' /etc/systemd/system/open-walnut-daemon.service \
    && ! grep -qsx "User=\($(id -un 2>/dev/null)\|$(id -u 2>/dev/null)\)" /etc/systemd/system/open-walnut-daemon.service; then
    printf '%s\n' "$_wd_cache"; return
  fi
  printf '%s\n' "$_wd_shared"
}

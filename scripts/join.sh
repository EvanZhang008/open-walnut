#!/bin/sh
# Walnut: add this machine to your Walnut machines, with the ticket your Mac shows.
# Usage: curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/join.sh | sh -s -- wn1-...
# It installs Walnut when it is not here, keeps it running, and joins this machine.
set -eu
WALNUT_JOIN_TICKET=${1:-}
case "$WALNUT_JOIN_TICKET" in
  wn1-*) ;;
  *) printf '%s\n' "Run the command your Mac shows under Settings > Remote Hosts > Add a machine." >&2; exit 1 ;;
esac

walnut_join_fail() { printf '\n%s\n' "$1" >&2; exit 1; }

walnut_join_main() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) walnut_join_fail "This machine runs $(uname -s): Walnut machines are macOS or Linux for now." ;;
  esac
  printf 'Walnut: adding this machine to your Walnut machines\n'
  # The Walnut file install.sh puts here: the login service needs it (step 2), so another
  # Walnut on PATH (an npm install, an older server's) is never used, nor updated.
  # WALNUT_JOIN_WALNUT names another for a test.
  W="${WALNUT_JOIN_WALNUT:-${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}/bin/walnut}"
  if [ -x "$W" ] && "$W" net join --help 2>/dev/null | grep -q ticket; then
    printf '  1/3  Walnut ............ installed (%s)\n' "$("$W" --version 2>/dev/null | head -n 1)"
  else
    printf '  1/3  Walnut ............ installing\n'
    if [ -x "$W" ]; then "$W" update >/dev/null 2>&1 || true; fi
    if [ ! -x "$W" ] || ! "$W" net join --help 2>/dev/null | grep -q ticket; then
      # Fetched first: `curl | sh` reads a failed download as an empty script and succeeds.
      walnut_join_inst=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/walnut-join-install.$$")
      if ! curl -fsSL "${WALNUT_JOIN_INSTALL_URL:-https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh}" -o "$walnut_join_inst"; then
        rm -f "$walnut_join_inst"
        walnut_join_fail "Could not download Walnut's installer (above). Check this machine is online, then run this again."
      fi
      # Another Walnut's walnut in ~/.local/bin (an npm install's, a wrapper its owner wrote,
      # or the session daemon's script that hands over to another walnut on this machine)
      # stays as it is: an installer older than the one that knows to leave it would point it
      # at this install, so this one's links then go inside the install instead.
      walnut_join_dir="${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}"
      walnut_join_bin="${OPEN_WALNUT_BIN_DIR:-$HOME/.local/bin}"
      walnut_join_links=""
      for walnut_join_n in walnut open-walnut; do
        walnut_join_f="$walnut_join_bin/$walnut_join_n"
        [ -e "$walnut_join_f" ] || continue
        [ "$walnut_join_f" -ef "$walnut_join_dir/bin/walnut" ] && continue
        case "$(readlink "$walnut_join_f" 2>/dev/null || true)" in "$walnut_join_dir"/*) continue ;; esac
        if [ ! -L "$walnut_join_f" ] && [ "$(wc -c < "$walnut_join_f" | tr -d ' ')" -le 16384 ] && grep -q 'walnut-user''-shim v1' "$walnut_join_f" 2>/dev/null; then
          # That script runs the first other walnut it finds: one there means another Walnut.
          for walnut_join_d in $(printf '%s' "$PATH" | tr ':' ' ') /opt/homebrew/bin /usr/local/bin "$HOME/.npm-global/bin" "$HOME/bin"; do
            [ "$walnut_join_d" != "$walnut_join_bin" ] && [ -x "$walnut_join_d/walnut" ] && ! grep -q 'walnut-user''-shim' "$walnut_join_d/walnut" 2>/dev/null && { walnut_join_links=1; break; }
          done
        else
          walnut_join_links=1
        fi
        [ -n "$walnut_join_links" ] && break
      done
      [ -z "$walnut_join_links" ] || walnut_join_bin="$walnut_join_dir/links"
      # Off: no rc file is told to put links/ first on PATH.
      if ! OPEN_WALNUT_BIN_DIR="$walnut_join_bin" OPEN_WALNUT_MODIFY_PATH=0 sh "$walnut_join_inst" >"$walnut_join_inst.log" 2>&1; then
        cat "$walnut_join_inst.log" >&2
        rm -f "$walnut_join_inst" "$walnut_join_inst.log"
        walnut_join_fail "Walnut did not install (above). Run this again, or install it by hand: curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh"
      fi
      rm -f "$walnut_join_inst" "$walnut_join_inst.log"
      [ -x "$W" ] || walnut_join_fail "Walnut installed, but not in $W. Run this again."
    fi
    if ! "$W" net join --help 2>/dev/null | grep -q ticket; then
      # The release is older than the Walnut that made this invite (a feature reaches the
      # release a day or two after the preview build): the preview build can join, and
      # this machine follows the preview builds from then on. The update check's off
      # switches would make the update a quiet no-op, so they are cleared for it.
      printf '  1/3  Walnut ............ the release cannot join yet, installing the preview build (it then updates with those)\n'
      walnut_join_log=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/walnut-join-update.$$")
      WALNUT_NO_UPDATE_CHECK= NO_UPDATE_NOTIFIER= "$W" update --channel nightly >"$walnut_join_log" 2>&1 || true
      if ! "$W" net join --help 2>/dev/null | grep -q ticket; then
        cat "$walnut_join_log" >&2
        rm -f "$walnut_join_log"
        walnut_join_fail "This Walnut ($("$W" --version 2>/dev/null | head -n 1)) is too old to join, and the preview build did not install (above). Run: $W update --channel nightly, then this again."
      fi
      rm -f "$walnut_join_log"
    fi
    printf '  1/3  Walnut ............ installed (%s)\n' "$("$W" --version 2>/dev/null | head -n 1)"
  fi
  exec "$W" net join "$WALNUT_JOIN_TICKET" --steps
}

walnut_join_main

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

walnut_join_find() {
  for w in "$(command -v walnut 2>/dev/null || true)" "$HOME/.local/bin/walnut" "$HOME/.local/share/open-walnut/bin/walnut"; do
    if [ -n "$w" ] && [ -x "$w" ]; then printf '%s' "$w"; return 0; fi
  done
  return 1
}

walnut_join_main() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) walnut_join_fail "This machine runs $(uname -s): Walnut machines are macOS or Linux for now." ;;
  esac
  printf 'Walnut: adding this machine to your Walnut machines\n'
  if W=$(walnut_join_find) && "$W" net join --help 2>/dev/null | grep -q ticket; then
    printf '  1/3  Walnut ............ installed (%s)\n' "$("$W" --version 2>/dev/null | head -n 1)"
  else
    printf '  1/3  Walnut ............ installing\n'
    if W=$(walnut_join_find); then
      "$W" update >/dev/null 2>&1 || true
    fi
    if ! W=$(walnut_join_find) || ! "$W" net join --help 2>/dev/null | grep -q ticket; then
      curl -fsSL "${WALNUT_JOIN_INSTALL_URL:-https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh}" | sh >/dev/null \
        || walnut_join_fail "Walnut did not install. Run this again, or install it by hand: curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh"
      W=$(walnut_join_find) || walnut_join_fail "Walnut installed, but it is not on this machine's PATH. Open a new terminal and run this again."
    fi
    "$W" net join --help 2>/dev/null | grep -q ticket || walnut_join_fail "This Walnut ($("$W" --version 2>/dev/null | head -n 1)) is too old to join. Run: $W update, then this again."
    printf '  1/3  Walnut ............ installed (%s)\n' "$("$W" --version 2>/dev/null | head -n 1)"
  fi
  exec "$W" net join "$WALNUT_JOIN_TICKET" --steps
}

walnut_join_main

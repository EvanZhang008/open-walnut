/**
 * The script an invite link runs on a new machine (`curl -fsSL <link> | sh`,
 * routes/net-v1.ts): install Walnut if it is not there, then hand over to
 * `walnut net join`, which keeps Walnut running on the machine and joins it
 * (src/cli/net-join.ts). POSIX sh, so it runs on any macOS or Linux shell; nothing
 * runs until the last line, so a download cut short does nothing.
 *
 * The code rides in the script itself: it is one use and ends in 10 minutes.
 *
 * With no companion there is no server to make the script: `joinScript({ ticket: true })`
 * is scripts/join.sh, attached to every release beside install.sh, and the command a Mac
 * shows passes the ticket to it (`| sh -s -- wn1-...`, core/net/join-ticket.ts).
 */
import { JOIN_SCRIPT_URL } from './join-ticket.js'

const INSTALL_URL = 'https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh'

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function joinScript(input: { origin: string; code: string } | { ticket: true }): string {
  const ticket = 'ticket' in input
  // What this Walnut must understand: an older one knows only the companion's invite.
  const knows = ticket ? `"$W" net join --help 2>/dev/null | grep -q ticket` : `"$W" net join --help >/dev/null 2>&1`
  const head = ticket
    ? `# Walnut: add this machine to your Walnut machines, with the ticket your Mac shows.
# Usage: curl -fsSL ${JOIN_SCRIPT_URL} | sh -s -- wn1-...
# It installs Walnut when it is not here, keeps it running, and joins this machine.
set -eu
WALNUT_JOIN_TICKET=\${1:-}
case "$WALNUT_JOIN_TICKET" in
  wn1-*) ;;
  *) printf '%s\\n' "Run the command your Mac shows under Settings > Remote Hosts > Add a machine." >&2; exit 1 ;;
esac
`
    : `# Walnut: add this machine to your Walnut machines (an invite from ${input.origin.replace(/[^\w.:/-]/g, '')}).
# It installs Walnut when it is not here, keeps it running, and joins this machine.
set -eu
WALNUT_JOIN_ORIGIN=${shq(input.origin)}
WALNUT_JOIN_CODE=${shq(input.code)}
`
  const join = ticket ? `exec "$W" net join "$WALNUT_JOIN_TICKET" --steps` : `exec "$W" net join "$WALNUT_JOIN_ORIGIN" "$WALNUT_JOIN_CODE" --steps`
  return `#!/bin/sh
${head}
walnut_join_fail() { printf '\\n%s\\n' "$1" >&2; exit 1; }

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
  printf 'Walnut: adding this machine to your Walnut machines\\n'
  if W=$(walnut_join_find) && ${knows}; then
    printf '  1/3  Walnut ............ installed (%s)\\n' "$("$W" --version 2>/dev/null | head -n 1)"
  else
    printf '  1/3  Walnut ............ installing\\n'
    if W=$(walnut_join_find); then
      "$W" update >/dev/null 2>&1 || true
    fi
    if ! W=$(walnut_join_find) || ! ${knows}; then
      curl -fsSL "\${WALNUT_JOIN_INSTALL_URL:-${INSTALL_URL}}" | sh >/dev/null \\
        || walnut_join_fail "Walnut did not install. Run this again, or install it by hand: curl -fsSL ${INSTALL_URL} | sh"
      W=$(walnut_join_find) || walnut_join_fail "Walnut installed, but it is not on this machine's PATH. Open a new terminal and run this again."
    fi
    ${knows} || walnut_join_fail "This Walnut ($("$W" --version 2>/dev/null | head -n 1)) is too old to join. Run: $W update, then this again."
    printf '  1/3  Walnut ............ installed (%s)\\n' "$("$W" --version 2>/dev/null | head -n 1)"
  fi
  ${join}
}

walnut_join_main
`
}

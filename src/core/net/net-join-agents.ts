/**
 * The invite script's last lines (net-join-script.ts): which coding agents this machine
 * has, so the person who pasted the line knows whether it can run sessions now.
 *
 * Walnut installs none of them. 2026-11-03, the user: "We don't bind to Claude Code, user
 * can choose to install it, but we don't install for them automatically". The one line
 * sets up Walnut's own parts; an agent is installed when the user clicks Install on the
 * machine's line in Remote Hosts (host-autofix.ts), or by hand.
 *
 * Only the version is read here (`--version`, which every release answers). Whether
 * Claude Code is signed in is the Mac's to say: its check (claude-check-core.ts) knows
 * the older CLIs that have no `claude auth`, where the same words would start a session.
 */

const CLAUDE_INSTALL_LINE = 'curl -fsSL https://claude.ai/install.sh | bash'

/** POSIX sh functions; `walnut_join_agents` prints the closing lines. */
export function agentsLineScript(): string {
  return `
# An agent's binary that answers --version: the one on PATH, else where its installer puts
# it (a new machine's shell has ~/.local/bin on PATH only from its next login).
walnut_join_agent_bin() {
  for walnut_join_ab in "$(command -v "$1" 2>/dev/null || true)" "$2"; do
    [ -n "$walnut_join_ab" ] && [ -x "$walnut_join_ab" ] || continue
    walnut_join_abv=$("$walnut_join_ab" --version </dev/null 2>/dev/null | head -n 1) || continue
    [ -n "$walnut_join_abv" ] && { printf '%s' "$walnut_join_ab"; return 0; }
  done
  return 1
}

walnut_join_agent_ver() {
  "$1" --version </dev/null 2>/dev/null | head -n 1 | grep -Eo '[0-9]+[.][0-9]+[.][0-9]+[0-9A-Za-z.-]*' | head -n 1 || true
}

walnut_join_agents() {
  walnut_join_found=""
  if walnut_join_ab=$(walnut_join_agent_bin claude "$HOME/.local/bin/claude"); then
    walnut_join_found="Claude Code $(walnut_join_agent_ver "$walnut_join_ab")"
  fi
  if walnut_join_ab=$(walnut_join_agent_bin codex "$HOME/.local/bin/codex"); then
    walnut_join_found="\${walnut_join_found:+$walnut_join_found, }Codex $(walnut_join_agent_ver "$walnut_join_ab")"
  fi
  if [ -n "$walnut_join_found" ]; then
    printf '\\n%s\\n' "Coding agents here: $walnut_join_found."
  else
    printf '\\n%s\\n%s\\n' "No coding agent is on this machine yet. To add Claude Code, click Install on this machine in your Mac's Remote Hosts, or run here:" "  ${CLAUDE_INSTALL_LINE}"
  fi
}
`
}

/**
 * Turn a failed daemon start's log into one bracketed hint for the connect
 * error. Pure, so each production shape is pinned by a test instead of being
 * re-derived inside DaemonConnection.startDaemon.
 *
 * Order matters: "the runtime itself is missing" must win over the generic
 * "the nohup/env wrapper could not exec" shape, because both print through the
 * same wrapper. A bare `node` that nohup/env cannot find is a host without
 * Node.js, not a walnut bug (a fresh Linux dev host with bun unavailable lands
 * on the node start command and used to be told otherwise).
 */

const QUOTE = `['"\u2018\u2019]?`

/**
 * GNU nohup: `nohup: failed to run command 'node': No such file or directory`;
 * BSD nohup: `nohup: node: No such file or directory`; env (GNU and BSD, when an
 * env prefix is present): `env: 'node': …` or `env: node: …`. GNU tools use
 * curly quotes instead of `'` in a UTF-8 locale.
 */
const NODE_MISSING = new RegExp(
  `^(?:nohup: failed to run command |nohup: |env: )${QUOTE}node${QUOTE}: No such file or directory`, 'm',
)

export function diagnoseDaemonStartLog(startLog: string, hostKey: string): string {
  if (NODE_MISSING.test(startLog)) {
    return ` [Node.js is not installed on ${hostKey}: the start command could not run node. `
      + 'Install bun (curl -fsSL https://bun.sh/install | bash) and Walnut runs its daemon without Node; '
      + 'for Claude Code use the native build (curl -fsSL https://claude.ai/install.sh | bash), which needs no Node either.]'
  }
  if (/^(nohup|env): /m.test(startLog)) {
    return ' [malformed start command: the nohup/env wrapper could not exec the daemon '
      + '(bad path or malformed env prefix). This is a walnut bug, not a host problem]'
  }
  if (/GLIBC_\d/.test(startLog)) {
    return ' [glibc mismatch: the node binary on PATH requires newer glibc than this host has. '
      + 'Check `node -v` on the remote. If it errors, install an older nvm-managed node (v16 on AL2/RHEL7). '
      + 'Prefer binary daemon deploy which avoids node entirely.]'
  }
  if (startLog.includes('EADDRINUSE')) {
    return ' [port in use: another daemon already running. Try `daemon --stop` first]'
  }
  if (startLog.includes('Permission denied')) {
    return ' [permission denied: /tmp/open-walnut may be owned by a different user]'
  }
  return ''
}

/**
 * Turn a failed daemon start's log into one bracketed hint for the connect
 * error. Pure, so each production shape is pinned by a test instead of being
 * re-derived inside DaemonConnection.startDaemon.
 *
 * A host always runs the compiled daemon (a daemon binary or the walnut file):
 * no start command runs `node` any more (CHANGELOG: node-only hosts are no
 * longer supported), so a nohup/env wrapper that cannot exec is a bad path or
 * a malformed env prefix of ours.
 */

export function diagnoseDaemonStartLog(startLog: string, hostKey: string): string {
  if (/^(nohup|env): /m.test(startLog)) {
    return ' [malformed start command: the nohup/env wrapper could not exec the daemon '
      + '(bad path or malformed env prefix). This is a walnut bug, not a host problem]'
  }
  if (/GLIBC_\d/.test(startLog)) {
    return ` [glibc mismatch: the daemon binary needs a newer glibc than ${hostKey} has (\`ldd --version\` there shows it)]`
  }
  if (startLog.includes('EADDRINUSE')) {
    return ' [port in use: another daemon already running. Try `daemon --stop` first]'
  }
  if (startLog.includes('Permission denied')) {
    return ' [permission denied: the daemon dir (/tmp/open-walnut, or ~/.cache/open-walnut when /tmp is unusable) may be owned by a different user]'
  }
  return ''
}

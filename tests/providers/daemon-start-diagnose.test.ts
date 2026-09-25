/**
 * The hint appended to "daemon failed to start" (DaemonConnection.startDaemon).
 * Each case is a start-log shape seen on a real host. The node-missing case is
 * the one a fresh Linux host hits when bun is unavailable and the node start
 * command runs: GNU nohup prints its own "failed to run command 'node'" line,
 * which used to be labelled a walnut bug.
 */
import { describe, it, expect } from 'vitest'
import { diagnoseDaemonStartLog } from '../../src/providers/daemon-start-diagnose.js'

const NODE_MISSING = /^ \[Node\.js is not installed on devbox: /

describe('diagnoseDaemonStartLog', () => {
  it("labels GNU nohup's `failed to run command 'node'` as Node.js missing, with the bun and native-install hint", () => {
    const hint = diagnoseDaemonStartLog("nohup: failed to run command 'node': No such file or directory\n", 'devbox')
    expect(hint).toMatch(NODE_MISSING)
    expect(hint).toContain('curl -fsSL https://bun.sh/install | bash')
    expect(hint).toContain('curl -fsSL https://claude.ai/install.sh | bash')
    expect(hint).not.toContain('walnut bug')
  })

  it('labels the env-prefix and BSD/UTF-8 quote variants the same way', () => {
    for (const log of [
      "env: 'node': No such file or directory",
      'env: \u2018node\u2019: No such file or directory',
      'env: node: No such file or directory',
      'nohup: node: No such file or directory',
      "nohup: failed to run command \u2018node\u2019: No such file or directory",
    ]) {
      expect(diagnoseDaemonStartLog(log, 'devbox'), log).toMatch(NODE_MISSING)
    }
  })

  it('keeps a missing bun or binary PATH as the malformed-command walnut bug', () => {
    for (const log of [
      "nohup: failed to run command '/home/dev/.bun/bin/bun': No such file or directory",
      "env: '/tmp/open-walnut/daemon-linux-x64': No such file or directory",
      "nohup: failed to run command 'WALNUT_ENFORCE_SESSION_CRON=1': No such file or directory",
    ]) {
      const hint = diagnoseDaemonStartLog(log, 'devbox')
      expect(hint, log).toContain('malformed start command')
      expect(hint, log).toContain('walnut bug')
    }
  })

  it('still labels a node that exists but needs a newer glibc as a glibc mismatch', () => {
    const hint = diagnoseDaemonStartLog(
      "node: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by node)\n", 'devbox',
    )
    expect(hint).toContain('glibc mismatch')
    expect(hint).not.toMatch(NODE_MISSING)
  })

  it('port-in-use, permission and unknown logs', () => {
    expect(diagnoseDaemonStartLog('Error: listen EADDRINUSE: address already in use', 'devbox')).toContain('port in use')
    expect(diagnoseDaemonStartLog('mkdir: /tmp/open-walnut: Permission denied', 'devbox')).toContain('permission denied')
    expect(diagnoseDaemonStartLog('something else entirely', 'devbox')).toBe('')
  })
})

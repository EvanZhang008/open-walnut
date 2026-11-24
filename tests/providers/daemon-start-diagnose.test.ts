/**
 * The hint appended to "daemon failed to start" (DaemonConnection.startDaemon).
 * Each case is a start-log shape seen on a real host. A host always runs the
 * compiled daemon, so no start command runs `node`: a nohup/env wrapper that
 * cannot exec is always our own bad path or env prefix.
 */
import { describe, it, expect } from 'vitest'
import { diagnoseDaemonStartLog } from '../../src/providers/daemon-start-diagnose.js'

describe('diagnoseDaemonStartLog', () => {
  it('labels a wrapper that cannot exec (GNU, BSD, env, UTF-8 quotes) as the malformed-command walnut bug', () => {
    for (const log of [
      "nohup: failed to run command '/home/dev/.bun/bin/bun': No such file or directory",
      "env: '/tmp/open-walnut/daemon-linux-x64': No such file or directory",
      "nohup: failed to run command 'WALNUT_ENFORCE_SESSION_CRON=1': No such file or directory",
      'nohup: /tmp/open-walnut/daemon: No such file or directory',
      'env: \u2018/tmp/open-walnut/daemon\u2019: No such file or directory',
    ]) {
      const hint = diagnoseDaemonStartLog(log, 'devbox')
      expect(hint, log).toContain('malformed start command')
      expect(hint, log).toContain('walnut bug')
    }
  })

  it('labels a daemon binary that needs a newer glibc, naming the host and no Node advice', () => {
    const hint = diagnoseDaemonStartLog("daemon: /lib64/libc.so.6: version `GLIBC_2.28' not found (required by daemon)\n", 'devbox')
    expect(hint).toContain('glibc mismatch')
    expect(hint).toContain('devbox')
    expect(hint).not.toMatch(/node|nvm/i)
  })

  it('port-in-use, permission and unknown logs', () => {
    expect(diagnoseDaemonStartLog('Error: listen EADDRINUSE: address already in use', 'devbox')).toContain('port in use')
    expect(diagnoseDaemonStartLog('mkdir: /tmp/open-walnut: Permission denied', 'devbox')).toContain('permission denied')
    expect(diagnoseDaemonStartLog('something else entirely', 'devbox')).toBe('')
  })
})

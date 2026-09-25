/**
 * summarizeConnectFailure — log-noise control for the 60s connect failure cache.
 *
 * 2026-08-22: one real ssh failure (a host entering its patch reboot) produced
 * **870** deploy-failure warn lines inside a single hour, 864 of them replays of
 * the SAME cached error. The cached string is re-thrown to every caller for 60s
 * and every caller logs it, so a multi-line ssh error multiplies by every
 * in-flight operation. The log became unreadable exactly when it was needed to
 * diagnose the outage.
 *
 * Contract: ONE line, bounded length, and it keeps the part that says what went
 * wrong rather than the echoed ssh command line.
 */
import { describe, it, expect } from 'vitest'
import { summarizeConnectFailure } from '../../src/providers/daemon-connection.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'

describe('summarizeConnectFailure', () => {
  it('collapses the real incident error to one line naming the failure', () => {
    const raw = [
      'Failed to deploy daemon source to clouddev: Command failed: ssh -o BatchMode=yes'
        + ' -o StrictHostKeyChecking=no user@host.example.com mkdir -p /tmp/open-walnut'
        + ' && rm -f /tmp/open-walnut/daemon.js',
      'Connection closed by UNKNOWN port 65535',
      '',
    ].join('\n')
    const out = summarizeConnectFailure(raw)
    expect(out).toBe('Connection closed by UNKNOWN port 65535')
    expect(out).not.toContain('\n')
  })

  it('prefers the diagnosis over the echoed command', () => {
    const raw = 'Command failed: ssh -o BatchMode=yes host true\nPermission denied (publickey).'
    expect(summarizeConnectFailure(raw)).toBe('Permission denied (publickey).')
  })

  it('flattens an embedded stack trace to a single bounded line', () => {
    const raw = [
      'Failed to deploy daemon binary to clouddev: Command failed: ssh -o BatchMode=yes host',
      '/snapshot/build/node_modules/ws/lib/websocket.js:335',
      '      throw err;',
      'Error: WebSocket is not open: readyState 2 (CLOSING)',
      '    at WebSocket.send (/snapshot/build/node_modules/ws/lib/websocket.js:329:19)',
    ].join('\n')
    const out = summarizeConnectFailure(raw)
    expect(out).not.toContain('\n')
    expect(out.length).toBeLessThanOrEqual(160)
    expect(out).toContain('WebSocket is not open')
  })

  it('truncates with an ellipsis instead of emitting a wall of text', () => {
    const out = summarizeConnectFailure(`Error: ${'x'.repeat(500)}`, 40)
    expect(out).toHaveLength(40)
    expect(out.endsWith('…')).toBe(true)
  })

  it('is a no-op for an already-short single-line error', () => {
    expect(summarizeConnectFailure('Connection timed out')).toBe('Connection timed out')
  })

  it('survives junk input without throwing, and still returns one line', () => {
    // Whitespace-only input has no diagnosis to keep; collapsing it is fine, but
    // it must not throw — this runs inside a catch handler on the connect path.
    for (const junk of ['', '   ', '\n\n', '\t']) {
      const out = summarizeConnectFailure(junk)
      expect(typeof out).toBe('string')
      expect(out).not.toContain('\n')
    }
  })

  it('a changed host key keeps its warning, not the banner of @ signs, and still classifies as host_key', () => {
    const raw = [
      'Command failed: ssh -o BatchMode=yes me@devbox.example.test sh -s',
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
      'Host key for devbox.example.test has changed and you have requested strict checking.',
      'Host key verification failed.',
    ].join('\n')
    const out = summarizeConnectFailure(raw)
    expect(out).toBe('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @')
    expect(classifyHostConnectError(out, 'me@devbox.example.test').kind).toBe('host_key')
  })

  it('the local credential evidence rides the summary, so the cached error still says why', () => {
    const raw = 'Command failed: ssh me@devbox sh -s\nme@devbox: Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-09-24 08:00)'
    const out = summarizeConnectFailure(raw)
    expect(out).toBe('me@devbox: Permission denied (publickey). [walnut-ssh-evidence: cert-expired (SSH certificate expired at 2026-09-24 08:00)]')
    expect(classifyHostConnectError(out, 'me@devbox').kind).toBe('cert_expired')
    // Bounded even when the evidence is long: the tag is kept, the signal is clipped.
    const long = summarizeConnectFailure(raw.replace('Permission denied', 'Permission denied ' + 'x'.repeat(300)))
    expect(long.length).toBeLessThanOrEqual(160)
    expect(long).toContain('walnut-ssh-evidence: cert-expired')
  })

  it('a shell that ate the command keeps the shell_noise line', () => {
    const raw = 'Command failed: ssh devbox sh -s\nshell_noise: the login shell on devbox answered without Walnut\'s output markers (it did not run `sh -s` as written). It printed: This account is restricted.'
    const out = summarizeConnectFailure(raw)
    expect(out.startsWith('shell_noise:')).toBe(true)
    expect(classifyHostConnectError(out, 'devbox').kind).toBe('shell_noise')
  })

  it('a tunnel refused by the server keeps the forwarding line', () => {
    const out = summarizeConnectFailure('daemon tunnel is not accepting connections\nchannel 2: open failed: administratively prohibited: open failed\nPort forwarding failed')
    expect(out).toBe('Port forwarding failed')
  })
})

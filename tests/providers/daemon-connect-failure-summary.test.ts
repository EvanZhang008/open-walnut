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
})

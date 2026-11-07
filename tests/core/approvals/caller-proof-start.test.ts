import { describe, expect, it } from 'vitest'
import { lstartMs, normStart, parseProcessTree, proofFor, sameInstant, sameStart, startedBy, stillTheirs } from '../../../src/providers/caller-proof-core.js'

const PS = [
  '    1     0 Fri Nov  6 16:50:37 2026     /sbin/launchd',
  '  500     1 Sat Nov  7 03:15:00 2026     /bin/zsh',
  '  501   500 Sat Nov  7 03:15:09 2026     python3 release.py',
  'garbage line',
].join('\n')

describe('a pid is checked as the process it was, by its start time', () => {
  it('reads one ps snapshot with each process\'s parent, start time and name', () => {
    const t = parseProcessTree(PS)
    expect(t.get(501)).toEqual({ ppid: 500, start: 'Sat Nov 7 03:15:09 2026', comm: 'python3 release.py' })
    expect(t.size).toBe(3)
    expect(normStart(' Sat Nov  7 03:15:09 2026 ')).toBe('Sat Nov 7 03:15:09 2026')
    expect(lstartMs('nonsense')).toBeNull()
  })

  it('a recorded start names the process now under the pid only when it is the same', () => {
    const t = parseProcessTree(PS)
    expect(sameStart('Sat Nov  7 03:15:00 2026', t.get(500)!.start, () => null)).toBe(true)
    expect(sameStart('Sat Nov  7 03:14:59 2026', t.get(500)!.start, () => null)).toBe(false)
    // A Linux daemon records /proc ticks: read again, never compared with lstart.
    expect(sameStart('81234', t.get(500)!.start, () => '81234')).toBe(true)
    expect(sameStart('81234', t.get(500)!.start, () => '99999')).toBe(false)
    expect(sameStart('81234', t.get(500)!.start, () => null)).toBe(false)
    // Unread or unrecorded is never the same.
    expect(sameStart(null, t.get(500)!.start, () => null)).toBe(false)
    expect(sameStart('Sat Nov  7 03:15:00 2026', undefined, () => null)).toBe(false)
  })

  it('the process holding a connection started before it opened; a later one given its pid did not', () => {
    const opened = Date.parse('Sat Nov 7 03:15:10 2026')
    expect(startedBy('Sat Nov  7 03:15:09 2026', opened)).toBe(true)
    expect(startedBy('Sat Nov  7 03:15:11 2026', opened)).toBe(true) // within a second's drift
    expect(startedBy('Sat Nov  7 03:15:12 2026', opened)).toBe(false)
    expect(startedBy(undefined, opened)).toBe(false)
  })

  it("keeps only the session's processes that are still the recorded ones", () => {
    const t = parseProcessTree(PS)
    const at = Date.parse('Sat Nov 7 03:15:05 2026')
    expect(stillTheirs(t, [
      { pid: 500, start: 'Sat Nov  7 03:15:00 2026' }, // the CLI, as recorded
      { pid: 501, start: 'Sat Nov  7 03:00:00 2026' }, // its pid was given out again
      { pid: 777, start: 'Sat Nov  7 03:15:00 2026' }, // gone
      { pid: 501, before: at }, // a pid file written before this process started
      { pid: 500, before: at }, // one written after
      { pid: 500 }, // nothing recorded
      { pid: 1, start: 'Fri Nov  6 16:50:37 2026' },
    ], () => null)).toEqual([500, 500])
  })

  it('a terminal records its start in UTC: the same second there is the same process', () => {
    const local = parseProcessTree(PS).get(500)!.start
    const utc = new Date(lstartMs(local)!).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4')
    expect(sameInstant(utc, local)).toBe(true)
    expect(sameInstant('Mon Jan 1 00:00:00 2001', local)).toBe(false)
    expect(stillTheirs(parseProcessTree(PS), [{ pid: 500, startUtc: utc }], () => null)).toEqual([500])
  })

  it("the daemon's verdict: inside, outside, or could not tell", () => {
    const t = parseProcessTree(PS)
    const own = [{ pid: 500, start: 'Sat Nov  7 03:15:00 2026' }]
    const at = Date.parse('Sat Nov 7 03:16:00 2026')
    expect(proofFor(t, 501, at, own, () => null)).toEqual({ verified: true })
    expect(proofFor(t, 1, at, own, () => null)).toEqual({ verified: false })
    expect(proofFor(t, 501, Date.parse('Sat Nov 7 03:15:05 2026'), own, () => null)).toEqual({ verified: false, unchecked: true })
    expect(proofFor(t, 501, at, [{ pid: 500, start: 'Sat Nov  7 03:00:00 2026' }], () => null)).toEqual({ verified: false, unchecked: true })
    expect(proofFor(t, 999, at, own, () => null)).toEqual({ verified: false, unchecked: true })
  })
})

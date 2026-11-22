import { describe, expect, it } from 'vitest'
import { ancestorOf, claimedSidVerdict, lstartMs, normStart, parseProcessTree, proofFor, sameInstant, sameStart, startedBy, stillTheirs } from '../../../src/providers/caller-proof-core.js'

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

// A gateway line names a session (2026-11-21): the daemon believes it only from inside that session
// or from the process that started the daemon.
describe('who a gateway socket\'s process may speak as', () => {
  const TREE = [
    '    1     0 Fri Nov  6 16:50:37 2026     /sbin/init',
    '  100     1 Sat Nov  7 03:00:00 2026     test-runner',
    '  200   100 Sat Nov  7 03:00:01 2026     daemon',
    '  300   200 Sat Nov  7 03:01:00 2026     cli-a',
    '  301   300 Sat Nov  7 03:02:00 2026     bash',
    '  302   301 Sat Nov  7 03:02:01 2026     walnut',
    '  400   200 Sat Nov  7 03:01:00 2026     cli-b',
    '  401   400 Sat Nov  7 03:02:00 2026     walnut',
    '  500   100 Sat Nov  7 03:02:00 2026     stranger',
    '  600     1 Sat Nov  7 03:03:00 2026     orphan',
  ].join('\n')
  const t = parseProcessTree(TREE)
  const at = Date.parse('Sat Nov 7 03:05:00 2026')
  const A = [{ pid: 300, start: 'Sat Nov  7 03:01:00 2026' }]
  const verdict = (peer: number, procs = A, when = at) => claimedSidVerdict(t, peer, when, procs, () => null, 200)

  it('the daemon\'s ancestors, never itself, its children or pid 1', () => {
    expect(ancestorOf(t, 100, 200)).toBe(true)
    expect(ancestorOf(t, 200, 200)).toBe(false)
    expect(ancestorOf(t, 300, 200)).toBe(false)
    expect(ancestorOf(t, 1, 200)).toBe(false)
    expect(ancestorOf(t, 500, 200)).toBe(false)
  })

  it('inside the session at any depth is the session; a sibling, a stranger or an orphan is outside', () => {
    expect(verdict(300)).toBe('session')
    expect(verdict(302)).toBe('session')
    expect(verdict(401)).toBe('outside')
    expect(verdict(500)).toBe('outside')
    expect(verdict(600)).toBe('outside')
    // A process gone before it was read, or one that started after the line came, is outside.
    expect(verdict(999)).toBe('outside')
    expect(verdict(302, A, Date.parse('Sat Nov 7 03:02:00 2026') - 5_000)).toBe('outside')
  })

  it('the session\'s CLI no longer the one recorded (its pid given out again): nobody is inside', () => {
    expect(verdict(302, [{ pid: 300, start: 'Sat Nov  7 02:00:00 2026' }])).toBe('outside')
    expect(verdict(302, [])).toBe('outside')
  })

  it('the daemon\'s starter is believed, whatever session it names', () => {
    expect(verdict(100)).toBe('starter')
    expect(verdict(100, [])).toBe('starter')
  })
})

/**
 * The Created / Updated / Host rows at the foot of the session panel's ⋮ menu.
 * Times read as "how long ago" with the exact time on hover. Dates are built
 * with the local-time Date constructor so the hover text holds in any timezone.
 */
import { describe, expect, it } from 'vitest'
import { sessionKebabMetaRows } from '../../web/src/components/sessions/session-kebab-meta'

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString()
const NOW = new Date(2026, 8, 28, 18, 30).getTime() // Mon Sep 28 2026, 6:30 PM local

const session = { startedAt: at(2026, 9, 20, 10, 14), lastActiveAt: at(2026, 9, 28, 16, 2, 5) }

describe('sessionKebabMetaRows', () => {
  it('Created and Updated are the session times, relative, then the host', () => {
    const rows = sessionKebabMetaRows(session, NOW)
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Created', '1w ago'],
      ['Updated', '2h ago'],
      ['Host', 'Local'],
    ])
  })

  it('hovering a time gives the exact time', () => {
    const [created, updated] = sessionKebabMetaRows(session, NOW)
    expect(created.title).toBe('Sun, Sep 20, 2026, 10:14:00 AM')
    expect(updated.title).toBe('Mon, Sep 28, 2026, 4:02:05 PM')
    expect(`${created.title}${updated.title}`).not.toMatch(/[\u202f\u00a0]/)
  })

  it('a remote session names its host alias, with the full hostname on hover', () => {
    const host = sessionKebabMetaRows({ ...session, host: 'devbox', hostname: 'devbox.example.test' }, NOW)[2]
    expect(host).toEqual({ key: 'host', label: 'Host', value: 'devbox', title: 'devbox.example.test' })
    expect(sessionKebabMetaRows({ ...session, host: 'devbox' }, NOW)[2].title).toBe('devbox')
  })

  it('every spelling of this machine reads Local', () => {
    for (const host of [undefined, '', '__local__', 'local']) {
      const row = sessionKebabMetaRows({ ...session, host, hostname: 'ignored.example.test' }, NOW)[2]
      expect(row.value, String(host)).toBe('Local')
      expect(row.title, String(host)).toBe('Local')
    }
  })

  it('just now, and a clock-skewed future time is just now too', () => {
    const rows = sessionKebabMetaRows({ startedAt: at(2026, 9, 28, 18, 29, 40), lastActiveAt: at(2026, 9, 28, 18, 31) }, NOW)
    expect(rows.map((r) => r.value)).toEqual(['just now', 'just now', 'Local'])
  })

  it('a missing or bad time drops its row; the host row always stays', () => {
    expect(sessionKebabMetaRows({ startedAt: 'garbage', lastActiveAt: '' }, NOW).map((r) => r.key)).toEqual(['host'])
    expect(sessionKebabMetaRows({ startedAt: session.startedAt }, NOW).map((r) => r.key)).toEqual(['created', 'host'])
  })
})

describe('sessionKebabMetaRows: Memory and CPU', () => {
  const resources = { rssBytes: 1.5 * 1024 ** 3, cpuPct: 42.4, procCount: 3, top: [{ pid: 7, comm: 'claude', rssBytes: 1024 ** 3 }, { pid: 8, comm: 'node', rssBytes: 512 * 1024 ** 2 }] }

  it('with a reading, two rows follow Host: the tree total with its process count, and the CPU', () => {
    const rows = sessionKebabMetaRows({ ...session, resources }, NOW)
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['created', '1w ago'],
      ['updated', '2h ago'],
      ['host', 'Local'],
      ['memory', '1.5 GB · 3 processes'],
      ['cpu', '42%'],
    ])
    expect(rows[3].title).toBe('claude (7) 1.0 GB\nnode (8) 512 MB')
  })

  it('no reading (no host reports it yet) adds nothing; a first sample reads CPU as a dash', () => {
    expect(sessionKebabMetaRows({ ...session, resources: null }, NOW)).toHaveLength(3)
    expect(sessionKebabMetaRows(session, NOW)).toHaveLength(3)
    const [, , , , cpu] = sessionKebabMetaRows({ ...session, resources: { ...resources, cpuPct: null } }, NOW)
    expect(cpu.value).toBe('\u2014')
    expect(cpu.title).toMatch(/next sample/)
  })
})


/**
 * The Folder / Host / Created / Updated rows of Session info at the foot of the
 * session panel's ⋮ menu.
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
  it('the host, then Created and Updated, the session times, relative', () => {
    const rows = sessionKebabMetaRows(session, NOW)
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Host', 'This Mac'],
      ['Created', '1w ago'],
      ['Updated', '2h ago'],
    ])
  })

  // 2026-11-21, the user: "Session info should have right amount of field, like paht where
  // is the fucking path". The working folder is the first row, whole, never shortened.
  it('a session with a folder shows it first, whole', () => {
    const cwd = '/Users/me/.open-walnut-worktrees/open-walnut/session-info-9cb0aaf2-66ee-5a4e-a319-ea27e61cb370'
    const rows = sessionKebabMetaRows({ ...session, cwd }, NOW)
    expect(rows.map((r) => r.key)).toEqual(['folder', 'host', 'created', 'updated'])
    expect(rows[0]).toEqual({ key: 'folder', label: 'Folder', value: cwd, title: cwd })
  })

  it('a folder that is gone says so on the row and its hover', () => {
    const [folder] = sessionKebabMetaRows({ ...session, cwd: '/work/old', cwdGone: true }, NOW)
    expect(folder).toMatchObject({ key: 'folder', value: '/work/old', gone: true, title: '/work/old no longer exists on this host' })
  })

  it('hovering a time gives the exact time', () => {
    // The same text on V8 (Node, Chrome) and JavaScriptCore (bun, WebKit), whose
    // combined date-time format would say "2026 at 10:14:00 AM".
    const [, created, updated] = sessionKebabMetaRows(session, NOW)
    expect(created.title).toBe('Sun, Sep 20, 2026, 10:14:00 AM')
    expect(updated.title).toBe('Mon, Sep 28, 2026, 4:02:05 PM')
    expect(`${created.title}${updated.title}`).not.toMatch(/[\u202f\u00a0]/)
  })

  it('a remote session names its host alias, with the full hostname on hover', () => {
    const host = sessionKebabMetaRows({ ...session, host: 'devbox', hostname: 'devbox.example.test' }, NOW)[0]
    expect(host).toEqual({ key: 'host', label: 'Host', value: 'devbox', title: 'devbox.example.test' })
    expect(sessionKebabMetaRows({ ...session, host: 'devbox' }, NOW)[0].title).toBe('devbox')
  })

  it('every spelling of this machine reads This Mac', () => {
    for (const host of [undefined, '', '__local__', 'local']) {
      const row = sessionKebabMetaRows({ ...session, host, hostname: 'ignored.example.test' }, NOW)[0]
      expect(row.value, String(host)).toBe('This Mac')
      expect(row.title, String(host)).toBe('This Mac')
    }
  })

  it('just now, and a clock-skewed future time is just now too', () => {
    const rows = sessionKebabMetaRows({ startedAt: at(2026, 9, 28, 18, 29, 40), lastActiveAt: at(2026, 9, 28, 18, 31) }, NOW)
    expect(rows.map((r) => r.value)).toEqual(['This Mac', 'just now', 'just now'])
  })

  it('a missing or bad time drops its row; the host row always stays', () => {
    expect(sessionKebabMetaRows({ startedAt: 'garbage', lastActiveAt: '' }, NOW).map((r) => r.key)).toEqual(['host'])
    expect(sessionKebabMetaRows({ startedAt: session.startedAt }, NOW).map((r) => r.key)).toEqual(['host', 'created'])
  })
})

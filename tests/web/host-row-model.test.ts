/**
 * The words of Remote Hosts' one list of machines (web/src/components/settings/sections/
 * host-row-model.ts): the summary line, counted from the rows themselves (2026-11-04 review: it
 * said "2 of 4 online" through a Turn on and an Add), the header's one "need a look" count that
 * steps through its hosts, the map's line words (the row's own state), a live host's one state
 * line, the connect action's busy words and its "Retry SSH", the alias a new host takes from its
 * hostname, where a second Add goes in an open draft, and the untouched draft that Cancel and
 * Escape take away with no confirm.
 */
import { describe, expect, it } from 'vitest'
import {
  aliasFromHostname, aliasPlaceholder, connectAction, firstEmptyField, listSummary, liveLine, mapLinkLabel, needsLook, needsWords, nextLook, summaryWords, untouchedDraft,
  type RowReport,
} from '../../web/src/components/settings/sections/host-row-model'
import { emptyHost } from '../../web/src/components/settings/sections/remote-hosts-model'
import type { FleetHost } from '../../web/src/api/hosts-fleet'

const NOW = Date.UTC(2026, 9, 30, 12)

function host(over: Partial<FleetHost> = {}): FleetHost {
  return {
    host: 'devbox', label: 'Dev box', local: false, line: '', checkedAt: NOW,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: NOW - 60_000, rttMs: 30, error: null },
    system: null,
    now: { cpus: 8, cpuUtil: 0.12, load: [1, 1, 1], memTotalBytes: 1, memAvailBytes: 1, uptimeSec: 86400, bootedAt: 0, linked: true, at: NOW, stale: false },
    history: null,
    sessions: { running: 2 },
    spend: null,
    server: null,
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: 0, startup: 'service', startsAfterReboot: true, runtime: 'bun', vitals: true },
    placement: { score: 1, busy: false, reasons: [], weight: 50, longRunning: { ok: true, reasons: [] } },
    ...over,
  } as FleetHost
}

function row(over: Partial<RowReport> = {}): RowReport {
  return { key: 'ssh:1', host: 'devbox', name: 'Dev box', counted: true, online: true, off: false, needsLook: false, local: false, via: 'ssh', rttMs: 38, sessions: 2, spendUsd: 10, sub: 'Linux', ...over }
}

describe('listSummary and summaryWords: one line, from the rows', () => {
  it('counts what the rows say: an off host is named, not in "N of M online"; drafts are not counted', () => {
    const rows = [
      row({ key: 'fleet:__local__', host: '__local__', local: true, via: 'local', sessions: 3, spendUsd: 200 }),
      row({ key: 'ssh:1', online: true, sessions: 1, spendUsd: 41 }),
      row({ key: 'ssh:2', host: 'beta', online: false, needsLook: true, sessions: null, spendUsd: null }),
      row({ key: 'ssh:3', host: 'big', off: true, online: false, sessions: 5, spendUsd: 1 }),
      row({ key: 'ssh:4', host: 'draft', counted: false, online: false }),
    ]
    const s = listSummary(rows)
    expect(s).toEqual({ online: 2, total: 3, off: 1, sessions: 4, spendUsd: 242, needs: 1 })
    expect(summaryWords(s)).toEqual({ online: '2 of 3 online', off: '1 off', sessions: '4 sessions open', spend: '$242 in 30 days' })
  })

  it('moves at once with the rows: Turn on, Add, Remove', () => {
    const before = [row({ key: 'a' }), row({ key: 'b', off: true, online: false })]
    expect(summaryWords(listSummary(before)).online).toBe('1 of 1 online')
    // Turned on, still dialling: counted, not online yet.
    const on = [row({ key: 'a' }), row({ key: 'b', online: false })]
    expect(summaryWords(listSummary(on))).toMatchObject({ online: '1 of 2 online', off: null })
    // A host added and saved.
    expect(summaryWords(listSummary([...on, row({ key: 'c' })])).online).toBe('2 of 3 online')
    // Removed.
    expect(summaryWords(listSummary([row({ key: 'a' })])).online).toBe('1 of 1 online')
  })

  it('leaves out what no row knows', () => {
    expect(summaryWords(listSummary([row({ sessions: null, spendUsd: null })]))).toEqual({ online: '1 of 1 online', off: null, sessions: null, spend: null })
    expect(summaryWords(listSummary([row({ sessions: 1 })])).sessions).toBe('1 session open')
  })
})

describe('needsWords and nextLook: the header count steps through its hosts', () => {
  it('says the count, then which of them is shown, and wraps back to the first', () => {
    expect(needsWords(3, null)).toBe('3 need a look')
    expect(needsWords(1, null)).toBe('1 needs a look')
    let at: number | null = null
    const seen: string[] = []
    for (let i = 0; i < 4; i++) { at = nextLook(3, at); seen.push(needsWords(3, at)) }
    expect(seen).toEqual(['1 of 3 need a look', '2 of 3 need a look', '3 of 3 need a look', '1 of 3 need a look'])
    // A count that shrank under the index starts over.
    expect(nextLook(2, 2)).toBe(0)
    expect(needsWords(2, 5)).toBe('2 need a look')
  })
})

describe('mapLinkLabel: the map line says what the row says', () => {
  it('off, not connected, or the way and its latency', () => {
    expect(mapLinkLabel(row())).toBe('SSH tunnel, 38 ms')
    expect(mapLinkLabel(row({ off: true, online: false }))).toBe('Off')
    // A host turned off is Off even if a stale reading had it up (2026-11-04: drawn green while off).
    expect(mapLinkLabel(row({ off: true, online: true }))).toBe('Off')
    expect(mapLinkLabel(row({ online: false }))).toBe('Not connected')
    expect(mapLinkLabel(row({ via: 'net', rttMs: 12.4 }))).toBe('Host network, 12 ms')
    expect(mapLinkLabel(row({ via: 'bridge', rttMs: null }))).toBe('Through your cloud companion')
    expect(mapLinkLabel(row({ via: 'bridge', online: false }))).toBe('Not connected in')
    expect(mapLinkLabel(row({ local: true, via: 'local' }))).toBe('This Mac')
  })
})

describe('liveLine: a live host in one line', () => {
  it('names CPU and sessions, and leaves out what is not known', () => {
    expect(liveLine(host())).toBe('Online, 12% CPU, 2 sessions')
    expect(liveLine(host({ sessions: { running: 1 } }))).toBe('Online, 12% CPU, 1 session')
    expect(liveLine(host({ now: null, sessions: { running: null } }))).toBe('Online')
    expect(liveLine(undefined)).toBe('Online')
  })
})

describe('needsLook', () => {
  it('a host not connected needs a look; a quiet live one does not', () => {
    expect(needsLook(host(), NOW)).toBe(false)
    expect(needsLook(host({ connection: { kind: 'ssh-tunnel', connected: false, phase: 'failed', phaseLabel: 'Could not connect', since: null, rttMs: null, error: 'refused' } }), NOW)).toBe(true)
  })
})

describe('connectAction: its busy words match its words', () => {
  it('Connect now runs as Connecting..., Retry SSH as Retrying...; a joined machine just Retry', () => {
    expect(connectAction(false, false).label).toBe('Connect now')
    expect(connectAction(false, true).label).toBe('Connecting...')
    expect(connectAction(true, false).label).toBe('Retry SSH')
    expect(connectAction(true, true).label).toBe('Retrying...')
    expect(connectAction(true, false, 'net').label).toBe('Retry')
    expect(connectAction(true, false).reserve).toEqual(['Retry SSH', 'Retrying...'])
    // The width is reserved for both words, so the button never moves.
    expect(connectAction(false, true).reserve).toEqual(['Connect now', 'Connecting...'])
  })
})

describe('aliasPlaceholder: an alias no host has', () => {
  it('skips every alias that is taken', () => {
    expect(aliasPlaceholder(new Set(['devbox']))).toBe('buildbox')
    expect(aliasPlaceholder(new Set(['buildbox', 'workstation']))).toBe('gpu-server')
    expect(aliasPlaceholder(new Set(['buildbox', 'workstation', 'gpu-server', 'lab-pc', 'server-2']))).toBe('host-6')
  })
})

describe('aliasFromHostname: a new host saves at once', () => {
  it('takes the first DNS label, lower case, with what an alias may not hold made a dash', () => {
    expect(aliasFromHostname('build7.example.com')).toBe('build7')
    expect(aliasFromHostname('  Build7.Example.COM ')).toBe('build7')
    expect(aliasFromHostname('sam@gpu box.lan:2222')).toBe('gpu-box')
    expect(aliasFromHostname('10.0.0.9')).toBe('10-0-0-9')
    expect(aliasFromHostname('[fe80::1]')).toBe('fe80-1')
    expect(aliasFromHostname('...')).toBe('')
    expect(aliasFromHostname('')).toBe('')
  })
  it('never takes an alias another host has', () => {
    expect(aliasFromHostname('build7.example.com', new Set(['build7']))).toBe('build7-2')
    expect(aliasFromHostname('build7.example.com', new Set(['build7', 'build7-2']))).toBe('build7-3')
  })
})

describe('firstEmptyField: where a second Add goes in the open draft', () => {
  it('the first field still empty, the alias when it is refused', () => {
    expect(firstEmptyField({ hostname: '', alias: '', user: '' })).toBe('hostname')
    expect(firstEmptyField({ hostname: 'h.example.com', alias: '', user: '' })).toBe('alias')
    expect(firstEmptyField({ hostname: 'h.example.com', alias: 'h', user: '' })).toBe('user')
    expect(firstEmptyField({ hostname: 'h.example.com', alias: 'devbox', user: 'sam' }, true)).toBe('alias')
    expect(firstEmptyField({ hostname: 'h.example.com', alias: 'h', user: 'sam' })).toBe('hostname')
  })
})

describe('untouchedDraft: a new row nobody typed in', () => {
  it('is only a new row with every field empty', () => {
    expect(untouchedDraft(emptyHost())).toBe(true)
    expect(untouchedDraft({ ...emptyHost(), hostname: 'h' })).toBe(false)
    expect(untouchedDraft({ ...emptyHost(), port: 22 })).toBe(false)
    expect(untouchedDraft({ ...emptyHost(), savedAlias: 'devbox' })).toBe(false)
  })
})

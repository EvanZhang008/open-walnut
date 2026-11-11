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
  aliasFromHostname, aliasPlaceholder, connectAction, firstEmptyField, hostnameProblem, listSummary, liveLine, mapLinkLabel, needsLook, needsWords, nextLook,
  parseHostInput, summaryWords, untouchedDraft,
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

describe('listSummary and summaryWords: one line, from the rows, adding up to the rows shown', () => {
  it('puts every row in one count: online, not connected, off, found; drafts are no host yet', () => {
    const rows = [
      row({ key: 'fleet:__local__', host: '__local__', local: true, via: 'local', sessions: 3, spendUsd: 200 }),
      row({ key: 'ssh:1', online: true, sessions: 1, spendUsd: 41 }),
      row({ key: 'ssh:2', host: 'beta', online: false, needsLook: true, sessions: null, spendUsd: null }),
      row({ key: 'ssh:3', host: 'big', off: true, online: false, sessions: 5, spendUsd: 1 }),
      row({ key: 'ssh:5', host: 'lab-mac', counted: false, found: true, online: false, sessions: null, spendUsd: null }),
      row({ key: 'ssh:4', host: 'draft', counted: false, online: false }),
    ]
    const s = listSummary(rows)
    // The off host's session and its $1 are left out.
    expect(s).toEqual({ hosts: 5, online: 2, down: 1, off: 1, found: 1, sessions: 4, spendUsd: 241, needs: 1 })
    // 2026-11-05 review: "2 of 4 online, 1 off" sat above 6 rows. The counts now add up to the hosts.
    expect(s.online + s.down + s.off + s.found).toBe(s.hosts)
    expect(summaryWords(s)).toEqual({
      hosts: '5 hosts', online: '2 online', down: '1 not connected', off: '1 off', found: '1 found in ~/.ssh/config', sessions: '4 sessions open', spend: '$241 in 30 days',
    })
  })

  it('never counts a host turned off as needing a look (2026-11-05 review: an Off host still "needed a look")', () => {
    expect(listSummary([row({ off: true, online: false, needsLook: true }), row({ key: 'b', online: false, needsLook: true })]).needs).toBe(1)
  })

  it('moves at once with the rows: Turn on, Add, Remove', () => {
    const before = [row({ key: 'a' }), row({ key: 'b', off: true, online: false })]
    expect(summaryWords(listSummary(before))).toMatchObject({ hosts: '2 hosts', online: '1 online', down: null, off: '1 off' })
    // Turned on, still dialling: counted, not online yet.
    const on = [row({ key: 'a' }), row({ key: 'b', online: false })]
    expect(summaryWords(listSummary(on))).toMatchObject({ online: '1 online', down: '1 not connected', off: null })
    // A host added and saved.
    expect(summaryWords(listSummary([...on, row({ key: 'c' })]))).toMatchObject({ hosts: '3 hosts', online: '2 online' })
    // Removed.
    expect(summaryWords(listSummary([row({ key: 'a' })]))).toMatchObject({ hosts: '1 host', online: '1 online' })
  })

  it('leaves out what no row knows', () => {
    expect(summaryWords(listSummary([row({ sessions: null, spendUsd: null })]))).toEqual({ hosts: '1 host', online: '1 online', down: null, off: null, found: null, sessions: null, spend: null })
    expect(summaryWords(listSummary([row({ sessions: 1 })])).sessions).toBe('1 session open')
  })
})

describe('parseHostInput and hostnameProblem: a hostname is a host, or it says why not', () => {
  it('refuses what is no host, in words saying what one looks like (2026-11-05 review: "not a host!!" was saved)', () => {
    expect(hostnameProblem('not a host!!')).toBe('A hostname has no spaces. Type one like build7.example.com.')
    expect(hostnameProblem('nothost!!')).toBe('A hostname holds letters, digits, dots and dashes only ("!" is not one). Type one like build7.example.com.')
    expect(hostnameProblem('-bad.example.com')).toMatch(/starts and ends with a letter or digit/)
    expect(hostnameProblem('a..b')).toMatch(/starts and ends with a letter or digit/)
    expect(hostnameProblem('300.1.1.1')).not.toBeNull()
    expect(hostnameProblem('host:99999')).toBe('The part after ":" is the port: a number from 1 to 65535.')
    expect(hostnameProblem('host:')).toBe('The part after ":" is the port: a number from 1 to 65535.')
    expect(hostnameProblem('bad user@host')).toBe('A hostname has no spaces. Type one like build7.example.com.')
    expect(hostnameProblem('@host')).toMatch(/before "@" is the user/)
    expect(hostnameProblem('sam@')).toMatch(/Type the host after the "@"/)
    expect(hostnameProblem('[nothex]:22')).toMatch(/Brackets hold an IPv6 address/)
    // Empty is not refused here: the row says it waits for a hostname.
    expect(hostnameProblem('')).toBeNull()
    expect(hostnameProblem('   ')).toBeNull()
  })

  it('takes names, addresses, ssh config names, a user and a port', () => {
    for (const ok of ['build7.example.com', 'devbox', 'my_box', 'Build7.Example.COM', 'host.example.com.', '10.0.0.9', '::1', 'fe80::1', '[2001:db8::1]', 'xn--bcher-kva.example']) {
      expect(hostnameProblem(ok), ok).toBeNull()
    }
    expect(parseHostInput('sam@build7.example.com:2222')).toEqual({ ok: true, value: { host: 'build7.example.com', user: 'sam', port: 2222 } })
    expect(parseHostInput('build7:22')).toEqual({ ok: true, value: { host: 'build7', port: 22 } })
    expect(parseHostInput('[2001:db8::1]:2200')).toEqual({ ok: true, value: { host: '2001:db8::1', port: 2200 } })
    expect(parseHostInput('fe80::1')).toEqual({ ok: true, value: { host: 'fe80::1' } })
    expect(parseHostInput('  devbox  ')).toEqual({ ok: true, value: { host: 'devbox' } })
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

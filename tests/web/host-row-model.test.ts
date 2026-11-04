/**
 * The words of Remote Hosts' one list of machines (web/src/components/settings/sections/
 * host-row-model.ts): the summary line, a live host's one state line, the connect action's
 * busy words (2026-11-04 review: "Connect now" turned into "Retrying..."), the new host's
 * alias placeholder (it suggested an alias another host had) and the untouched draft that
 * Cancel and Escape take away with no confirm.
 */
import { describe, expect, it } from 'vitest'
import { aliasPlaceholder, connectAction, liveLine, needsLook, summaryWords, untouchedDraft } from '../../web/src/components/settings/sections/host-row-model'
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

describe('summaryWords: one line for the fleet', () => {
  it('says each part in words, and "need a look" only when one does', () => {
    expect(summaryWords({ online: 2, total: 3, sessions: 4, spendUsd: 362, problems: 2 })).toEqual({
      online: '2 of 3 online', sessions: '4 sessions open', spend: '$362 in 30 days', needs: '2 need a look',
    })
    expect(summaryWords({ online: 1, total: 1, sessions: 1, spendUsd: null, problems: 1 })).toEqual({
      online: '1 of 1 online', sessions: '1 session open', spend: null, needs: '1 needs a look',
    })
    expect(summaryWords({ online: 1, total: 1, sessions: null, spendUsd: null, problems: 0 }).needs).toBeNull()
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
  it('Connect now runs as Connecting..., Retry as Retrying...', () => {
    expect(connectAction(false, false).label).toBe('Connect now')
    expect(connectAction(false, true).label).toBe('Connecting...')
    expect(connectAction(true, false).label).toBe('Retry')
    expect(connectAction(true, true).label).toBe('Retrying...')
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

describe('untouchedDraft: a new row nobody typed in', () => {
  it('is only a new row with every field empty', () => {
    expect(untouchedDraft(emptyHost())).toBe(true)
    expect(untouchedDraft({ ...emptyHost(), hostname: 'h' })).toBe(false)
    expect(untouchedDraft({ ...emptyHost(), port: 22 })).toBe(false)
    expect(untouchedDraft({ ...emptyHost(), savedAlias: 'devbox' })).toBe(false)
  })
})

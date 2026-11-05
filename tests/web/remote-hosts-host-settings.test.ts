/**
 * Settings > Remote Hosts, round 4 (2026-11-04 review), the parts with no DOM:
 *  - a host's own settings live in its Details under "This host": a grant's line names no host
 *    (it is that host's part), and Walnut on the host that stopped or runs an older build counts
 *    in the page's one "need a look" (hostServerLook);
 *  - Secrets > Add refuses an empty Save at its first field, in field order (secretRefusal);
 *  - the network map colours a node as its row says it (topoKind): a host off is off whatever an
 *    old reading said.
 */
import { describe, expect, it } from 'vitest'
import { grantSummary } from '../../web/src/components/settings/sections/HostThisPart'
import { hostServerLook } from '../../web/src/components/settings/sections/host-settings-data'
import { secretRefusal } from '../../web/src/components/settings/sections/SecretsGroup'
import { topoKind } from '../../web/src/components/settings/sections/HostFleetTopology'
import type { HostServerEntry } from '../../web/src/components/settings/sections/host-servers-status'
import type { RowReport } from '../../web/src/components/settings/sections/host-row-model'

const T = Date.UTC(2026, 10, 4, 12)

describe('grantSummary: a grant in its host\'s part', () => {
  it('says when and what it ran, never the host again', () => {
    const g = { id: 'g1', taskId: 't1', taskTitle: 'Build', host: 'devbox', grantedAt: T, via: 'letter' as const, runs: 3, lastRunAt: T, lastCommand: 'make test' }
    const line = grantSummary(g)
    expect(line).toMatch(/^Allowed .*; 3 uses, last .*: make test$/)
    expect(line).not.toContain('devbox')
    expect(grantSummary({ ...g, via: 'own-host', runs: 0 })).toMatch(/^Allowed \(it runs on one of your hosts\) .*; not used yet$/)
  })
})

describe('hostServerLook: Walnut on a host counts in the one count', () => {
  const entry = (phase: string, over: Partial<HostServerEntry['settings']> = {}, notice?: string): HostServerEntry => ({
    hostKey: 'devbox', label: 'Dev box',
    settings: { enabled: true, expose: { enabled: false, provider: null, options: {} }, ...over },
    view: { hostKey: 'devbox', enabled: true, phase: phase as never, since: 0, ...(notice ? { notice } : {}) },
  })
  it('an error, an older build or a refused write needs a look; running, setting up or off does not', () => {
    expect(hostServerLook(entry('error'), false)).toBe(true)
    expect(hostServerLook(entry('running', {}, 'It runs 0.6.20; this Mac runs 0.6.25.'), false)).toBe(true)
    expect(hostServerLook(entry('running'), true)).toBe(true)
    expect(hostServerLook(entry('running'), false)).toBe(false)
    expect(hostServerLook(entry('starting'), false)).toBe(false)
    expect(hostServerLook(entry('error', { enabled: false }), true)).toBe(false)
  })
})

describe('secretRefusal: an empty Save says what is missing, at its field', () => {
  const none = () => false
  const empty = { name: '', value: '', sessions: false, env: '' }
  it('the first field in order, with words a person reads', () => {
    expect(secretRefusal(empty, true, none)).toEqual({ field: 'name', text: 'Give it a name, like github-read.' })
    expect(secretRefusal({ ...empty, name: 'GitHub Read' }, true, none)?.field).toBe('name')
    expect(secretRefusal({ ...empty, name: 'github-read' }, true, none)).toEqual({ field: 'value', text: 'Paste the value.' })
    expect(secretRefusal({ ...empty, name: 'github-read' }, true, (n) => n === 'github-read')?.text).toMatch(/already exists/)
    expect(secretRefusal({ name: 'github-read', value: 'x', sessions: true, env: '' }, true, none)?.field).toBe('env')
    expect(secretRefusal({ name: 'github-read', value: 'x', sessions: true, env: 'GH_TOKEN' }, true, none)).toBeNull()
  })
  it('a rotate keeps the value optional', () => {
    expect(secretRefusal({ name: 'github-read', value: '', sessions: false, env: '' }, false, () => true)).toBeNull()
  })
})

describe('topoKind: a node as its row says it', () => {
  const row = (over: Partial<RowReport>): RowReport => ({ key: 'k', host: 'h', name: 'H', counted: true, online: true, off: false, needsLook: false, local: false, via: 'ssh', rttMs: 38, sessions: null, spendUsd: null, sub: '', ...over })
  it('off, not connected, needs a look, or fine', () => {
    expect(topoKind(row({ off: true, online: true }))).toBe('off')
    expect(topoKind(row({ online: false }))).toBe('failed')
    expect(topoKind(row({ needsLook: true }))).toBe('warn')
    expect(topoKind(row({}))).toBe('connected')
    expect(topoKind(row({ local: true, online: false }))).toBe('connected')
  })
})

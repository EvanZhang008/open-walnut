/**
 * Settings > Remote Hosts: an alias another host has never reaches the save (2026-11-04
 * review, data loss: a new SSH row typed as `devbox`, the alias Alpha box already had, took
 * over its status and the autosave wrote it over Alpha box: hostname, user and label gone).
 * The row is refused next to its field, nothing saves while one is, and the hosts map the
 * save builds keeps the first row's host whatever a later row says.
 */
import { describe, expect, it } from 'vitest'
import type { Config } from '../../src/core/types'
import {
  aliasRefusals, emptyHost, entriesToHosts, hiddenAsTwin, hostsFromConfig, limitsRead, refusalBlocks, refusalBlocksSave, type HostEntry,
} from '../../web/src/components/settings/sections/remote-hosts-model'

const config = {
  hosts: {
    devbox: { hostname: 'alpha.example.com', user: 'dev', label: 'Alpha box' },
    downbox: { hostname: 'beta.example.com', label: 'Beta box' },
    'gpu-box': { hostname: 'gpu-box', transport: 'net' },
  },
} as unknown as Config

function withDraft(alias: string, hostname = ''): HostEntry[] {
  return [...hostsFromConfig(config), { ...emptyHost(), alias, hostname }]
}

describe('a new SSH host with an alias already in use', () => {
  it('never replaces the saved host in what the save writes', () => {
    const hosts = withDraft('devbox', 'dup.example.com')
    expect(entriesToHosts(hosts).devbox).toEqual({
      hostname: 'alpha.example.com', user: 'dev', port: undefined, label: 'Alpha box', shell_setup: undefined, enabled: true, discovered: false,
    })
    expect(Object.keys(entriesToHosts(hosts))).toEqual(['devbox', 'downbox'])
  })

  it('is refused next to its field with the other host named, and holds the save', () => {
    const hosts = withDraft('devbox')
    const refusals = aliasRefusals(hosts, { savedUnderCompanion: false })
    const draft = hosts[hosts.length - 1]
    expect(refusals.get(draft._key)).toBe('devbox is already Alpha box. Pick another alias.')
    // The saved host keeps its alias: only the later row is refused.
    expect(refusals.has(hosts[0]._key)).toBe(false)
    expect(refusalBlocksSave(hosts, refusals, false)).toBe(true)
  })

  it('a machine that joined with a link holds its alias too', () => {
    const hosts = withDraft('gpu-box', 'gpu.example.com')
    const refusals = aliasRefusals(hosts, { savedUnderCompanion: false, netAliases: { 'gpu-box': 'GPU box' } })
    expect(refusals.get(hosts[hosts.length - 1]._key)).toBe('gpu-box is already GPU box. Pick another alias.')
  })

  it('an alias of its own saves, and so does a fresh empty row (nothing to refuse yet)', () => {
    const ok = withDraft('labbox', 'lab.example.com')
    expect(aliasRefusals(ok, { savedUnderCompanion: false }).size).toBe(0)
    expect(entriesToHosts(ok).labbox?.hostname).toBe('lab.example.com')
    expect(aliasRefusals(withDraft(''), { savedUnderCompanion: false }).size).toBe(0)
  })

  it('a hostname with no alias is refused, and so is the companion\'s alias', () => {
    const noAlias = withDraft('', 'lab.example.com')
    expect(aliasRefusals(noAlias, { savedUnderCompanion: false }).get(noAlias[noAlias.length - 1]._key)).toBe('Give it an alias, like devbox.')
    const companion = withDraft('companion', 'c.example.com')
    const refusals = aliasRefusals(companion, { savedUnderCompanion: false })
    expect(refusals.get(companion[companion.length - 1]._key)).toMatch(/taken by the cloud companion/)
    expect(refusalBlocksSave(companion, refusals, false)).toBe(true)
  })

  it('a host an older build saved under the companion\'s alias keeps saving; a new row typed with it does not', () => {
    const old = { hosts: { companion: { hostname: 'c.example.com' } } } as unknown as Config
    const hosts = hostsFromConfig(old)
    const refusals = aliasRefusals(hosts, { savedUnderCompanion: true })
    expect(refusals.size).toBe(1)
    expect(refusalBlocks(hosts[0], refusals.get(hosts[0]._key), true)).toBe(false)
    expect(refusalBlocksSave(hosts, refusals, true)).toBe(false)
    // The saved row renamed away, and a new row typed with the companion's alias: that one is held.
    const typed = [{ ...hosts[0], alias: 'cbox' }, { ...emptyHost(), alias: 'companion', hostname: 'x.example.com' }]
    const r2 = aliasRefusals(typed, { savedUnderCompanion: true })
    expect(refusalBlocksSave(typed, r2, true)).toBe(true)
  })
})

describe('of two rows with one alias, the host saved under it keeps it', () => {
  it('renaming Beta box to devbox refuses Beta box, never Alpha box, saved as devbox', () => {
    const hosts = hostsFromConfig(config)
    const renamed = hosts.map((h) => (h.alias === 'downbox' ? { ...h, alias: 'devbox' } : h))
    // Beta box first in the list this time, to show the order does not decide.
    const rows = [renamed[1], renamed[0]]
    const refusals = aliasRefusals(rows, { savedUnderCompanion: false })
    const beta = rows.find((h) => h.label === 'Beta box')!
    const alpha = rows.find((h) => h.label === 'Alpha box')!
    expect(refusals.get(beta._key)).toBe('devbox is already Alpha box. Pick another alias.')
    expect(refusals.has(alpha._key)).toBe(false)
    expect(entriesToHosts(rows).devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
  })

  it('a host added here and saved since keeps its alias against a later row', () => {
    const added = { ...emptyHost(), alias: 'labbox', hostname: 'lab.example.com' }
    const later = { ...emptyHost(), alias: 'labbox', hostname: 'other.example.com' }
    // An older row renamed to it comes first in the list, and still loses to the saved one.
    const renamed = { ...hostsFromConfig(config)[1], alias: 'labbox' }
    const rows = [renamed, added, later]
    const refusals = aliasRefusals(rows, { savedUnderCompanion: false, saved: new Set(['devbox', 'downbox', 'labbox']) })
    expect(refusals.has(added._key)).toBe(false)
    expect(refusals.has(renamed._key)).toBe(true)
    expect(refusals.has(later._key)).toBe(true)
    expect(entriesToHosts(rows, new Set(['labbox'])).labbox?.hostname).toBe('lab.example.com')
  })

  it('a row found in ~/.ssh/config that is a joined machine hides; a row typed with its alias shows, refused', () => {
    const found = hostsFromConfig({ hosts: { 'studio-mac': { hostname: 'studio.local', discovered: true, connect: 'yes' } } } as unknown as Config)[0]
    const typed = { ...emptyHost(), alias: 'studio-mac', hostname: 'studio.example.com' }
    const twins = { 'studio-mac': 'gpu-box' }
    const refusals = aliasRefusals([found, typed], { savedUnderCompanion: false })
    expect(hiddenAsTwin(found, twins, refusals.get(found._key))).toBe(true)
    expect(refusals.get(typed._key)).toMatch(/^studio-mac is already/)
    expect(hiddenAsTwin(typed, twins, refusals.get(typed._key))).toBe(false)
  })
})

// 2026-11-05 (WebKit, a loaded host): Session limit 4 saved, then the box cleared; the echo of the
// first save came back after the clearing, put 4 back in the box, and the cleared value never saved.
describe('limitsRead: a config read never takes a session limit typed and not saved yet', () => {
  const L = (o: Record<string, number>) => JSON.stringify(o)
  it('the first look fills the boxes', () => {
    expect(limitsRead({ incoming: L({ devbox: 3 }), seen: null, shown: L({}), sent: [] })).toEqual({ take: true, sent: [] })
  })
  it('the echo of an earlier save, after the next value was typed, keeps the typed value', () => {
    const r = limitsRead({ incoming: L({ devbox: 4 }), seen: L({ devbox: 3 }), shown: L({}), sent: [L({ devbox: 4 })] })
    expect(r).toEqual({ take: false, sent: [] })
  })
  it('two saves in flight: the first echo keeps the second save, and drops only itself', () => {
    const r = limitsRead({ incoming: L({ devbox: 4 }), seen: L({ devbox: 3 }), shown: L({}), sent: [L({ devbox: 4 }), L({})] })
    expect(r).toEqual({ take: false, sent: [L({})] })
  })
  it('a change from elsewhere fills the boxes when nothing typed waits', () => {
    expect(limitsRead({ incoming: L({ devbox: 9 }), seen: L({ devbox: 3 }), shown: L({ devbox: 3 }), sent: [] }).take).toBe(true)
  })
  it('a change from elsewhere while a value waits for its save keeps the typed value (it saves and wins)', () => {
    expect(limitsRead({ incoming: L({ devbox: 9 }), seen: L({ devbox: 3 }), shown: L({ devbox: 5 }), sent: [] }).take).toBe(false)
  })
  it('a read about something else changes nothing', () => {
    expect(limitsRead({ incoming: L({ devbox: 3 }), seen: L({ devbox: 3 }), shown: L({ devbox: 5 }), sent: [] }).take).toBe(false)
  })
})

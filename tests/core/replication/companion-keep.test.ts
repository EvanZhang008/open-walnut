/**
 * Where the companion's keep choice lives (src/core/replication/companion-keep.ts): one
 * reader for the server and Settings, the move of an older build's keys into cloud_bridge,
 * and the alias a real host may not take.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPANION_ALIAS, companionAliasRefusal, companionCopiesOf, companionKeepOf, migrateLegacyCompanionKeep,
} from '../../../src/core/replication/companion-keep.js'

type Cfg = Parameters<typeof companionKeepOf>[0]

describe('companionKeepOf / companionCopiesOf', () => {
  it('cloud_bridge first; else the older hosts.companion keys; else undefined (everything)', () => {
    expect(companionKeepOf({})).toBeUndefined()
    expect(companionCopiesOf({})).toBeUndefined()
    const legacy = { hosts: { companion: { keep: { notes: false }, server: { copies: { inbox: false } } } } } as unknown as Cfg
    expect(companionKeepOf(legacy)).toEqual({ notes: false })
    expect(companionCopiesOf(legacy)).toEqual({ inbox: false })
    const both = { ...legacy, cloud_bridge: { keep: { memory: false }, copies: { sessions: false } } } as unknown as Cfg
    expect(companionKeepOf(both)).toEqual({ memory: false })
    expect(companionCopiesOf(both)).toEqual({ sessions: false })
  })

  it('a hosts.companion with a hostname is a real host: never read as the companion\'s', () => {
    const real = { hosts: { companion: { hostname: 'box.example', keep: { notes: false }, server: { copies: { inbox: false } } } } } as unknown as Cfg
    expect(companionKeepOf(real)).toBeUndefined()
    expect(companionCopiesOf(real)).toBeUndefined()
  })
})

describe('migrateLegacyCompanionKeep', () => {
  it('moves keep and server.copies into cloud_bridge, drops them, and drops an emptied hosts.companion', () => {
    const c: Record<string, unknown> = {
      cloud_bridge: { enabled: true, url: 'wss://example.test' },
      hosts: { companion: { keep: { notes: false }, server: { copies: { inbox: false } } }, dev: { hostname: 'dev.example' } },
    }
    expect(migrateLegacyCompanionKeep(c)).toBe(true)
    expect(c).toEqual({
      cloud_bridge: { enabled: true, url: 'wss://example.test', keep: { notes: false }, copies: { inbox: false } },
      hosts: { dev: { hostname: 'dev.example' } },
    })
    // A second pass changes nothing.
    expect(migrateLegacyCompanionKeep(c)).toBe(false)
  })

  it('cloud_bridge\'s own choice wins; the older key still goes', () => {
    const c: Record<string, unknown> = {
      cloud_bridge: { keep: { memory: false } },
      hosts: { companion: { keep: { notes: false } } },
    }
    expect(migrateLegacyCompanionKeep(c)).toBe(true)
    expect(c).toEqual({ cloud_bridge: { keep: { memory: false } }, hosts: {} })
  })

  it('keeps what else the entry holds (another server setting), only the moved keys go', () => {
    const c: Record<string, unknown> = { hosts: { companion: { label: 'old', server: { copies: { sessions: false }, port: 1 } } } }
    expect(migrateLegacyCompanionKeep(c)).toBe(true)
    expect(c).toEqual({ cloud_bridge: { copies: { sessions: false } }, hosts: { companion: { label: 'old', server: { port: 1 } } } })
  })

  it('leaves a real host named companion, and a config with nothing to move, as they are', () => {
    const real: Record<string, unknown> = { hosts: { companion: { hostname: 'box.example', keep: { notes: false } } } }
    const before = JSON.stringify(real)
    expect(migrateLegacyCompanionKeep(real)).toBe(false)
    expect(JSON.stringify(real)).toBe(before)
    const plain: Record<string, unknown> = { hosts: { companion: { label: 'x' } } }
    expect(migrateLegacyCompanionKeep(plain)).toBe(false)
    expect(plain).toEqual({ hosts: { companion: { label: 'x' } } })
    expect(migrateLegacyCompanionKeep({})).toBe(false)
  })
})

describe('companionAliasRefusal', () => {
  it('refuses exactly the companion alias, with a plain message', () => {
    expect(COMPANION_ALIAS).toBe('companion')
    expect(companionAliasRefusal('companion')).toMatch(/taken by the cloud companion/)
    expect(companionAliasRefusal(' companion ')).toMatch(/another alias/)
    for (const ok of ['companion-2', 'Companion', 'my-companion', 'dev']) expect(companionAliasRefusal(ok)).toBeNull()
    // One an older build saved there: asked to move, with why.
    expect(companionAliasRefusal('companion', { saved: true })).toMatch(/share their copy rounds\. Give this host another alias/)
    expect(companionAliasRefusal('dev', { saved: true })).toBeNull()
  })
})

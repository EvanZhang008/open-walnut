/**
 * What Settings calls the tunnel way (web/src/components/settings/sections/cloud/tunnel-name.ts):
 * a plugin's tunnel names it after itself, so the person reads which plugin added this way of
 * reaching Walnut; Walnut's own command tunnel, or none, is "Tunnel". There is no "browser link"
 * any more (2026-11-18), and a name not known yet is null, never a name that then changes.
 */
import { describe, expect, it } from 'vitest'
import { TUNNEL_TITLE, tunnelName, tunnelSubtitle } from '../../web/src/components/settings/sections/cloud/tunnel-name'
import { deriveWays } from '../../web/src/components/settings/sections/cloud/ways-model'
import { optionFits } from '../../web/src/components/settings/sections/cloud/browser-access-status'

const acme = { id: 'acme-tunnel', title: 'Acme Tunnel', owner: 'acme-plugin', options: [] }
const other = { id: 'other', title: 'Other Tunnel', owner: 'other-plugin', options: [] }
const command = { id: 'command', title: 'Custom command', owner: 'core', options: [] }
const settings = (provider: string | null) => ({ enabled: false, provider, options: {} })

describe('tunnelName', () => {
  it('a plugin tunnel names the way after itself', () => {
    expect(tunnelName({ providers: [acme, command], settings: settings(null) })).toEqual({ title: 'Acme Tunnel', plugin: 'Acme Tunnel' })
    expect(tunnelName({ providers: [acme, other], settings: settings('other') })).toEqual({ title: 'Other Tunnel', plugin: 'Other Tunnel' })
  })

  it('no plugin tunnel, the command one picked, or several with none picked: "Tunnel"', () => {
    for (const resp of [
      { providers: [], settings: settings(null) },
      { providers: [command], settings: settings('command') },
      { providers: [acme, command], settings: settings('command') },
      { providers: [acme, other], settings: settings(null) },
    ]) {
      expect(tunnelName(resp)).toEqual({ title: TUNNEL_TITLE, plugin: null })
    }
    expect(TUNNEL_TITLE).toBe('Tunnel')
  })

  it('not known yet: no answer, or a provider config.yaml names that is not registered (its plugin still loads)', () => {
    expect(tunnelName(null)).toBeNull()
    expect(tunnelName({ providers: [command], settings: settings('acme-tunnel') })).toBeNull()
    expect(tunnelName({ providers: [], settings: settings('acme-tunnel') })).toBeNull()
  })

  it('the line under it says which plugin added it, and never "browser link"', () => {
    expect(tunnelSubtitle({ title: 'Acme Tunnel', plugin: 'Acme Tunnel' })).toMatch(/\(from the Acme Tunnel plugin\)\.$/)
    expect(tunnelSubtitle({ title: TUNNEL_TITLE, plugin: null })).not.toMatch(/plugin/)
    for (const name of [{ title: 'Acme Tunnel', plugin: 'Acme Tunnel' }, { title: TUNNEL_TITLE, plugin: null }]) {
      expect(tunnelSubtitle(name)).not.toMatch(/browser link/i)
    }
  })

  it('the Phones & Cloud tab wears the same name, and none while it is not known', () => {
    const base = { listState: 'ready' as const, phoneUses: [], targets: [], cloudError: null, cloudUnpaired: false, expose: null }
    const card = (linkName?: { title: string; plugin: string | null } | null) => deriveWays({ ...base, linkName }).ways.find((w) => w.id === 'browser')!
    expect(card().title).toBe(TUNNEL_TITLE)
    expect(card({ title: 'Acme Tunnel', plugin: 'Acme Tunnel' })).toMatchObject({ title: 'Acme Tunnel', what: expect.stringMatching(/Acme Tunnel plugin/) })
    expect(card(null).title).toBe('')
    expect(card(null).what).not.toMatch(/browser link|plugin/i)
  })
})

describe('optionFits (a hidden option shows its field only when the saved value does not fit)', () => {
  const option = { pattern: '[a-z0-9-]{1,30}' }
  it('nothing saved, or a blank value, is the provider default and fits', () => {
    for (const saved of [undefined, '', '   ']) expect(optionFits(option, saved)).toBe(true)
  })
  it('a saved value fits only when it matches the pattern', () => {
    expect(optionFits(option, 'wn-1a2b3c')).toBe(true)
    expect(optionFits(option, 'Not A Name!')).toBe(false)
    expect(optionFits({}, 'anything')).toBe(true)
  })
})

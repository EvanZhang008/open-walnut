/**
 * What Settings calls the browser link (web/src/components/settings/sections/cloud/browser-link-name.ts):
 * a plugin's tunnel names it after itself, so the person reads which plugin added this way of
 * reaching Walnut; Walnut's own command tunnel, or none, keeps "Browser link".
 */
import { describe, expect, it } from 'vitest'
import { BROWSER_LINK_TITLE, browserLinkName, browserLinkSubtitle } from '../../web/src/components/settings/sections/cloud/browser-link-name'
import { deriveWays } from '../../web/src/components/settings/sections/cloud/ways-model'
import { optionFits } from '../../web/src/components/settings/sections/cloud/browser-access-status'

const acme = { id: 'acme-tunnel', title: 'Acme Tunnel', owner: 'acme-plugin', options: [] }
const other = { id: 'other', title: 'Other Tunnel', owner: 'other-plugin', options: [] }
const command = { id: 'command', title: 'Custom command', owner: 'core', options: [] }
const settings = (provider: string | null) => ({ enabled: false, provider, options: {} })

describe('browserLinkName', () => {
  it('a plugin tunnel names the way after itself', () => {
    expect(browserLinkName({ providers: [acme, command], settings: settings(null) })).toEqual({ title: 'Acme Tunnel', plugin: 'Acme Tunnel' })
    expect(browserLinkName({ providers: [acme, other], settings: settings('other') })).toEqual({ title: 'Other Tunnel', plugin: 'Other Tunnel' })
  })

  it('no plugin tunnel, the command one picked, or several with none picked: "Browser link"', () => {
    for (const resp of [
      null,
      { providers: [], settings: settings(null) },
      { providers: [command], settings: settings('command') },
      { providers: [acme, command], settings: settings('command') },
      { providers: [acme, other], settings: settings(null) },
    ]) {
      expect(browserLinkName(resp)).toEqual({ title: BROWSER_LINK_TITLE, plugin: null })
    }
  })

  it('the line under it says which plugin added it', () => {
    expect(browserLinkSubtitle({ title: 'Acme Tunnel', plugin: 'Acme Tunnel' })).toMatch(/added by the Acme Tunnel plugin/)
    expect(browserLinkSubtitle({ title: BROWSER_LINK_TITLE, plugin: null })).not.toMatch(/plugin/)
  })

  it('the Phones & Cloud card wears the same name', () => {
    const base = { listState: 'ready' as const, phoneUses: [], targets: [], cloudError: null, cloudUnpaired: false, expose: null }
    const card = (linkName?: { title: string; plugin: string | null }) => deriveWays({ ...base, linkName }).ways.find((w) => w.id === 'browser')!
    expect(card().title).toBe(BROWSER_LINK_TITLE)
    expect(card({ title: 'Acme Tunnel', plugin: 'Acme Tunnel' })).toMatchObject({ title: 'Acme Tunnel', what: expect.stringMatching(/Acme Tunnel plugin/) })
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

/**
 * A plugin that registers a tunnel provider leads to the browser link page; one that does not
 * shows nothing, and the row says when the link already runs through it.
 */
import { describe, expect, it } from 'vitest'
import { BROWSER_LINK_PANE, exposeGuideFor, type ExposeOverview } from '../../web/src/components/apps-page/ExposeGuide'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry'

const view = (status: Partial<ExposeOverview['status']> = {}): ExposeOverview => ({
  providers: [{ id: 'acme-tunnel', title: 'Acme Tunnel', owner: 'acme' }, { id: 'built-in', title: 'Built in' }],
  status: { enabled: false, provider: null, ...status },
})

describe('exposeGuideFor', () => {
  it('names the provider a plugin brings, off until the link uses it', () => {
    expect(exposeGuideFor(view(), ['acme'])).toEqual({ title: 'Acme Tunnel', on: false })
    expect(exposeGuideFor(view({ enabled: true, provider: 'acme-tunnel' }), ['other', 'acme'])).toEqual({ title: 'Acme Tunnel', on: true })
    expect(exposeGuideFor(view({ enabled: true, provider: 'built-in' }), ['acme'])).toEqual({ title: 'Acme Tunnel', on: false })
  })

  it('says nothing for a plugin with no provider, or before the list is read', () => {
    expect(exposeGuideFor(view(), ['other'])).toBeNull()
    expect(exposeGuideFor(view(), [])).toBeNull()
    expect(exposeGuideFor(null, ['acme'])).toBeNull()
  })

  it('leads to a Settings page that exists', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS.some((entry) => entry.id === BROWSER_LINK_PANE)).toBe(true)
  })
})

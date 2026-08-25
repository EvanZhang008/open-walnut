import { describe, expect, it } from 'vitest'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry.js'

const EXPECTED_IDS = [
  'apps', 'repositories', 'hooks',
  'providers', 'general', 'sessions', 'focus-tiers', 'integrations', 'calendar',
  'permissions', 'plugin-store', 'search', 'stt', 'audio-capture', 'heartbeat',
  // No `time` row: time tracking's only UI is the walnut-time Plugin App, and the
  // duplicate Settings section was deleted in 95473094. `timeline` below is a
  // different feature (the screen-activity Life Tracker) and stayed.
  'backup', 'remote-hosts', 'devices', 'cloud', 'advanced', 'usage', 'timeline', 'bug-report',
]

describe('core settings registry', () => {
  it('keeps one owner-scoped source of truth for page and navigation order', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS.map((entry) => entry.id)).toEqual(EXPECTED_IDS)
    expect(new Set(EXPECTED_IDS).size).toBe(EXPECTED_IDS.length)
    expect(CORE_SETTINGS_CONTRIBUTIONS.every((entry) => entry.owner === 'walnut')).toBe(true)
  })

  it('keeps the plugin section id stable while its label reads as what it is', () => {
    // The id is a contract: `#plugin-store` deep links, the `settings-nav-plugin-store`
    // testid and several specs address it. The LABEL is free to say "Plugins".
    const plugins = CORE_SETTINGS_CONTRIBUTIONS.find((entry) => entry.id === 'plugin-store')
    expect(plugins).toBeDefined()
    expect(plugins!.label).toBe('Plugins')
    expect(plugins!.title).toBe('Plugins')
  })

  it('keeps the existing Manage and Configure split', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'manage')
      .map((entry) => entry.id)).toEqual(['apps', 'repositories', 'hooks'])
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'configure')
      .map((entry) => entry.id)).toEqual(EXPECTED_IDS.slice(3))
  })
})

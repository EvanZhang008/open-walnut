import { describe, expect, it } from 'vitest'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry.js'

const EXPECTED_IDS = [
  // No `apps` row either: a plugin's app entries are managed on the plugin's own
  // row in the Plugins section (PluginAppControls) — one panel is the start point
  // for everything plugin-shaped.
  'repositories', 'hooks',
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

  it('keeps the Manage / Plugins / Configure split', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'manage')
      .map((entry) => entry.id)).toEqual(['repositories', 'hooks'])
    // The Plugins group holds everything plugin-shaped: this section anchors it,
    // and the nav adds settings-placed plugin Apps + plugin settings panels to it.
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'plugins')
      .map((entry) => entry.id)).toEqual(['plugin-store'])
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'configure')
      .map((entry) => entry.id)).toEqual(EXPECTED_IDS.slice(2).filter((id) => id !== 'plugin-store'))
  })
})

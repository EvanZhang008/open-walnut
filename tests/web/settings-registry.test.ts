import { describe, expect, it } from 'vitest'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry.js'

const EXPECTED_IDS = [
  // No `apps` row either: a plugin's app entries are managed on the plugin's own
  // row in the Plugins section (PluginAppControls) — one panel is the start point
  // for everything plugin-shaped.
  'repositories', 'hooks',
  // ARRAY ORDER IS PAGE ORDER: plugin-store sits directly after the Manage
  // sections because the nav's Plugins group renders between Manage and
  // Configure — nav order and scroll order must agree or a click lands wrong.
  'plugin-store',
  'providers', 'general',
  // Tasks owns task defaults + Task Summary; Focus Tiers renders under it and
  // shares its nav entry (navHidden).
  'tasks', 'focus-tiers', 'sessions',
  // `stt` is labelled Voice and also carries Text-to-Speech now.
  'stt', 'audio-capture', 'integrations', 'calendar', 'permissions', 'heartbeat', 'search', 'backup',
  // Phones & Cloud: `devices` is the nav entry, `cloud` renders under it (navHidden).
  'devices', 'cloud', 'remote-hosts', 'advanced',
  // Diagnostics group. No `time` row: time tracking's only UI is the walnut-time
  // Plugin App, and the duplicate Settings section was deleted in 95473094.
  // `timeline` below is a different feature (the screen-activity Life Tracker,
  // labelled Screen Tracking) and stayed.
  'usage', 'suggest-accuracy', 'timeline', 'bug-report',
]
const DIAGNOSTICS_IDS = ['usage', 'suggest-accuracy', 'timeline', 'bug-report']

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

  it('keeps the Manage / Plugins / Configure / Diagnostics split', () => {
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
      .map((entry) => entry.id)).toEqual(EXPECTED_IDS.slice(3, -DIAGNOSTICS_IDS.length))
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'diagnostics')
      .map((entry) => entry.id)).toEqual(DIAGNOSTICS_IDS)
  })

  it('folds a nav-hidden section under the visible entry directly above it', () => {
    // A navHidden row keeps its #id deep link but has no nav button; the nav
    // highlights the previous visible entry when the scroll spy lands on it.
    const hidden = CORE_SETTINGS_CONTRIBUTIONS.filter((entry) => entry.navHidden).map((entry) => entry.id)
    expect(hidden).toEqual(['focus-tiers', 'cloud'])
    for (const id of hidden) {
      const idx = CORE_SETTINGS_CONTRIBUTIONS.findIndex((entry) => entry.id === id)
      expect(CORE_SETTINGS_CONTRIBUTIONS[idx - 1].navHidden).toBeUndefined()
      expect(CORE_SETTINGS_CONTRIBUTIONS[idx - 1].group).toBe(CORE_SETTINGS_CONTRIBUTIONS[idx].group)
    }
  })

  it('names sections so they do not collide with pages or each other', () => {
    const labels = CORE_SETTINGS_CONTRIBUTIONS.map((entry) => entry.label)
    expect(new Set(labels).size).toBe(labels.length)
    // "Calendar" is a page in the app sidebar; "Permissions" reads as the session
    // permission prompts; "Timeline" collided with the Time plugin app.
    expect(labels).not.toContain('Calendar')
    expect(labels).not.toContain('Permissions')
    expect(labels).not.toContain('Timeline')
    expect(labels).not.toContain('Tasks & Sessions')
  })
})

import { describe, expect, it } from 'vitest'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry.js'
import { isSettingsGlyph, tileKey } from '../../web/src/components/settings/settings-icons.js'

const EXPECTED_IDS = [
  // No `plugin-store` (Plugins) and no `apps` row: every plugin and App lives on the
  // Apps page (/apps). The nav's Plugins group links there (SettingsNav) and the old
  // `#plugin-store` hash forwards there (SettingsPage).
  // No `repositories` row for now either: the feature is hidden until ready
  // (ReposSection and its API stay; only the Settings entry is gone).
  'hooks',
  // No separate chat-engine or provider entry: the one default engine lives in
  // Engines, and the API alternative is folded under Advanced (last below).
  'general',
  // Tasks owns task defaults + Task Summary; Focus Tiers renders under it and
  // shares its nav entry (navHidden).
  // Sessions = how Walnut runs an engine; Engines = the engine's OWN settings
  // (its command-line config screen's keys) on the host the sessions run on.
  // Engines sits directly after Sessions, which is the next question a reader asks.
  'tasks', 'focus-tiers', 'tags', 'sessions', 'engines',
  // `stt` is labelled Voice and also carries Text-to-Speech now.
  // No `jev` row: Jev is one runner choice inside Tasks › Smart task creation.
  // Inbox Triage sits directly after Heartbeat: both are "Walnut wakes itself up
  // and works", and it is the question a reader asks next. Mail rules follows
  // Triage, which reads only Important mail when grouping is on.
  'stt', 'audio-capture', 'integrations', 'calendar', 'permissions', 'heartbeat', 'triage', 'mail-rules', 'search', 'backup',
  // Phones & Cloud: `devices` is the nav entry, `cloud` renders under it (navHidden).
  'devices', 'cloud', 'remote-hosts', 'advanced',
  // Use an API instead of Claude Code: renders under Advanced (navHidden).
  'providers',
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

  it('has no Plugins section: plugins moved to the Apps page', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS.find((entry) => entry.id === 'plugin-store')).toBeUndefined()
  })

  it('keeps the Manage / Plugins / Configure / Diagnostics split', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'manage')
      .map((entry) => entry.id)).toEqual(['hooks'])
    // The Plugins group has no core section now: the nav fills it with the Apps link
    // and the plugins' own settings panels (Apps live on the Sidebar or the Apps page).
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'plugins')
      .map((entry) => entry.id)).toEqual([])
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'configure')
      .map((entry) => entry.id)).toEqual(EXPECTED_IDS.slice(1, -DIAGNOSTICS_IDS.length))
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'diagnostics')
      .map((entry) => entry.id)).toEqual(DIAGNOSTICS_IDS)
  })

  it('folds a nav-hidden section under the nearest visible entry above it', () => {
    // A navHidden row keeps its #id deep link but has no nav button; it mounts
    // in the pane of the nearest visible entry above it (NAV_OWNER), so Tags sits
    // in the Tasks pane after Focus Tiers.
    const hidden = CORE_SETTINGS_CONTRIBUTIONS.filter((entry) => entry.navHidden).map((entry) => entry.id)
    expect(hidden).toEqual(['focus-tiers', 'tags', 'cloud', 'providers'])
    for (const id of hidden) {
      const idx = CORE_SETTINGS_CONTRIBUTIONS.findIndex((entry) => entry.id === id)
      const owner = CORE_SETTINGS_CONTRIBUTIONS.slice(0, idx).reverse().find((entry) => !entry.navHidden)
      expect(owner).toBeDefined()
      expect(owner!.group).toBe(CORE_SETTINGS_CONTRIBUTIONS[idx].group)
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

  it('gives every entry a tile, one sentence and filter keywords', () => {
    for (const entry of CORE_SETTINGS_CONTRIBUTIONS) {
      expect(isSettingsGlyph(entry.icon), `${entry.id} icon`).toBe(true)
      expect(entry.tint, `${entry.id} tint`).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(entry.description.trim().length, `${entry.id} description`).toBeGreaterThan(0)
      // One sentence: nothing after an inner full stop, no em or en dash.
      expect(entry.description.replace(/\.$/, ''), `${entry.id} description`).not.toMatch(/\. /)
      expect(entry.description, `${entry.id} description`).not.toMatch(/[\u2013\u2014]/)
      expect(entry.keywords.length, `${entry.id} keywords`).toBeGreaterThan(0)
      for (const k of entry.keywords) {
        const word = typeof k === 'string' ? k : k.word
        expect(word, `${entry.id} keyword`).toBe(word.toLowerCase())
        expect(word.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps visible tiles distinct by tint and glyph', () => {
    const visible = CORE_SETTINGS_CONTRIBUTIONS.filter((entry) => !entry.navHidden)
    const keys = visible.map((entry) => tileKey(entry.tint, entry.icon))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

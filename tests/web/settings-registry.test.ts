import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry.js'
import { PHONES_CLOUD_TABS } from '../../web/src/components/settings/settings-way-panes'
import { isSettingsGlyph, tileKey } from '../../web/src/components/settings/settings-icons.js'

const EXPECTED_IDS = [
  // No `plugin-store` (Plugins) and no `apps` row: every plugin, its settings panels and
  // every App live on the Apps page (/apps), and Settings has no Plugins group at all. The
  // old `#plugin-store` and `#<plugin>:<panel>` hashes forward there (SettingsPage).
  // No `repositories` row for now either: the feature is hidden until ready
  // (ReposSection and its API stay; only the Settings entry is gone).
  'hooks',
  // No separate chat-engine or provider entry: the one default engine lives in
  // Sessions, and the API alternative is folded under Advanced (last below).
  'general',
  // Tasks owns task defaults + Task Summary; Focus Tiers renders under it and
  // shares its nav entry (navHidden).
  // Sessions = how Walnut runs an engine, its default engine included. No
  // Engines entry (removed 2026-10-27): an engine's OWN settings are in the
  // session's Engine settings popover.
  // Task providers (2026-11-02): each plugin that syncs tasks, with the rules a task must
  // pass before it syncs there.
  'tasks', 'focus-tiers', 'tags', 'task-providers', 'sessions',
  // `stt` is labelled Voice and also carries Text-to-Speech now.
  // No `jev` row: Jev is one runner choice inside Tasks › Smart task creation.
  // No Integrations or Heartbeat entry (removed 2026-10-27). Mail rules follows
  // Triage, which reads only Important mail when grouping is on.
  // Org (2026-11-03): the switch that turns Main and the VPs off.
  // Passwords (2026-11-03): the vault's auto-lock, agent access, master password and export.
  'stt', 'audio-capture', 'calendar', 'permissions', 'org', 'triage', 'mail-rules', 'search', 'passwords', 'browser', 'backup',
  // Phones & Cloud: `devices` is the entry; its four tabs are panes of their own
  // (`tabOf: 'devices'`), the Cloud companion one keeping the old `#cloud` link.
  'devices', 'cloud', 'devices-tailscale', 'devices-browser', 'devices-phones', 'remote-hosts', 'advanced',
  // Use an API instead of Claude Code: renders under Advanced (navHidden).
  'providers',
  // Diagnostics group. No `time` row: time tracking's only UI is the walnut-time
  // Plugin App, and the duplicate Settings section was deleted in 95473094.
  // No `timeline` row either: the screen-activity Life Tracker (Screen Tracking)
  // was removed on 2026-10-31.
  // Page Use (2026-10-31): local counts of which pages and panes get opened.
  // Walnut Health (2026-11-08): Walnut's own alarms, like CloudWatch.
  'walnut-health', 'usage', 'page-use', 'suggest-accuracy', 'bug-report',
]
const DIAGNOSTICS_IDS = ['walnut-health', 'usage', 'page-use', 'suggest-accuracy', 'bug-report']

describe('core settings registry', () => {
  it('keeps one owner-scoped source of truth for page and navigation order', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS.map((entry) => entry.id)).toEqual(EXPECTED_IDS)
    expect(new Set(EXPECTED_IDS).size).toBe(EXPECTED_IDS.length)
    expect(CORE_SETTINGS_CONTRIBUTIONS.every((entry) => entry.owner === 'walnut')).toBe(true)
  })

  it('has no Plugins section: plugins moved to the Apps page', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS.find((entry) => entry.id === 'plugin-store')).toBeUndefined()
  })

  it('keeps the Manage / Configure / Diagnostics split', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'manage')
      .map((entry) => entry.id)).toEqual(['hooks'])
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
    expect(hidden).toEqual(['focus-tiers', 'tags', 'task-providers', 'providers'])
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

  // 2026-10-31: on a server that is not a Mac, macOS Access rendered nothing (its
  // section returned null) while its nav entry stayed. A section whose component can
  // return null at its top level is a pane that may be empty, so its contribution
  // must name the server fact (`requires`) that keeps its entry off the nav there.
  it('gives every section that can render nothing a gate that hides its nav entry', () => {
    const registry = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/components/settings/core-settings-registry.tsx'), 'utf8')
    const sectionsDir = path.resolve(import.meta.dirname, '../../web/src/components/settings/sections')
    const ungated: string[] = []
    for (const entry of CORE_SETTINGS_CONTRIBUTIONS) {
      const block = registry.slice(registry.indexOf(`id: '${entry.id}'`))
      const component = /render:[^\n]*<([A-Z]\w*)/.exec(block)?.[1]
      expect(component, `${entry.id}: render names its section component`).toBeTruthy()
      const src = fs.readFileSync(path.join(sectionsDir, `${component}.tsx`), 'utf8')
      const start = src.indexOf(`export function ${component}(`)
      expect(start, `${component} is exported from sections/${component}.tsx`).toBeGreaterThanOrEqual(0)
      const end = src.indexOf('\n}\n', start)
      const body = src.slice(start, end < 0 ? undefined : end)
      // A statement at the component's own indent (two spaces), not one inside a callback:
      // `return null`, `return <></>`, as one line or as the body of an `if (...) {` block.
      const EMPTY = '(?:null|<></>|<Fragment\\s*/>)'
      const empty = new RegExp(`^  (?:if \\(.*\\) )?return ${EMPTY};?\\s*$|^  if \\(.*\\) \\{\\n {4}return ${EMPTY};?\\s*\\n  \\}`, 'm')
      if (empty.test(body) && !entry.requires) ungated.push(entry.id)
    }
    expect(ungated, 'sections that can render nothing with no `requires` gate').toEqual([])
  })

  it('puts the three ways and Devices under Phones & Cloud as tabs, Tailscale and Browser link on the Mac only', () => {
    const tabs = CORE_SETTINGS_CONTRIBUTIONS.filter((e) => e.tabOf)
    expect(tabs.map((e) => [e.id, e.tabOf, e.label])).toEqual([
      ['cloud', 'devices', 'Cloud companion'],
      ['devices-tailscale', 'devices', 'Tailscale'],
      ['devices-browser', 'devices', 'Browser link'],
      ['devices-phones', 'devices', 'Devices'],
    ])
    // The tab bar's order is the registry's, and settings-way-panes names the same panes.
    expect(tabs.map((e) => e.id)).toEqual([...PHONES_CLOUD_TABS])
    for (const tab of tabs) {
      const parent = CORE_SETTINGS_CONTRIBUTIONS.find((e) => e.id === tab.tabOf)
      expect(parent?.navHidden).toBeFalsy()
      expect(tab.navHidden).toBeFalsy()
      expect(tab.parent).toBeUndefined()
      expect(parent?.group).toBe(tab.group)
    }
    expect(CORE_SETTINGS_CONTRIBUTIONS.some((e) => e.parent === 'devices')).toBe(false)
    expect(CORE_SETTINGS_CONTRIBUTIONS.find((e) => e.id === 'devices-tailscale')?.requires).toBe('primary')
    expect(CORE_SETTINGS_CONTRIBUTIONS.find((e) => e.id === 'devices-browser')?.requires).toBe('primary')
  })

  it('lists the macOS Access entry only where the server has a report', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS.find((e) => e.id === 'permissions')?.requires).toBe('mac-access')
  })
})

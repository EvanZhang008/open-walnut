/**
 * What a Claude Code session carries less of (src/providers/claude-scope-settings.ts) and the
 * project list of plugins it leaves out (src/core/sessions/claude-plugins-off.ts): the pure
 * helper, the config knob's reader, and the metadata write's check and tolerant read.
 */
import { describe, expect, it } from 'vitest'
import {
  claudeScopeSettings, skillListingDescChars, validSkillListingDescChars,
} from '../../src/providers/claude-scope-settings.js'
import {
  checkClaudePluginsOffPatch, readClaudePluginsOff, CLAUDE_PLUGINS_OFF_MAX_ITEMS, CLAUDE_PLUGIN_ID_MAX_CHARS,
} from '../../src/core/sessions/claude-plugins-off.js'
import { ProjectSettingsError } from '../../src/core/sessions/project-launch-defaults.js'

describe('claudeScopeSettings', () => {
  it('adds nothing when nothing was chosen', () => {
    expect(claudeScopeSettings({})).toEqual({})
    expect(claudeScopeSettings({ pluginsOff: [], listingDescChars: undefined })).toEqual({})
  })

  it('turns each plugin off and caps the listing', () => {
    expect(claudeScopeSettings({ pluginsOff: ['work-tools@acme', 'notes@example-market'], listingDescChars: 200 })).toEqual({
      enabledPlugins: { 'work-tools@acme': false, 'notes@example-market': false },
      skillListingMaxDescChars: 200,
    })
    expect(claudeScopeSettings({ pluginsOff: ['work-tools@acme'] })).toEqual({ enabledPlugins: { 'work-tools@acme': false } })
    expect(claudeScopeSettings({ listingDescChars: 40 })).toEqual({ skillListingMaxDescChars: 40 })
  })

  it('sends no cap outside the CLI range', () => {
    for (const n of [0, 39, 1537, 100.5, Number.NaN]) expect(claudeScopeSettings({ listingDescChars: n })).toEqual({})
  })
})

describe('session.skill_listing_desc_chars', () => {
  it('reads an integer from 40 to 1536, and nothing else', () => {
    expect(skillListingDescChars(undefined)).toBeUndefined()
    expect(skillListingDescChars({})).toBeUndefined()
    expect(skillListingDescChars({ session: {} })).toBeUndefined()
    expect(skillListingDescChars({ session: { skill_listing_desc_chars: 200 } })).toBe(200)
    expect(skillListingDescChars({ session: { skill_listing_desc_chars: 1536 } })).toBe(1536)
    expect(skillListingDescChars({ session: { skill_listing_desc_chars: '200' } })).toBeUndefined()
    expect(skillListingDescChars({ session: { skill_listing_desc_chars: 20 } })).toBeUndefined()
    expect(validSkillListingDescChars(null)).toBe(false)
  })
})

describe('checkClaudePluginsOffPatch', () => {
  it('passes a patch without the key unchanged', () => {
    const patch = { default_cwd: '/w' }
    expect(checkClaudePluginsOffPatch(patch)).toBe(patch)
  })

  it('trims, drops duplicates and keeps the order', () => {
    expect(checkClaudePluginsOffPatch({ claude_plugins_off: [' work-tools@acme ', 'b@m', 'work-tools@acme'] }))
      .toEqual({ claude_plugins_off: ['work-tools@acme', 'b@m'] })
  })

  it('an empty list or a clear removes the key', () => {
    expect(checkClaudePluginsOffPatch({ claude_plugins_off: [] })).toEqual({ claude_plugins_off: undefined })
    expect(checkClaudePluginsOffPatch({ claude_plugins_off: undefined })).toEqual({ claude_plugins_off: undefined })
  })

  it('refuses what is not a list of name@marketplace ids', () => {
    for (const bad of ['work-tools@acme', { a: 1 }, 42, true]) {
      expect(() => checkClaudePluginsOffPatch({ claude_plugins_off: bad })).toThrow(ProjectSettingsError)
    }
    for (const item of ['', 'no-marketplace', '@acme', 'tools@', 'a@b@c', 'two words@acme', 7, null]) {
      expect(() => checkClaudePluginsOffPatch({ claude_plugins_off: [item] })).toThrow(/name@marketplace/)
    }
    expect(() => checkClaudePluginsOffPatch({ claude_plugins_off: [`${'x'.repeat(CLAUDE_PLUGIN_ID_MAX_CHARS)}@m`] })).toThrow(ProjectSettingsError)
    const many = Array.from({ length: CLAUDE_PLUGINS_OFF_MAX_ITEMS + 1 }, (_, i) => `p${i}@m`)
    expect(() => checkClaudePluginsOffPatch({ claude_plugins_off: many })).toThrow(/at most/)
    expect(checkClaudePluginsOffPatch({ claude_plugins_off: many.slice(0, CLAUDE_PLUGINS_OFF_MAX_ITEMS) }).claude_plugins_off)
      .toHaveLength(CLAUDE_PLUGINS_OFF_MAX_ITEMS)
  })

  it('takes ids in any script', () => {
    // Test data: a plugin name in non-ASCII letters.
    expect(checkClaudePluginsOffPatch({ claude_plugins_off: ['\u7b14\u8bb0@acme'] })).toEqual({ claude_plugins_off: ['\u7b14\u8bb0@acme'] })
  })
})

describe('readClaudePluginsOff', () => {
  it('reads nothing from an older row without the key', () => {
    expect(readClaudePluginsOff(null)).toEqual([])
    expect(readClaudePluginsOff({ default_cwd: '/w', default_host: 'box' })).toEqual([])
  })

  it('keeps the valid ids of a hand-edited row and drops the rest', () => {
    expect(readClaudePluginsOff({ claude_plugins_off: 'work-tools@acme' })).toEqual([])
    expect(readClaudePluginsOff({ claude_plugins_off: ['work-tools@acme', 3, 'bad id@x', 'work-tools@acme', 'b@m'] }))
      .toEqual(['work-tools@acme', 'b@m'])
  })
})

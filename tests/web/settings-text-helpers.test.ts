/**
 * Settings text helpers: provider labels, hook names, device models, usage cells.
 */
import { describe, expect, it } from 'vitest'
import { hookBaseName, hookDescription, hookHelp, hookNames, humanEvent } from '../../web/src/components/settings/sections/hook-text.js'
import { hookTag } from '../../web/src/components/settings/sections/HooksSection.js'
import { humanDeviceModel } from '../../web/src/components/settings/sections/DevicesSection.js'
import { usageDay, usageRangeHint, usageTime } from '../../web/src/components/settings/sections/UsageTables.js'

const DASH = /[\u2014\u2013]/

describe('F19 hook names and help', () => {
  it('uses sentence case and keeps acronyms', () => {
    expect(hookBaseName('Session Auto Title (session:end)')).toBe('Session auto title')
    expect(hookBaseName('CWD Rename Detector')).toBe('CWD rename detector')
    expect(hookBaseName('AskUserQuestion auto-correction')).toBe('AskUserQuestion auto-correction')
  })

  it('makes names unique in a list', () => {
    const names = hookNames([
      { id: 'a', name: 'Session Auto Title (session:start)', on: ['session:start'] },
      { id: 'b', name: 'Session Auto Title (session:end)', on: ['session:end'] },
      { id: 'c', name: 'Turn Complete Summary', on: ['onTurnComplete'] },
    ])
    expect(names.get('a')).toBe('Session auto title, on session start')
    expect(names.get('b')).toBe('Session auto title, on session end')
    expect(names.get('c')).toBe('Turn complete summary')
    expect(new Set(names.values()).size).toBe(3)
    expect(humanEvent('onToolUse')).toBe('tool use')
  })

  it('writes one plain sentence without caps, dashes or e.g.', () => {
    const raw = 'Retries once when ANOTHER TRANSIENT error hits, e.g. a timeout. Then it stops.'
    expect(hookHelp(raw)).toBe('Retries once when another transient error hits, for example a timeout.')
    const policy = "Strips the dying session's durable rows \u2014 guards against the CLI's adoption."
    expect(hookHelp(policy)).not.toMatch(DASH)
    expect(hookDescription(policy)).toBe("Strips the dying session's durable rows; guards against the CLI's adoption.")
    expect(hookHelp('Reads the MCP and TOML files.')).toBe('Reads the MCP and TOML files.')
  })

  it('never shows the jargon tag Inline', () => {
    expect(hookTag({ source: 'inline' } as never)).toBe('Built-in')
  })
})

describe('F24 device model', () => {
  it('shows the family for a raw hardware id', () => {
    expect(humanDeviceModel('iPhone18,2')).toBe('iPhone')
    expect(humanDeviceModel('iPad14,1')).toBe('iPad')
    expect(humanDeviceModel('iPhone 17 Pro')).toBe('iPhone 17 Pro')
    expect(humanDeviceModel(undefined)).toBeUndefined()
  })
})

describe('F12 F32 usage dates', () => {
  it('names the range in words, never an ISO date', () => {
    expect(usageRangeHint('2026-09-16', undefined)).toBe('Since Sep 16')
    expect(usageRangeHint('2026-09-16', '2026-09-20')).toBe('Sep 16 to Sep 20')
    expect(usageRangeHint(undefined, undefined)).toBe('All time')
    expect(usageDay('2026-09-03')).toBe('Sep 3')
  })

  it('prints times without a leading zero hour', () => {
    const t = usageTime(new Date(2026, 8, 23, 3, 31).toISOString())
    expect(t).toMatch(/^Sep 23, 3:31\sAM$/)
  })
})

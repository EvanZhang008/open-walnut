/**
 * The SessionStart hook that reads back what Main and a VP keep across conversations
 * (src/providers/own-readback-hook.ts): only an org node's session gets it, for a new conversation
 * (`startup`) and after a compaction (`compact`), beside open_items' compact hook, never in place of it.
 */
import { describe, it, expect } from 'vitest'
import { ownReadbackHooks } from '../../src/providers/own-readback-hook.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'
import { OWN_READBACK_MARK, ownReadbackHooked } from '../../src/core/sessions/own-readback.js'
import { OWN_READBACK_LINE, orgRoleLine } from '../../src/core/sessions/session-context.js'

type Group = { matcher: string; hooks: Array<{ command: string }> }

describe('ownReadbackHooks', () => {
  it('Main and a VP get startup and compact; a worker, an older prompt and WALNUT_OWN_READBACK=0 get none', () => {
    for (const role of ['main', 'lead'] as const) {
      const groups = (ownReadbackHooks(role, OWN_READBACK_LINE, {}) as { SessionStart: Group[] }).SessionStart
      expect(groups.map((g) => g.matcher)).toEqual(['startup', 'compact'])
      expect(groups[0]!.hooks[0]!.command).toBe(`walnut tools call agent_memory_read '{"hook":"startup"}' 2>/dev/null || true`)
      expect(groups[1]!.hooks[0]!.command).toContain('{"hook":"compact"}')
    }
    expect(ownReadbackHooks(undefined, OWN_READBACK_LINE, {})).toBeNull()
    expect(ownReadbackHooks('lead', OWN_READBACK_LINE, { WALNUT_OWN_READBACK: '0' })).toBeNull()
    // An older prompt a resume replays: no hook, so open_items keeps reading MEMORY.md back.
    expect(ownReadbackHooks('lead', 'an older VP prompt', {})).toBeNull()
  })

  it('merges with the open_items compact hook in the session settings', () => {
    const lead = (sessionSettingsHooks({}, { orgRole: 'lead', prompt: OWN_READBACK_LINE }) as { SessionStart: Group[] }).SessionStart
    const readers = lead.filter((g) => g.hooks.some((h) => /open_items|agent_memory_read/.test(h.command)))
    expect(readers.map((g) => g.matcher)).toEqual(['compact', 'startup', 'compact'])
    expect(readers[0]!.hooks[0]!.command).toContain('open_items')
    const worker = (sessionSettingsHooks({}) as { SessionStart: Group[] }).SessionStart
    expect(worker.map((g) => g.matcher)).toEqual(['compact'])
  })
})

describe('the mark in the prompt', () => {
  it('Main\'s and a lead\'s role lines carry it, a worker\'s prompt does not', () => {
    expect(OWN_READBACK_LINE.startsWith(OWN_READBACK_MARK)).toBe(true)
    expect(orgRoleLine({ org_role: 'main' })).toContain(OWN_READBACK_MARK)
    expect(orgRoleLine({ org_role: 'lead', project: 'Acme' })).toContain(OWN_READBACK_MARK)
    expect(orgRoleLine({})).toBe('')
  })

  it('with the readback off, the role lines leave the line out, so no prompt carries the mark', () => {
    const before = process.env.WALNUT_OWN_READBACK
    process.env.WALNUT_OWN_READBACK = '0'
    try {
      expect(orgRoleLine({ org_role: 'lead', project: 'Acme' })).not.toContain(OWN_READBACK_MARK)
    } finally {
      if (before === undefined) delete process.env.WALNUT_OWN_READBACK
      else process.env.WALNUT_OWN_READBACK = before
    }
  })

  it('ownReadbackHooked reads it, and is off with the hook', () => {
    expect(ownReadbackHooked({ appliedAppendSystemPrompt: `x ${OWN_READBACK_LINE}` }, {})).toBe(true)
    expect(ownReadbackHooked({ appliedAppendSystemPrompt: 'older prompt' }, {})).toBe(false)
    expect(ownReadbackHooked({}, {})).toBe(false)
    expect(ownReadbackHooked({ appliedAppendSystemPrompt: OWN_READBACK_LINE }, { WALNUT_OWN_READBACK: '0' })).toBe(false)
  })
})

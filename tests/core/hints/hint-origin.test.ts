/**
 * Whose words a hint is (src/core/hints/hint-origin.ts; 2026-11-01, the user: "it
 * should be clear which is built in which is user defined"). The class guard: every
 * built-in is rendered from a config whose every session setting is a marker, in
 * every state the registry reads; a marker may only ever sit in a part marked as the
 * user's, and Walnut's own parts never hold one. A new built-in that sends a setting
 * of the user's without HINT_USER_SETTINGS saying so fails here, and so does a new
 * built-in missing from BUILT_IN_HINT_KINDS. The one built-in that sends a setting of the
 * user's is the reply-language correction (2026-11-14), and only after a drift: the rule itself
 * is a line of the system prompt.
 */
import { describe, it, expect } from 'vitest'
import { effectiveHints, HINT_TRIGGERS, describeHint } from '../../../src/core/hints/hint-registry.js'
import {
  BUILT_IN_HINT_KINDS, HINT_USER_SETTINGS, REPLY_LANGUAGE_DRIFT_TAIL, WALNUT_ONLY_KINDS, hintTextParts, isBuiltInHintKind,
} from '../../../src/core/hints/hint-origin.js'
import type { MessageHintTrigger } from '../../../src/core/types.js'

const MARK = 'ZQMARK'

/** A config whose every session setting a hint could read is a marker string. */
const markedConfig = {
  session: new Proxy({}, {
    get: (_t, k) => (k === 'hints' || typeof k === 'symbol' ? undefined : `${MARK}_${String(k)} words`),
  }),
} as never

function reasonSets(): Array<Set<MessageHintTrigger>> {
  return [...HINT_TRIGGERS.map((t) => new Set([t])), new Set(HINT_TRIGGERS)]
}

describe('hint origin', () => {
  it('names every built-in of the registry', () => {
    expect(effectiveHints(null).filter((h) => h.builtIn).map((h) => h.kind)).toEqual([...BUILT_IN_HINT_KINDS])
  })

  it("a user's setting in a built-in's text is always marked as theirs, Walnut's words never", () => {
    const inputs = [
      { config: markedConfig, record: null },
      { config: markedConfig, record: null, request: { arg: '7' }, toldHash: 'rich' },
      { config: markedConfig, record: { output_mode: 'markdown' as const }, toldHash: 'rich' },
      { config: markedConfig, record: null, away: { away: true, lastSeenAt: Date.UTC(2026, 10, 1) } },
      { config: markedConfig, record: null, away: { away: false, lastSeenAt: null }, toldHash: 'away' },
      { config: markedConfig, record: null, brief: { at: null, stale: true, words: 'two lines moved', key: 'k' } },
      { config: markedConfig, record: { hintState: { drift: { 'reply-language': new Date().toISOString() } } } },
      { config: markedConfig, record: null, thread: { threadId: 'th-1', title: 'Fix the hints', created: true, followUp: false, duplicate: false, open: [{ id: 'th-2', title: 'Other', state: 'open' as never }], closed: [] } },
    ]
    let sawUser = 0
    for (const hint of effectiveHints(markedConfig).filter((h) => h.builtIn)) {
      for (const input of inputs) {
        for (const reasons of reasonSets()) {
          const out = hint.render(input, reasons)
          if (!out) continue
          const parts = hintTextParts({ kind: hint.kind, text: out.text.trim() })
          for (const p of parts) {
            if (p.from === 'walnut') expect(p.text, `${hint.kind}: Walnut's part holds a setting`).not.toContain(MARK)
            else { expect(p.text, `${hint.kind}: a user part with no setting in it`).toContain(MARK); sawUser++ }
          }
          expect(parts.map((p) => p.text).join(' ')).toBe(out.text.trim())
        }
      }
    }
    // The reply-language correction is the one built-in with a setting of the user's in it.
    expect(Object.keys(HINT_USER_SETTINGS)).toEqual(['reply-language'])
    expect(sawUser).toBeGreaterThan(0)
  })

  it('the reply-language correction: the user\'s rule, then Walnut\'s English, only after a fresh drift', () => {
    expect(BUILT_IN_HINT_KINDS as readonly string[]).toContain('reply-language')
    expect(WALNUT_ONLY_KINDS as readonly string[]).not.toContain('reply-language')
    const rule = 'Talk to the user in Chinese; code stays English.'
    const config = { session: { reply_language: rule } } as never
    const hint = effectiveHints(config).find((h) => h.kind === 'reply-language')!
    const fresh = { config, record: { hintState: { drift: { 'reply-language': new Date().toISOString() } } } } as never
    const out = hint.render(fresh, new Set(['on_drift']))!
    expect(out.text).toBe(`${rule} ${REPLY_LANGUAGE_DRIFT_TAIL}`)
    expect(out.text).toMatch(/^[\x00-\x7f]*$/)
    expect(hintTextParts({ kind: 'reply-language', text: out.text })).toEqual([
      { text: rule, from: 'user', setting: 'Reply language' },
      { text: REPLY_LANGUAGE_DRIFT_TAIL, from: 'walnut' },
    ])
    // No drift, an old mark, or another reason: nothing.
    expect(hint.render({ config, record: null } as never, new Set(['on_drift']))).toBeNull()
    expect(hint.render({ config, record: { hintState: { drift: { 'reply-language': '2026-11-01T08:00:00.000Z' } } } } as never, new Set(['on_drift']))).toBeNull()
    expect(hint.render(fresh, new Set(['on_change']))).toBeNull()
    // An old row from before 2026-11-06 (the rule alone) reads as the user's setting.
    expect(hintTextParts({ kind: 'reply-language', text: rule })).toEqual([{ text: rule, from: 'user', setting: 'Reply language' }])
  })

  it("a custom hint is all the user's; a built-in with no setting all Walnut's", () => {
    expect(hintTextParts({ kind: 'tone', text: 'Keep it short.' })).toEqual([{ text: 'Keep it short.', from: 'user' }])
    expect(hintTextParts({ kind: 'rich-output', text: 'rich output mode is still on.' })).toEqual([{ text: 'rich output mode is still on.', from: 'walnut' }])
    expect(hintTextParts({ kind: 'session-context', text: 'x' })).toEqual([{ text: 'x', from: 'walnut' }])
  })

  it("Settings reads each row's origin and the setting the reply-language correction sends", () => {
    const config = { session: { reply_language: 'Answer in French.', hints: { tone: { text: 'Keep it short.' }, 'rich-output': { every_turns: 3 } } } } as never
    const rows = effectiveHints(config).map((h) => describeHint(h, config))
    const by = (k: string) => rows.find((r) => r.kind === k)!
    expect(by('tone')).toMatchObject({ built_in: false })
    expect(by('rich-output')).toMatchObject({ built_in: true, overridden: true })
    expect(by('rich-output')).not.toHaveProperty('user_setting')
    expect(by('reply-language').user_setting).toMatchObject({ label: 'Reply language', anchor: 'session-reply-language', value: 'Answer in French.' })
    for (const r of rows) if (r.kind !== 'reply-language') expect(r).not.toHaveProperty('user_setting')
  })
})

describe("Walnut's own names", () => {
  it('a custom hint cannot take the name of Walnut text outside the registry', async () => {
    const { validateHintSettings } = await import('../../../src/core/hints/hint-registry.js')
    for (const kind of ['session-context', 'engine-switch']) {
      expect(() => validateHintSettings(kind, { text: 'mine' })).toThrow(/Walnut's own text/)
      const config = { session: { hints: { [kind]: { text: 'mine' } } } } as never
      expect(effectiveHints(config).map((h) => h.kind)).not.toContain(kind)
    }
  })
})

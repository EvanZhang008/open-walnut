/**
 * Whose words a hint is (src/core/hints/hint-origin.ts; 2026-11-01, the user: "it
 * should be clear which is built in which is user defined"). The class guard: every
 * built-in is rendered from a config whose every session setting is a marker, in
 * every state the registry reads, and no built-in's text may hold one: a built-in's
 * words are Walnut's, the same in every Walnut. A new built-in that sends a setting of
 * the user's fails here (the reply-language correction was the last one, removed
 * 2026-11-20), and so does a new built-in missing from BUILT_IN_HINT_KINDS.
 */
import { describe, it, expect } from 'vitest'
import { effectiveHints, HINT_TRIGGERS, describeHint } from '../../../src/core/hints/hint-registry.js'
import { BUILT_IN_HINT_KINDS } from '../../../src/core/hints/hint-origin.js'
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

  it("no built-in's text holds a setting of the user's", () => {
    const inputs = [
      { config: markedConfig, record: null },
      { config: markedConfig, record: null, request: { arg: '7' }, toldHash: 'rich' },
      { config: markedConfig, record: { output_mode: 'markdown' as const }, toldHash: 'rich' },
      { config: markedConfig, record: null, away: { away: true, lastSeenAt: Date.UTC(2026, 10, 1) } },
      { config: markedConfig, record: null, away: { away: false, lastSeenAt: null }, toldHash: 'away' },
      { config: markedConfig, record: null, brief: { at: null, stale: true, words: 'two lines moved', key: 'k' } },
      { config: markedConfig, record: null, thread: { threadId: 'th-1', title: 'Fix the hints', created: true, followUp: false, duplicate: false, open: [{ id: 'th-2', title: 'Other', state: 'open' as never }], closed: [] } },
    ]
    let rendered = 0
    for (const hint of effectiveHints(markedConfig).filter((h) => h.builtIn)) {
      for (const input of inputs) {
        for (const reasons of reasonSets()) {
          const out = hint.render(input, reasons)
          if (!out) continue
          rendered++
          expect(out.text, `${hint.kind}: a built-in sends a setting of the user's`).not.toContain(MARK)
        }
      }
    }
    expect(rendered).toBeGreaterThan(0)
  })

  it("Settings reads each row's origin", () => {
    const config = { session: { reply_language: 'Answer in French.', hints: { tone: { text: 'Keep it short.' }, 'rich-output': { every_turns: 3 } } } } as never
    const rows = effectiveHints(config).map((h) => describeHint(h))
    const by = (k: string) => rows.find((r) => r.kind === k)!
    expect(by('tone')).toMatchObject({ built_in: false })
    expect(by('rich-output')).toMatchObject({ built_in: true, overridden: true })
  })
})

describe("Walnut's own names", () => {
  it('a custom hint cannot take the name of Walnut text outside the registry', async () => {
    const { validateHintSettings } = await import('../../../src/core/hints/hint-registry.js')
    for (const kind of ['session-context', 'engine-switch', 'reply-language']) {
      expect(() => validateHintSettings(kind, { text: 'mine' })).toThrow(/Walnut's own text/)
      const config = { session: { hints: { [kind]: { text: 'mine' } } } } as never
      expect(effectiveHints(config).map((h) => h.kind)).not.toContain(kind)
    }
  })
})

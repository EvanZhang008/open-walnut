/**
 * The text of a dictation is the engine's own words, byte for byte.
 *
 * 2026-11-09, the user: "just send full, idc, just what ever we said it should
 * send it, without modify". Until then a correction list rewrote known
 * mishearings after the engine ("Cloud Deep" -> "clouddev"), on the final pass,
 * the drafts, the phone's live pieces and the hosted fallback. What stays: the
 * engine's read-back of its own context (words never said) is taken off or heard
 * again without the context (stt-context-echo.test.ts).
 *
 * The ratchet below lists every place in the speech code that assigns a
 * transcript's text, so a new rewrite cannot come in unseen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// A doubled space, a curly quote, an ellipsis, CJK, digits, and a form the old
// correction list would have rewritten ("Cloud Deep").
const RAW = 'so Cloud Deep\u2019s p95 is 2.5 s\u2026  \u55ef, \u6cf0\u666e OK'
const calls: Array<string | undefined> = []
vi.mock('../../src/core/stt/engine-mlx.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMlxEngine: () => ({
    name: 'mlx',
    isAvailable: async () => ({ available: true }),
    transcribe: async (req: { prompt?: string }) => {
      calls.push(req.prompt)
      return { text: RAW, durationMs: 40 }
    },
  }),
}))

import { transcribeAudio } from '../../src/core/stt/index.js'
import type { Config } from '../../src/core/types.js'

const config = {
  stt: { engine: 'mlx', mlx_python_path: '/nonexistent/python' },
  stt_corrections: { clouddev: ['Cloud Deep'], typo: ['\u6cf0\u666e'] },
} as unknown as Config

describe('transcribeAudio hands back the engine\'s words untouched', () => {
  beforeEach(() => { calls.length = 0 })

  it('with a context and a correction list that matches its words', async () => {
    const result = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: 'Walnut, daemon, bun' })
    expect(calls).toEqual(['Walnut, daemon, bun'])
    expect(result.text).toBe(RAW)
  })

})

const ROOT = join(__dirname, '../..')
function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.ts$/.test(name)) out.push(p)
  }
  return out
}

describe('ratchet: where the speech code sets a transcript\'s text', () => {
  const files = [
    ...sources(join(ROOT, 'src/core/stt')),
    ...['stt.ts', 'stt-v1.ts', 'voice-archive-v1.ts'].map((f) => join(ROOT, 'src/web/routes', f)),
  ]

  it('no rewrite of the text exists any more', () => {
    for (const f of [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'web/src'))]) {
      expect(readFileSync(f, 'utf8'), relative(ROOT, f)).not.toMatch(/\b(correctTranscript|applyCorrections|correctedTake)\b/)
    }
  })

  it('every `.text =` on a transcript is a known one', () => {
    const found: Record<string, number> = {}
    for (const f of files) {
      const n = (readFileSync(f, 'utf8').match(/\b(?:result|r|res|out|answer)\.text\s*=[^=]/g) ?? []).length
      if (n) found[relative(ROOT, f)] = n
    }
    expect(found).toEqual({
      // stripVocabEcho on the final pass and on the shadow engine's comparison
      // row: the engine's read-back of its own context over silence, never speech.
      'src/core/stt/index.ts': 2,
    })
  })
})

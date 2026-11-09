/**
 * A transcription that reads its context back in place of speech is heard again
 * without the context (2026-11-08: on the user's own recordings Qwen3-ASR put the
 * 313-character term list where about 30 s of a 131 s take was spoken, so those
 * words never reached the text box).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: Array<string | undefined> = []
let echo: 'mid' | 'trailing' | 'none' = 'mid'
vi.mock('../../src/core/stt/engine-mlx.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMlxEngine: () => ({
    name: 'mlx',
    isAvailable: async () => ({ available: true }),
    transcribe: async (req: { prompt?: string }) => {
      calls.push(req.prompt)
      if (req.prompt && echo === 'mid') {
        return { text: `we keep the cache warm. ${req.prompt} then the rest`, durationMs: 40 }
      }
      if (req.prompt && echo === 'trailing') {
        return { text: 'we keep the cache warm. Walnut, daemon, bun', durationMs: 40 }
      }
      return { text: 'we keep the cache warm, and the second half of the take is here too.', durationMs: 30 }
    },
  }),
}))

import { contextEchoed, transcribeAudio } from '../../src/core/stt/index.js'
import type { Config } from '../../src/core/types.js'

const CONTEXT = 'Marina, Acme, Walnut, cloud companion, daemon, bun, T3 Code, UI, AI'
const config = { stt: { engine: 'mlx', mlx_python_path: '/nonexistent/python' } } as unknown as Config

describe('contextEchoed', () => {
  it('finds the context list read back anywhere in the answer', () => {
    expect(contextEchoed(`so I think. ${CONTEXT} 然后我们继续`, CONTEXT)).toBe(true)
    expect(contextEchoed('first part Acme, Walnut, daemon, bun and on', CONTEXT)).toBe(true)
    // Full-width and enumeration commas, any case.
    expect(contextEchoed('然后 walnut，daemon、BUN 就好', CONTEXT)).toBe(true)
  })

  it('leaves speech that names a term or two alone', () => {
    expect(contextEchoed('the daemon restarted and bun rebuilt it', CONTEXT)).toBe(false)
    expect(contextEchoed('we use Walnut, daemon and bun', CONTEXT)).toBe(false)
    expect(contextEchoed('这个 UI, AI 都要看', CONTEXT)).toBe(false)
  })

  it('does not match a term inside a longer word', () => {
    expect(contextEchoed('MyWalnut, daemons, bunny', CONTEXT)).toBe(false)
  })

  it('needs a context of three terms or more', () => {
    expect(contextEchoed('Walnut, daemon', 'Walnut, daemon')).toBe(false)
    expect(contextEchoed('anything', '')).toBe(false)
  })
})

describe('transcribeAudio with a context that is read back', () => {
  beforeEach(() => { calls.length = 0; echo = 'mid' })

  it('hears the clip again without the context and returns that answer', async () => {
    const result = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual([CONTEXT, undefined])
    expect(result.text).toBe('we keep the cache warm, and the second half of the take is here too.')
    expect(result.durationMs).toBe(70)
  })

  it('strips a trailing echo over silence without a second call', async () => {
    echo = 'trailing'
    const result = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual([CONTEXT])
    expect(result.text).toBe('we keep the cache warm.')
  })

  it('keeps the context answer when it holds no echo (one engine call)', async () => {
    echo = 'none'
    const result = await transcribeAudio(config, { audio: 'AAAA', format: 'wav', prompt: CONTEXT })
    expect(calls).toEqual([CONTEXT])
    expect(result.text).toBe('we keep the cache warm, and the second half of the take is here too.')
  })
})

// Every place that calls an engine directly, so one that sends the speech context
// without going through transcribeAudio (and its echo check) cannot appear unseen.
describe('engine calls outside transcribeAudio', () => {
  it('are only the known ones', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    const root = join(__dirname, '../../src')
    const found: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name)) {
          const n = (readFileSync(p, 'utf8').match(/engine\.transcribe\(/g) ?? []).length
          if (n) found.push(`${relative(root, p)}:${n}`)
        }
      }
    }
    walk(root)
    expect(found.sort()).toEqual([
      // transcribeAudio itself (the call and its plain retry) and the shadow engine (the vocab file only, never the Qwen context).
      'core/stt/index.ts:3',
      // A retry with a chosen whisper model: whisper's own prompt, not the Qwen context.
      'web/routes/stt.ts:1',
    ])
  })
})

/**
 * Every speech model server lets go of its memory after 10 idle minutes at most.
 *
 * 2026-11-10: the Mac ran memory-tight in 164 samples a day while the Qwen3-ASR
 * daemon (about 2 GB) stayed up for an hour after the last dictation, and the
 * cleanup model (about 2.3 GB) had the same hour hard-coded. A cold start costs
 * about 5 s (p50 of 41, p90 6.4 s) and starts when the mic is pressed, while the
 * browser records, so a 10-minute idle exit loses no words.
 *
 * The class: each file under src/core/stt that spawns a process. A model server
 * names its idle exit here; anything else is listed with why it holds no model.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(__dirname, '../../src/core/stt')
const MAX_IDLE_S = 10 * 60

/** The idle exits each model server declares, in seconds. */
const MODEL_SERVERS: Record<string, (src: string) => number[]> = {
  'engine-mlx.ts': (s) => [ms(s, /DEFAULT_IDLE_TTL_MS = ([\d *]+);/), py(s)],
  'cleanup-mlx.ts': (s) => [ms(s, /const IDLE_TTL_MS = ([\d *]+);/), py(s)],
  'engine-whisper-server.ts': (s) => [ms(s, /DEFAULT_IDLE_TTL_MS = ([\d *]+);/)],
  'engine-llama.ts': (s) => [Number(/sleepIdleSec \?\? (\d+)/.exec(s)?.[1])],
}

/** Spawn a process that holds no model. */
const NOT_MODEL_SERVERS: Record<string, string> = {
  'mic-record.ts': 'records the microphone for a dictation and ends with it',
  'setup-stream.ts': 'runs one setup step (an install or a download) and ends',
}

function ms(src: string, re: RegExp): number {
  const expr = re.exec(src)?.[1]
  expect(expr, re.source).toBeTruthy()
  return expr!.split('*').reduce((a, b) => a * Number(b.trim()), 1) / 1000
}

/** The Python daemon's own fallback when no TTL is passed on its command line. */
function py(src: string): number {
  const v = /IDLE_TTL_S = float\(sys\.argv\[3\]\) if len\(sys\.argv\) > 3 else ([\d.]+)/.exec(src)?.[1]
  expect(v, 'the daemon script reads its TTL from argv[3]').toBeTruthy()
  return Number(v)
}

describe('speech model servers exit after 10 idle minutes at most', () => {
  const spawning = readdirSync(DIR).filter((f) => f.endsWith('.ts') && /\bspawn\(/.test(readFileSync(join(DIR, f), 'utf8')))

  it('every file that spawns a process is classified', () => {
    expect(spawning.filter((f) => !(f in MODEL_SERVERS) && !(f in NOT_MODEL_SERVERS))).toEqual([])
  })

  for (const [file, read] of Object.entries(MODEL_SERVERS)) {
    it(file, () => {
      for (const s of read(readFileSync(join(DIR, file), 'utf8'))) {
        expect(s).toBeGreaterThan(0)
        expect(s).toBeLessThanOrEqual(MAX_IDLE_S)
      }
    })
  }
})

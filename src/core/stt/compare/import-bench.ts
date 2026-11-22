/**
 * The 2026-11-21 benchmark brought in as comparison takes: `<dir>/takes.json`
 * (each take's audio path, time, length and the text Walnut made) and
 * `<dir>/results.json` (per take: the engine texts and the reference). Its arms
 * map to engines: A0 is the in-use engine, `whisper` Whisper large-v2, A3 the
 * Haiku clean-up; the reference is its silver text. Running it again changes
 * nothing it already brought in, and never overwrites a result Voice Accuracy
 * made itself.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scoresOf } from './judge.js'
import { compareStore, takeIdOf } from './store.js'
import { skeletonOf } from './takes-source.js'
import type { AudioRef, CompareTake, EngineResult } from './types.js'

export const BENCH_IMPORT = 'bench-adapt-2026-11-21'
const BENCH_NOTE = '11-21 benchmark'
const BENCH_JUDGE = 'claude-opus-5-5 (11-21 benchmark)'
const ARMS: Array<[arm: string, engine: string]> = [['A0', 'in-use'], ['whisper', 'whisper-large-v2'], ['A3', 'haiku-cleanup']]

interface BenchTake { id: string; kind?: string; audio?: string; ts?: string; dur?: number; text?: string }
interface BenchRow { id: string; silver?: string; terms?: Record<string, number>; texts?: Record<string, string>; arms?: Record<string, { engine_ms?: number | null; llm_s?: number }> }

/** The recording a benchmark audio path names. */
export function audioRefOfPath(path: string): AudioRef | null {
  const phone = /\/voice-archive\/([0-9a-f-]{36})\/audio$/i.exec(path)
  if (phone) return { kind: 'archive', id: phone[1]!.toLowerCase() }
  const web = /\/stt-recordings\/([0-9A-Za-z-]+)\.([a-z0-9]+)$/.exec(path)
  return web ? { kind: 'recording', id: web[1]! } : null
}

export interface ImportResult { imported: number; unchanged: number; skipped: Array<{ id: string; why: string }> }

/** The benchmark's files are missing or not its shape; the message never quotes them. */
export class BenchFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BenchFormatError'
  }
}

async function readBenchFile(dir: string, name: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(join(dir, name), 'utf8')
  } catch (err) {
    throw new BenchFormatError((err as NodeJS.ErrnoException).code === 'ENOENT' ? `${name} is not in that folder` : `${name} could not be read`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new BenchFormatError(`${name} is not JSON`)
  }
}

export async function importBench(dir: string): Promise<ImportResult> {
  const takes = await readBenchFile(dir, 'takes.json') as BenchTake[]
  const results = await readBenchFile(dir, 'results.json') as { per_take?: BenchRow[] } | null
  if (!Array.isArray(takes) || !Array.isArray(results?.per_take)) throw new BenchFormatError('takes.json or results.json is not the benchmark\'s')
  const rows = new Map(results!.per_take!.map((r) => [r.id, r]))
  const out: ImportResult = { imported: 0, unchanged: 0, skipped: [] }
  for (const bench of takes) {
    const row = rows.get(bench.id)
    const ref = bench.audio ? audioRefOfPath(bench.audio) : null
    if (!row || !ref) { out.skipped.push({ id: bench.id, why: !row ? 'no result for it' : 'its audio path names no recording' }); continue }
    const id = takeIdOf(ref)
    const prior = await compareStore.get(id)
    if (prior?.imported === BENCH_IMPORT) { out.unchanged++; continue }
    // The recording itself, when it is on this machine, knows its format and time best.
    const base = prior ?? await skeletonOf(ref)
    const at = bench.ts ?? new Date().toISOString()
    const benchResults: Record<string, EngineResult> = {}
    for (const [arm, engine] of ARMS) {
      const text = row.texts?.[arm]
      if (text === undefined || prior?.results[engine]?.text !== undefined) continue
      const stats = row.arms?.[arm]
      const ms = typeof stats?.engine_ms === 'number' ? stats.engine_ms : typeof stats?.llm_s === 'number' ? Math.round(stats.llm_s * 1000) : 0
      benchResults[engine] = { text, ms, at, model: BENCH_NOTE }
    }
    const terms = Object.entries(row.terms ?? {}).flatMap(([term, n]) => Array.from({ length: Math.max(0, n) }, () => term))
    const take: CompareTake = {
      ...(prior ?? {}),
      id,
      source: ref.kind === 'archive' ? 'phone' : 'web',
      at: base?.at ?? at,
      ...(bench.dur ? { durationSec: bench.dur } : {}),
      format: base?.format ?? (ref.kind === 'recording' ? bench.audio!.split('.').pop()! : 'caf'),
      audioRef: ref,
      ...(bench.text || base?.inUseText ? { inUseText: base?.inUseText ?? bench.text } : {}),
      results: { ...(prior?.results ?? {}), ...benchResults },
      ...(prior?.reference || !row.silver ? {} : {
        reference: { text: row.silver, judge: BENCH_JUDGE, at, terms, engines: ['in-use', 'whisper-large-v2'] },
      }),
      imported: BENCH_IMPORT,
    }
    const { id: _id, results, ...fields } = take
    const stored = await compareStore.upsert(id, { ...fields, results })
    const scores = await scoresOf(stored)
    if (scores) await compareStore.upsert(id, { scores })
    out.imported++
  }
  return out
}

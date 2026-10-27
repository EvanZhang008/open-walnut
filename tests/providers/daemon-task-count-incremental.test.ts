/**
 * The daemon's background-task count (TaskState.derivedRunning) moves by each
 * event's own change instead of being recounted over every task.
 *
 * Why: applyTaskEvent recounted all tasks on every task_* line, so a rebuild of
 * a long session's stream was quadratic in the tasks it ever ran. On
 * 2026-10-27 a resume of a 2.5 GB stream spent 214 s in that pass with the
 * daemon's thread held. The incremental count must equal a recount after
 * EVERY event, or a fold checkpoint written by the old logic and a state built
 * by the new one would disagree (the checkpoint format was deliberately NOT
 * bumped: bumping rejects every checkpoint, which is how the incident began).
 *
 * Runs the real function text of both twins: the source template as emitted,
 * the standalone twin transpiled with esbuild.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as esbuild from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

interface TS { tasks: Record<string, unknown>; derivedRunning: number }
interface Fns { empty: () => TS; apply: (ts: TS, parsed: Record<string, unknown>, v: number, now: number) => boolean; count: (ts: TS) => number }

function build(src: string): Fns {
  const body = [
    "const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed']);",
    'const BG_TRANSITION_CAP = 50;',
    extractFn(src, 'emptyTaskState'),
    extractFn(src, 'runningTaskCount'),
    extractFn(src, 'applyTaskEvent'),
    'return { empty: emptyTaskState, apply: applyTaskEvent, count: runningTaskCount };',
  ].join('\n')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(body)() as Fns
}

function standaloneSource(): string {
  const file = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
  const text = fs.readFileSync(file, 'utf8')
  // Only the three functions: types stripped, nothing else of the file run.
  const fns = ['emptyTaskState', 'runningTaskCount', 'applyTaskEvent'].map((n) => extractFn(text, n)).join('\n')
  return esbuild.transformSync('interface TaskStateEntry { status: string; isBackgrounded?: boolean }\ntype TaskState = any\n' + fns, { loader: 'ts' }).code
}

/** Small deterministic PRNG, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

const SUBTYPES = ['task_started', 'task_progress', 'task_updated', 'task_notification', 'task_other']
const STATUSES = ['running', 'completed', 'failed', 'stopped', 'cancelled', 'killed', 'pending', undefined]

function randomEvent(r: () => number): Record<string, unknown> {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const ev: Record<string, unknown> = { type: r() < 0.97 ? 'system' : 'assistant', subtype: pick(SUBTYPES), task_id: r() < 0.98 ? 't' + Math.floor(r() * 40) : undefined }
  if (r() < 0.6) ev.tool_use_id = 'tu' + Math.floor(r() * 4)
  if (r() < 0.2) ev.is_backgrounded = r() < 0.5
  if (ev.subtype === 'task_updated') ev.patch = { status: pick(STATUSES), ...(r() < 0.2 ? { is_backgrounded: r() < 0.5 } : {}) }
  if (ev.subtype === 'task_notification') ev.status = pick(STATUSES)
  return ev
}

describe.each([
  ['source twin', () => build(getDaemonSource())],
  ['standalone twin', () => build(standaloneSource())],
] as const)('incremental task count: %s', (_name, make) => {
  it('equals a full recount after every event of random sequences', () => {
    const fns = make()
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed)
      const ts = fns.empty()
      for (let i = 0; i < 4000; i++) {
        fns.apply(ts, randomEvent(r), i + 1, 1000)
        if (ts.derivedRunning !== fns.count(ts)) {
          throw new Error(`seed ${seed} event ${i}: derivedRunning ${ts.derivedRunning} != recount ${fns.count(ts)}`)
        }
      }
    }
  })

  it('continues from a checkpointed state that carries the count', () => {
    const fns = make()
    const r = rng(99)
    const ts = fns.empty()
    for (let i = 0; i < 2000; i++) fns.apply(ts, randomEvent(r), i + 1, 1000)
    // A checkpoint is the JSON of the state; a load parses it back.
    const restored = JSON.parse(JSON.stringify(ts)) as TS
    for (let i = 2000; i < 4000; i++) fns.apply(restored, randomEvent(r), i + 1, 1000)
    expect(restored.derivedRunning).toBe(fns.count(restored))
  })

  it('is linear in the tasks a session ran: 30k tasks fold in seconds, not minutes', () => {
    const fns = make()
    const ts = fns.empty()
    const t0 = Date.now()
    let v = 0
    for (let n = 0; n < 30_000; n++) {
      const id = 'bg-' + n
      fns.apply(ts, { type: 'system', subtype: 'task_started', task_id: id, tool_use_id: 'tu-' + n }, ++v, 1)
      for (let k = 0; k < 5; k++) fns.apply(ts, { type: 'system', subtype: 'task_progress', task_id: id, tool_use_id: 'tu-' + n }, ++v, 1)
      fns.apply(ts, { type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: 'tu-' + n, status: 'completed' }, ++v, 1)
    }
    // The recount per event took minutes here (210k events x up to 30k tasks).
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(ts.derivedRunning).toBe(0)
    expect(fns.count(ts)).toBe(0)
  })
})

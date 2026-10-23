/**
 * Bounded whale-file task rebuild — the death trigger of the 2026-08-13
 * phone-send data-loss family. rebuildTaskStateFromJsonl used to
 * readFileSync the WHOLE stream jsonl (156MB observed) + split() it into an
 * array on every attach/resume/adopt: RSS 104MB→789MB in ~30s, then a silent
 * runtime death mid phone-bridge send. Both twins now stream it in 1MB
 * chunks with a byte-carry.
 *
 * This test runs the SOURCE TEMPLATE's extracted function (the same text the
 * remote daemon executes) against a synthetic multi-MB jsonl and asserts:
 *   1. correctness — identical TaskState output vs a naive whole-file replay;
 *   2. memory — peak RSS growth while rebuilding a ~64MB file stays far below
 *      the file size (the old implementation grew by ≥ 2× file size:
 *      string + split array).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let tmpDir = ''
/** A child's last line: its own peak RSS (KB on Node and bun). */
const PEAK_LINE = 'console.log(JSON.stringify({ maxRSSkb: process.resourceUsage().maxRSS }));'
let jsonlPath = ''

/** Extract a top-level `function <name>(...) {...}` from the emitted template. */
function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  expect(at, `${name} not found in template`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1)
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

interface TaskStateShape {
  tasks: Record<string, { status: string; v: number; toolUseId?: string; isBackgrounded?: boolean }>
  resourceVersion: number
  derivedRunning: number
  recentTransitions: Array<{ taskId: string; status: string }>
}

type RebuildFn = (jsonlPath: string, now: number) => TaskStateShape

/** Build the production rebuild function from the template text, with its
 *  real helpers (applyTaskEvent etc.) in scope. */
function buildTemplateRebuild(): RebuildFn {
  const src = getDaemonSource()
  const parts = [
    "const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed']);",
    'const BG_TRANSITION_CAP = 20;',
    "const TASK_LINE_MARKER = Buffer.from('\"task_');",
    'const FOLD_REBUILD_CHUNK = 1024 * 1024;',
    'const TAILER_CARRY_MAX = 32 * 1024 * 1024;',
    'const logMsg = () => {};',
    // No fold checkpoint: these cases pin the rebuild from byte 0.
    'const foldCheckpoint = { load: () => null, restampTaskState: (t) => t };',
    extractFn(src, 'emptyTaskState'),
    extractFn(src, 'runningTaskCount'),
    extractFn(src, 'applyTaskEvent'),
    extractFn(src, 'rebuildTaskStateFromJsonl'),
    'return rebuildTaskStateFromJsonl;',
  ].join('\n')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('fs', 'Buffer', parts)(fs, Buffer) as RebuildFn
}

/** Naive reference replay (the OLD semantics, minus the memory blowup). */
function referenceRebuild(rebuildSrcFns: { apply: string; empty: string; running: string }, file: string, now: number): TaskStateShape {
  const parts = [
    "const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed']);",
    'const BG_TRANSITION_CAP = 20;',
    rebuildSrcFns.empty,
    rebuildSrcFns.running,
    rebuildSrcFns.apply,
    `return (text, now) => {
      const ts = emptyTaskState();
      let lineStartV = 0;
      for (const line of text.split('\\n')) {
        const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1;
        lineStartV = v;
        if (!line.trim() || !line.includes('"task_')) continue;
        try { applyTaskEvent(ts, JSON.parse(line), v, now); } catch {}
      }
      return ts;
    };`,
  ].join('\n')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('Buffer', parts)(Buffer) as (text: string, now: number) => TaskStateShape
  return fn(fs.readFileSync(file, 'utf-8'), now)
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-task-rebuild-mem-'))
  jsonlPath = path.join(tmpDir, 'whale.jsonl')
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeWhale(targetBytes: number): void {
  // Interleave rare task_* lines with bulk assistant noise — the realistic
  // whale shape (task lines are <0.1% of a 156MB stream).
  const fd = fs.openSync(jsonlPath, 'w')
  try {
    const noise = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(8000) }] },
    }) + '\n'
    let written = 0
    let taskSeq = 0
    while (written < targetBytes) {
      // one task event per ~100 noise lines
      for (let i = 0; i < 100 && written < targetBytes; i++) {
        fs.writeSync(fd, noise)
        written += noise.length
      }
      taskSeq++
      const started = JSON.stringify({ type: 'system', subtype: 'task_started', task_id: `t${taskSeq}`, description: `job ${taskSeq}` }) + '\n'
      fs.writeSync(fd, started)
      written += started.length
      if (taskSeq % 2 === 0) {
        const done = JSON.stringify({ type: 'system', subtype: 'task_updated', task_id: `t${taskSeq}`, patch: { status: 'completed' } }) + '\n'
        fs.writeSync(fd, done)
        written += done.length
      }
    }
  } finally {
    fs.closeSync(fd)
  }
}

describe('streamed rebuildTaskStateFromJsonl (template-extracted production code)', () => {
  it('rebuilds a reused background task under its current invocation identity', () => {
    const event = (subtype: string, toolUseId?: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      type: 'system', subtype, task_id: 'reused-agent', tool_use_id: toolUseId, ...extra,
    })
    const lines = [
      event('task_started', 'call-first', { is_backgrounded: true }),
      event('task_updated', undefined, { patch: { status: 'completed' } }),
      event('task_notification', 'call-first', { status: 'completed' }),
      event('task_started', 'call-second', { is_backgrounded: true }),
      event('task_progress', 'call-second'),
      event('task_notification', 'call-first', { status: 'completed' }),
    ]
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n')
    const rebuild = buildTemplateRebuild()
    const running = rebuild(jsonlPath, 1000)
    expect(running.tasks['reused-agent']).toMatchObject({ status: 'running', toolUseId: 'call-second', isBackgrounded: true })
    fs.appendFileSync(jsonlPath, event('task_notification', 'call-second', { status: 'completed' }) + '\n')
    expect(rebuild(jsonlPath, 2000).tasks['reused-agent']).toMatchObject({ status: 'completed', toolUseId: 'call-second' })
  })

  it('produces the exact same TaskState as a whole-file replay', () => {
    writeWhale(4 * 1024 * 1024) // 4MB is plenty for correctness
    const src = getDaemonSource()
    const rebuild = buildTemplateRebuild()
    const now = Date.now()
    const streamed = rebuild(jsonlPath, now)
    const reference = referenceRebuild({
      apply: extractFn(src, 'applyTaskEvent'),
      empty: extractFn(src, 'emptyTaskState'),
      running: extractFn(src, 'runningTaskCount'),
    }, jsonlPath, now)
    // Timestamps (t) differ by clock; compare the identity-bearing fields.
    expect(Object.keys(streamed.tasks).sort()).toEqual(Object.keys(reference.tasks).sort())
    for (const id of Object.keys(reference.tasks)) {
      expect(streamed.tasks[id].status, id).toBe(reference.tasks[id].status)
      expect(streamed.tasks[id].v, id).toBe(reference.tasks[id].v)
    }
    expect(streamed.resourceVersion).toBe(reference.resourceVersion)
    expect(streamed.derivedRunning).toBe(reference.derivedRunning)
    expect(streamed.recentTransitions.map((t) => t.taskId + ':' + t.status))
      .toEqual(reference.recentTransitions.map((t) => t.taskId + ':' + t.status))
  }, 120_000)

  it('a torn trailing line (CLI mid-write) does not throw and keeps prior state', () => {
    writeWhale(512 * 1024)
    fs.appendFileSync(jsonlPath, '{"type":"system","subtype":"task_started","task_id":"torn-tail"') // no newline
    const rebuild = buildTemplateRebuild()
    const ts = rebuild(jsonlPath, Date.now())
    expect(ts.tasks['torn-tail']).toBeUndefined()
    expect(Object.keys(ts.tasks).length).toBeGreaterThan(0)
  }, 60_000)

  it('the streamed rebuild\'s peak memory stays flat on a whale the whole-file read holds whole', () => {
    // This IS the incident mechanism: the old readFileSync+split rebuild
    // materialized the whole stream and the daemon runtime died on a 156MB whale.
    // Encoded as each child's own peak RSS (resourceUsage().maxRSS) above an
    // empty child's: the naive replay holds about the whole file, the streamed
    // production code a fixed few MB of chunks. Measured on bun 1.4.4: streamed
    // +34MB at 96MB and +37MB at 192MB (flat), naive +102MB and +202MB; three runs
    // each within 1MB. On Node, Buffer.concat garbage inflates RSS until a GC
    // (+79MB at 128MB), so there a hard heap cap (--max-old-space-size, which bun
    // does not have) is the measure instead: the naive replay must die under it.
    const FILE_MB = 128
    writeWhale(FILE_MB * 1024 * 1024)
    const src = getDaemonSource()
    const prelude = [
      "const fs = require('node:fs');",
      "const BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed']);",
      'const BG_TRANSITION_CAP = 20;',
      "const TASK_LINE_MARKER = Buffer.from('\"task_');",
      'const FOLD_REBUILD_CHUNK = 1024 * 1024;',
      'const TAILER_CARRY_MAX = 32 * 1024 * 1024;',
      'const logMsg = () => {};',
      'const foldCheckpoint = { load: () => null, restampTaskState: (t) => t };',
      extractFn(src, 'emptyTaskState'),
      extractFn(src, 'runningTaskCount'),
      extractFn(src, 'applyTaskEvent'),
    ].join('\n')

    const streamedScript = path.join(tmpDir, 'streamed.cjs')
    fs.writeFileSync(streamedScript, [
      prelude,
      extractFn(src, 'rebuildTaskStateFromJsonl'),
      `const ts = rebuildTaskStateFromJsonl(${JSON.stringify(jsonlPath)}, Date.now());`,
      'console.log(JSON.stringify({ taskCount: Object.keys(ts.tasks).length }));',
      PEAK_LINE,
    ].join('\n'))

    const naiveScript = path.join(tmpDir, 'naive.cjs')
    fs.writeFileSync(naiveScript, [
      prelude,
      // The pre-fix implementation, verbatim shape.
      `const text = fs.readFileSync(${JSON.stringify(jsonlPath)}, 'utf-8');`,
      'const ts = emptyTaskState();',
      'const now = Date.now();',
      'let lineStartV = 0;',
      "for (const line of text.split('\\n')) {",
      "  const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1;",
      '  lineStartV = v;',
      '  if (!line.trim() || !line.includes(\'"task_\')) continue;',
      '  try { applyTaskEvent(ts, JSON.parse(line), v, now); } catch {}',
      '}',
      'console.log(JSON.stringify({ taskCount: Object.keys(ts.tasks).length }));',
      PEAK_LINE,
    ].join('\n'))

    if (typeof process.versions.bun !== 'string') {
      const CAP_MB = 48
      const capped = (script: string) => spawnSync(process.execPath, [`--max-old-space-size=${CAP_MB}`, script], { encoding: 'utf-8', timeout: 120_000 })
      const streamed = capped(streamedScript)
      expect(streamed.status, `streamed rebuild died under a ${CAP_MB}MB cap: ${streamed.stderr?.slice(0, 400)}`).toBe(0)
      expect((JSON.parse(streamed.stdout.trim().split('\n')[0]!) as { taskCount: number }).taskCount).toBeGreaterThan(0)
      expect(capped(naiveScript).status, 'the naive whole-file replay unexpectedly SURVIVED the heap cap: the memory test proves nothing').not.toBe(0)
      return
    }
    const peakMB = (script: string): { mb: number; stdout: string } => {
      const r = spawnSync(process.execPath, [script], { encoding: 'utf-8', timeout: 120_000 })
      expect(r.status, `${path.basename(script)} failed: ${r.stderr?.slice(0, 400)}`).toBe(0)
      const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { maxRSSkb: number }
      return { mb: out.maxRSSkb / 1024, stdout: r.stdout }
    }
    const emptyScript = path.join(tmpDir, 'empty.cjs')
    fs.writeFileSync(emptyScript, PEAK_LINE)
    const base = peakMB(emptyScript).mb
    const streamed = peakMB(streamedScript)
    expect((JSON.parse(streamed.stdout.trim().split('\n')[0]!) as { taskCount: number }).taskCount).toBeGreaterThan(0)
    const naive = peakMB(naiveScript)
    expect(streamed.mb - base, `the streamed rebuild peaked ${Math.round(streamed.mb - base)}MB above an empty child on a ${FILE_MB}MB file`).toBeLessThan(FILE_MB / 2)
    expect(naive.mb - base, 'the naive whole-file replay did not hold the file: the memory test proves nothing').toBeGreaterThan(FILE_MB * 0.75)
  }, 300_000)
})

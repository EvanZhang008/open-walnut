/**
 * Every routine executor whose work outlives its run (a message stored in a session's queue, a
 * session or task started) tells the cron engine the moment that work is durable
 * (ExecutorRunContext.markSent), so a run cut between its send and its record is recorded as run
 * instead of repeated or called failed (src/core/cron/sent-run.ts; 2026-11-21, a daily reflection
 * sent twice across a restart and another recorded "timed out" although it had been delivered).
 *
 * The members are read from the source: a new executor file, or a new executor registered outside
 * the executors folder, fails here until it calls markSent or is listed below with the reason it
 * has nothing to mark.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')
const EXECUTORS = path.join(SRC, 'core/routines/executors')

/** Executors with nothing to mark, and why. */
const NO_SENT_MARK: Record<string, string> = {
  // Each outcome its model turn applies (a notify, a task, a session) is keyed by a durable dedup
  // key in the trigger state (watcher-tools.ts acted/seen), so a rerun of the slot repeats none of
  // them; an engine error after an outcome stays an error on purpose, so a broken source backs off.
  'core/routines/executors/watcher.ts': 'outcomes deduped by their own durable keys',
  // The router's wake runs only for its check's fires (trigger-apply.ts), never on the server's
  // clock: each fire is deduped by its sequence number, and executeJob never runs it.
  'core/router/wake.ts': 'trigger fires only, deduped by fire sequence',
}

function code(file: string): string {
  return fs.readFileSync(file, 'utf-8').replace(/^\s*(\/\/|\*).*$/gm, '')
}

function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join('/')
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

describe('routine executors mark their work the moment it is durable', () => {
  it('every executor file calls markSent or says why it has nothing to mark', () => {
    const files = fs.readdirSync(EXECUTORS).filter((f) => f.endsWith('.ts')).map((f) => path.join(EXECUTORS, f))
    expect(files.length).toBeGreaterThanOrEqual(5)
    const unmarked = files.filter((f) => !NO_SENT_MARK[rel(f)] && !/\bmarkSent\b/.test(code(f))).map(rel)
    expect(unmarked).toEqual([])
  })

  it('every executor registered outside the executors folder is counted too', () => {
    const literal = sourceFiles(SRC)
      .filter((f) => !f.startsWith(EXECUTORS + path.sep))
      .filter((f) => /\bregisterExecutor\(\s*\{/.test(code(f)))
      .map(rel)
    const unmarked = literal.filter((f) => !NO_SENT_MARK[f] && !/\bmarkSent\b/.test(code(path.join(SRC, f))))
    expect(unmarked).toEqual([])
  })

  it('the legacy main and isolated paths hand markSent to their delivery', () => {
    const timer = code(path.join(SRC, 'core/cron/timer.ts'))
    expect(timer).toMatch(/runMainAgentWithPrompt\(text, job\.name, job, runCtx\)/)
    expect(timer).toMatch(/runIsolatedAgentJob\(\{[^}]*markSent/)
    const server = code(path.join(SRC, 'web/server.ts'))
    expect(server).toMatch(/onLaunched:\s*markSent/)
    expect(server).toMatch(/deliverToMainAgent\(prompt, job \?\? .*, undefined, ctx\)/)
  })

  it('every name in the list still exists, so the list cannot hide a deleted member', () => {
    for (const f of Object.keys(NO_SENT_MARK)) expect(fs.existsSync(path.join(SRC, f))).toBe(true)
  })
})

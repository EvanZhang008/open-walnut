/**
 * Every routine executor kind says whether it wakes the task its config names
 * (src/core/routines/routine-wake-target.ts). 2026-11-11: the router's wake (`router`) was missing,
 * so a running router read "It stopped, and nothing will wake it". The kinds are read from the
 * source of every ExecutorDefinition, so a new kind fails here until it is listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXECUTOR_WAKES_TASK, wakesTask, wakeWordsOf } from '../../../src/core/routines/routine-wake-target.js'
import { ROUTER_WAKE_EXECUTOR } from '../../../src/core/router/wake.js'

const ROOT = path.resolve(__dirname, '../../..')

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

/** Every `type:` an ExecutorDefinition factory returns, constants resolved. */
function executorKinds(): string[] {
  const kinds = new Set<string>()
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8')
    if (!/\): ExecutorDefinition \{/.test(text)) continue
    for (const m of text.matchAll(/\): ExecutorDefinition \{[\s\S]*?\n {2}return \{\s*\n\s*type: ([^,\n]+),/g)) {
      const raw = m[1]!.trim()
      if (raw === 'ROUTER_WAKE_EXECUTOR') kinds.add(ROUTER_WAKE_EXECUTOR)
      else if (/^'[^']+'$/.test(raw)) kinds.add(raw.slice(1, -1))
      else throw new Error(`${path.relative(ROOT, file)}: executor type ${raw} is not a literal this test can read`)
    }
  }
  return [...kinds].sort()
}

describe('routine executors and the task they wake', () => {
  it('lists every executor kind the source defines', () => {
    const kinds = executorKinds()
    expect(kinds).toEqual(expect.arrayContaining(['session', 'router']))
    expect(kinds.filter((k) => !(k in EXECUTOR_WAKES_TASK))).toEqual([])
  })

  it('counts the router wake and a session routine as waking their target, an agent run not', () => {
    expect(wakesTask({ executor: { type: 'router', config: {} } })).toBe(true)
    expect(wakesTask({ executor: { type: 'session', config: {} } })).toBe(true)
    expect(wakesTask({ executor: { type: 'main-agent', config: {} } })).toBe(false)
    expect(wakesTask({ executor: { type: 'something-new', config: {} } })).toBe(false)
    expect(wakeWordsOf({ executor: { type: 'router', config: {} }, name: 'Router wake: personal' })).toBe('new items in its area')
  })
})

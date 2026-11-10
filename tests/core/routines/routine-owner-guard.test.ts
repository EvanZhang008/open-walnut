/**
 * No routine's missed run reaches the user's notifications while the org has a Main
 * (src/core/routines/missed-runs.ts, cron/run-log.ts routineOwnerChain). 2026-11-10, Walnut VP:
 * the org reflection's and Inbox Triage's missed runs went to the user because neither had an
 * owner.
 *
 * The executor types are listed from the source, so a new kind of routine is checked as soon as it
 * exists: with a Main, a missed run of it is told to a task (its owner, the task it delivers into,
 * else Main), never a notification, even when every task before Main cannot be reached.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { routineOwnerChain } from '../../../src/core/cron/run-log.js'
import { noticeMissedRunsOnce } from '../../../src/core/routines/missed-runs.js'
import type { CronJob } from '../../../src/core/cron/types.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const HOUR = 3_600_000
const SLOT = Date.UTC(2026, 10, 8, 16, 0, 0)

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function executorTypes(): string[] {
  const types = new Set<string>()
  for (const f of sources(path.join(ROOT, 'src'))) {
    const text = fs.readFileSync(f, 'utf8')
    // An executor definition: its type, then its label (routines/types.ts ExecutorDefinition).
    for (const m of text.matchAll(/\btype:\s*(?:'([a-z][a-z0-9-]*)'|([A-Z_]+)),\s*label:/g)) {
      const name = m[1] ?? new RegExp(`\\b${m[2]}\\s*=\\s*'([a-z][a-z0-9-]*)'`).exec(text)?.[1]
      if (name) types.add(name)
    }
  }
  return [...types].sort()
}

const missedJob = (type: string, config: Record<string, unknown>, over: Partial<CronJob> = {}): CronJob => ({
  id: `r-${type}`, name: type, enabled: true, createdAtMs: SLOT - 10 * 24 * HOUR, updatedAtMs: 0,
  sessionTarget: 'isolated', wakeMode: 'now', payload: { kind: 'agentTurn', message: 'x' },
  schedule: { kind: 'cron', expr: '0 16 * * *', tz: 'UTC' },
  executor: { type, config },
  state: { runLogSinceMs: SLOT - HOUR, runLog: [{ atMs: SLOT + 1, slotMs: SLOT, status: 'error', durationMs: 1, error: 'no room' }] },
  ...over,
} as unknown as CronJob)

describe('a missed run reaches a task while the org has a Main', () => {
  const types = executorTypes()

  it('the scan finds the executor types', () => {
    expect(types.length, 'the matcher broke').toBeGreaterThanOrEqual(5)
    expect(types).toEqual(expect.arrayContaining(['claude-code', 'main-agent', 'session', 'walnut-agent']))
  })

  for (const type of types) {
    it(`${type}: told to a task, never a notification, whatever before Main is unreachable`, async () => {
      for (const job of [missedJob(type, {}), missedJob(type, { target: 'gone' }), missedJob(type, { target: 'gone' }, { ownerTaskId: 'gone-owner' })]) {
        const bells: unknown[] = []
        const tellTeam = vi.fn(async ({ taskId }: { taskId: string }) => taskId === 'main-ceo')
        await noticeMissedRunsOnce({
          service: async () => ({ list: async () => [job], markMissed: async () => job }),
          tellTeam, bell: async (i) => { bells.push(i) }, mainTaskId: async () => 'main-ceo', now: () => SLOT + 2 * HOUR,
        })
        expect(bells, `${type} ${JSON.stringify(job.executor.config)}`).toEqual([])
        expect(tellTeam.mock.calls.at(-1)?.[0].taskId).toBe('main-ceo')
        expect(routineOwnerChain(job, 'main-ceo').at(-1)).toBe('main-ceo')
      }
    })
  }
})

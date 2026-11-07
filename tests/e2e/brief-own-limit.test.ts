/**
 * A Brief's length limit holds only its writer's own lines, on a real server (PUT
 * /api/v1/tasks/:id/brief, src/core/sessions/brief-write.ts). 2026-11-06, Main: the asks Walnut
 * adds after a write kept the stored letter over BRIEF_MAX_CHARS, so every later edit came back
 * 413 brief_too_long and Main rewrote the whole letter four times that day. For Main and a lead:
 *   - a letter near the limit is stored past it once Walnut adds the team's asks;
 *   - a follow-up edit that grows the writer's lines (still under the limit) goes through;
 *   - the stored letter written back whole as content (Walnut's lines and all) goes through;
 *   - an edit that takes the writer's own lines past the limit is still refused.
 * Only the Claude CLI is mocked (no CLI runs here).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-brief-own-limit'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { BRIEF_MAX_CHARS } from '../../src/core/user-status.js'

let base = ''
const workers: string[] = []

async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 20_000
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function write(id: string, payload: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${base}/api/v1/tasks/${id}/brief`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  for (let i = 0; i < 12; i++) {
    const { task } = await addTask({ title: `Garden job ${i} with a title long enough to read like a real one`, project: 'Garden' })
    workers.push(task.id)
  }
  // Ten of them ask the user (more than Walnut adds by name), with long asks.
  for (let i = 0; i < 10; i++) {
    await updateTaskRaw(workers[i]!, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: `Decide which supplier gets the order for bed ${i}: ${'the prices are in the sheet, '.repeat(6)}`, at: new Date().toISOString() } }, { emitEvent: true, source: 'status-report' })
  }
  for (let i = 10; i < 12; i++) await updateTaskRaw(workers[i]!, { phase: 'IN_PROGRESS' }, { emitEvent: true, source: 'status-report' })
  await until('the asks are derived', async () => (await getTask(workers[9]!)).user_status?.state === 'needs')
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** A letter whose own lines come to just under the limit: lines about one non-asking worker. */
function nearLimitLetter(about: string): string {
  const lines: string[] = []
  for (let i = 0; ; i++) {
    const next = [...lines, `- <task-ref id="${about}" label="Job"/>: step ${i} of the plan runs as the sheet says`]
    if (next.join('\n').length > BRIEF_MAX_CHARS - 250) break
    lines.push(next[next.length - 1]!)
  }
  return `### Needs you\n- None\n### Working\n${lines.join('\n')}\n### Waiting / snoozed\n- None`
}

describe('the Brief limit counts only the writer\'s own lines', () => {
  for (const who of ['main', 'lead'] as const) {
    it(`${who}: edits after Walnut took the stored letter past the limit`, async () => {
      const node = who === 'main' ? await ensureMainTask() : await ensureProjectLead('Garden')
      const about = workers[10]!
      const first = await write(node.id, { content: nearLimitLetter(about) })
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const stored = (await getTask(node.id)).brief!.text
      // Walnut added the team's asks: the stored text is past the limit, the writer's share is not.
      expect(stored.length).toBeGreaterThan(BRIEF_MAX_CHARS)
      expect(first.body.own_chars).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
      expect(first.body.chars).toBe(stored.length)

      // A follow-up edit that adds a short line of the writer's own: it grows the letter.
      const lastLine = stored.split('\n').filter((l) => l.includes('step '))!.pop()!
      const grown = await write(node.id, { edits: [{ old: lastLine, new: `${lastLine}\n- <task-ref id="${workers[11]}" label="Job 11"/>: started` }] })
      expect(grown.status, JSON.stringify(grown.body)).toBe(200)
      expect((await getTask(node.id)).brief!.text).toContain('label="Job 11"/>: started')

      // The stored letter, Walnut's lines and all, written back whole.
      const whole = await write(node.id, { content: (await getTask(node.id)).brief!.text })
      expect(whole.status, JSON.stringify(whole.body)).toBe(200)

      // Still held: an edit that takes the writer's own lines past the limit.
      const over = await write(node.id, { edits: [{ old: 'label="Job 11"/>: started', new: `label="Job 11"/>: started ${'and much more '.repeat(40)}` }] })
      expect(over.status).toBe(413)
      expect(over.body.error?.code ?? over.body.code ?? JSON.stringify(over.body)).toContain('brief_too_long')
      // And nothing of it was stored.
      expect((await getTask(node.id)).brief!.text).not.toContain('and much more')
    })
  }
})

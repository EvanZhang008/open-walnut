/**
 * Usage and cost read an archived session (transcript-archive.ts) as they read
 * a plain one, through gunzip, and never restore it: the full scan, the indexed
 * scan, the list of sessions Walnut did not start, and a session's cost state.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { archiveTranscripts } from '../../src/providers/transcript-archive.js'
import { scanCanonicalUsage, scanCostState } from '../../src/providers/usage-scan-core.js'
import { scanCanonicalUsageIndexed } from '../../src/providers/usage-scan-index.js'
import { claudeSessionMetas } from '../../src/providers/claude-outside-core.js'

const DAY = 86_400_000
let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-archived-')) })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function writeSession(projects: string, sid: string, agent: boolean): string {
  const dir = path.join(projects, '-work-marina')
  fs.mkdirSync(path.join(dir, sid, 'subagents'), { recursive: true })
  const row = (id: string) => ({ type: 'assistant', sessionId: sid, entrypoint: 'cli', cwd: '/work/marina', timestamp: '2026-08-01T12:00:00Z',
    message: { id, model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 30 } } })
  const cost = { type: 'cost-state', sessionId: sid, totalCostUSD: 7, totalAPIDuration: 1, totalAPIDurationWithoutRetries: 1, totalToolDuration: 2, totalLinesAdded: 0, totalLinesRemoved: 0, totalDuration: 3, startTime: 1,
    modelUsage: { 'claude-opus-4-8': { inputTokens: 12, outputTokens: 8, cacheReadInputTokens: 30, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 7 } } }
  // Big enough that the archive compresses the sidecar too.
  const pad = Array.from({ length: 120 }, (_, i) => JSON.stringify({ type: 'progress', i, text: 'x'.repeat(100) })).join('\n') + '\n'
  const main = path.join(dir, `${sid}.jsonl`)
  fs.writeFileSync(main, pad + JSON.stringify(row(`${sid}-m1`)) + '\n' + JSON.stringify(cost) + '\n')
  if (agent) fs.writeFileSync(path.join(dir, sid, 'subagents', 'agent-a1.jsonl'), pad + JSON.stringify({ ...row(`${sid}-a1`), isSidechain: true }) + '\n')
  return main
}

it('every usage read counts an archived session the same, and none restores it', async () => {
  const projects = path.join(root, 'projects')
  const main = writeSession(projects, 'u-arch', true)
  const read = async () => ({
    full: (await scanCanonicalUsage({ projectsDir: projects })).records.length,
    indexed: (await scanCanonicalUsageIndexed({ projectsDir: projects, indexPath: path.join(root, 'index.jsonl') })).records.length,
    metas: [...(await claudeSessionMetas(projects)).values()].map((m) => [m.sessionId, m.entrypoint, m.cwd]),
    cost: (await scanCostState({ projectsDir: projects, sessionId: 'u-arch' }))?.totalCostUsd,
  })
  const before = await read()
  expect(before.full).toBe(2)
  expect((await archiveTranscripts([projects], { olderThanMs: 60 * DAY, now: Date.now() + 100 * DAY })).sessions).toBe(1)
  expect(fs.existsSync(main)).toBe(false)
  expect(fs.existsSync(path.join(path.dirname(main), 'u-arch', 'subagents', 'agent-a1.jsonl.gz'))).toBe(true)
  // The indexed scan read the plain files before; it reads the archives as new files once and counts nothing twice.
  expect(await read()).toEqual(before)
  expect(await read()).toEqual(before)
  expect(fs.existsSync(main)).toBe(false)
})

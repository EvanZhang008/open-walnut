import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliOneShotTime } from '../../src/providers/daemon-cron-schedule.js'
import {
  collectCronRestoreFacts, DEFAULT_CRON_RESTORE_CONFIG, readCronTranscript,
  slimCronTranscriptLine, type CronTranscriptLine,
} from '../../src/providers/daemon-cron-transcript.js'

const createdAt = Date.UTC(2026, 7, 1, 12)
const config = DEFAULT_CRON_RESTORE_CONFIG
const jobId = 'abcd1234'
let directory: string
const asLine = (raw: Record<string, unknown>) => slimCronTranscriptLine(raw)
const create = (over: Record<string, unknown> = {}) => asLine({
  type: 'assistant', uuid: 'create', parentUuid: null, timestamp: new Date(createdAt).toISOString(),
  message: { id: 'api-1', content: [{ type: 'tool_use', id: 'call-1', name: 'CronCreate', input: { cron: '* * * * *', prompt: 'Example' } }] },
  ...over,
})
const result = (over: Record<string, unknown> = {}) => asLine({
  type: 'user', uuid: 'result', parentUuid: 'create', timestamp: new Date(createdAt + 1000).toISOString(),
  message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Created job.' }] },
  toolUseResult: { id: jobId, durable: false, recurring: true }, ...over,
})
const facts = (lines: CronTranscriptLine[], at = createdAt + 2000) => collectCronRestoreFacts(lines, config, at, cliOneShotTime)

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-cron-transcript-')) })
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })

describe('CLI-owned cron resume semantics', () => {
  it('restores the original id without retaining the prompt body', () => {
    const lines = [create(), result()]
    expect(facts(lines)).toEqual({ status: 'active', ids: [jobId], reason: null })
    expect(JSON.stringify(lines)).not.toContain('Example')
    expect(JSON.stringify(lines)).not.toContain('Created job.')
  })

  it('does not renew a recurring job at the exact expiry boundary', () => {
    expect(facts([create(), result()], createdAt + 604800000 - 1).status).toBe('active')
    expect(facts([create(), result()], createdAt + 604800000).status).toBe('inactive')
    expect(facts([create(), result()], createdAt + 604800001).status).toBe('inactive')
  })

  it('skips durable jobs, failed creates, missing results and missing prompt values', () => {
    expect(facts([create(), result({ toolUseResult: { id: jobId, durable: true } })]).status).toBe('inactive')
    expect(facts([create(), result({ message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true }] } })]).status).toBe('inactive')
    expect(facts([create()]).status).toBe('inactive')
    expect(facts([create({ message: { content: [{ type: 'tool_use', id: 'call-1', name: 'CronCreate', input: { cron: '* * * * *' } }] } }), result()]).status).toBe('inactive')
  })

  it('a delete invocation suppresses restoration even without a successful result', () => {
    const deleted = asLine({
      type: 'assistant', uuid: 'delete', parentUuid: 'result', timestamp: new Date(createdAt + 2000).toISOString(),
      message: { content: [{ type: 'tool_use', id: 'delete-call', name: 'CronDelete', input: { id: jobId } }] },
    })
    expect(facts([create(), result(), deleted]).status).toBe('inactive')
  })

  it('loads the compacted branch once its summary exists', () => {
    const compact = asLine({ type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null, timestamp: new Date(createdAt + 3000).toISOString() })
    const summary = asLine({ type: 'user', uuid: 'summary', parentUuid: 'compact', timestamp: new Date(createdAt + 4000).toISOString() })
    expect(facts([create(), result(), compact]).status).toBe('active')
    expect(facts([create(), result(), compact, summary]).status).toBe('inactive')
  })

  it('retains a cron in a preserved compact segment', () => {
    const compact = asLine({
      type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null,
      timestamp: new Date(createdAt + 2000).toISOString(),
      compactMetadata: { preservedSegment: { headUuid: 'create', tailUuid: 'result', anchorUuid: 'compact' } },
    })
    const after = asLine({ type: 'user', uuid: 'after', parentUuid: 'compact', timestamp: new Date(createdAt + 3000).toISOString() })
    expect(facts([create(), result(), compact, after]).ids).toEqual([jobId])
  })

  it('loads the 2.1.258 preservedMessages list even when no segment walk exists', () => {
    const compact = asLine({
      type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null,
      timestamp: new Date(createdAt + 2000).toISOString(),
      compactMetadata: { preservedMessages: { anchorUuid: 'compact', uuids: ['create', 'result'] } },
    })
    const after = asLine({ type: 'user', uuid: 'after', parentUuid: 'compact', timestamp: new Date(createdAt + 3000).toISOString() })
    expect(facts([create(), result(), compact, after]).ids).toEqual([jobId])
  })

  it('gives the 2.1.258 preservedMessages list priority over a conflicting segment', () => {
    const compact = asLine({
      type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null,
      timestamp: new Date(createdAt + 2000).toISOString(),
      compactMetadata: {
        preservedMessages: { anchorUuid: 'compact', uuids: [] },
        preservedSegment: { headUuid: 'create', tailUuid: 'result', anchorUuid: 'compact' },
      },
    })
    const after = asLine({ type: 'user', uuid: 'after', parentUuid: 'compact', timestamp: new Date(createdAt + 3000).toISOString() })
    expect(facts([create(), result(), compact, after]).status).toBe('inactive')
  })

  it('linearizes the 2.1.258 preserved list instead of following its obsolete parents', () => {
    const compact = asLine({
      type: 'system', subtype: 'compact_boundary', uuid: 'compact', parentUuid: null,
      timestamp: new Date(createdAt + 2000).toISOString(),
      compactMetadata: { preservedMessages: { anchorUuid: 'compact', uuids: ['create', 'result'] } },
    })
    const after = asLine({ type: 'user', uuid: 'after', parentUuid: 'compact', timestamp: new Date(createdAt + 3000).toISOString() })
    const detached = result({ parentUuid: null })
    expect(facts([create(), detached, compact, after]).ids).toEqual([jobId])
  })

  it('uses the 2.1.258 timestamp fallback for a missing parent within five seconds', () => {
    const done = asLine({ type: 'assistant', uuid: 'done', parentUuid: 'missing', timestamp: new Date(createdAt + 6000).toISOString() })
    expect(facts([create(), result(), done]).ids).toEqual([jobId])
    const tooLate = asLine({ type: 'assistant', uuid: 'done', parentUuid: 'missing', timestamp: new Date(createdAt + 6001).toISOString() })
    expect(facts([create(), result(), tooLate]).status).toBe('inactive')
  })

  it('excludes an abandoned branch and a newer sidechain', () => {
    const root = asLine({ type: 'user', uuid: 'root', parentUuid: null, timestamp: new Date(createdAt - 1000).toISOString() })
    const rewind = asLine({ type: 'user', uuid: 'rewound', parentUuid: 'root', timestamp: new Date(createdAt + 3000).toISOString() })
    const sidechain = asLine({ type: 'user', uuid: 'side', parentUuid: 'result', isSidechain: true, timestamp: new Date(createdAt + 4000).toISOString() })
    expect(facts([root, create({ parentUuid: 'root' }), result(), rewind, sidechain]).status).toBe('inactive')
  })

  it('recovers a parallel tool result through the official chain loader', () => {
    const sibling = asLine({ type: 'assistant', uuid: 'other', parentUuid: null, timestamp: new Date(createdAt).toISOString(), message: { id: 'api-1', content: [{ type: 'tool_use', id: 'other-call', name: 'Read', input: {} }] } })
    const after = asLine({ type: 'user', uuid: 'other-result', parentUuid: 'other', timestamp: new Date(createdAt + 2000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'other-call' }] } })
    expect(facts([create(), sibling, result(), after]).ids).toEqual([jobId])
  })

  it('uses the conversational leaf even when its timestamp ties its parent', () => {
    const tied = result({ timestamp: new Date(createdAt).toISOString() })
    const withoutApiId = create({ message: { content: [{ type: 'tool_use', id: 'call-1', name: 'CronCreate', input: { cron: '* * * * *', prompt: 'Example' } }] } })
    expect(facts([withoutApiId, tied]).status).toBe('active')
    expect(facts([create(), tied]).status).toBe('active')
    const after = asLine({ type: 'assistant', uuid: 'done', parentUuid: 'result', timestamp: new Date(createdAt + 1).toISOString() })
    expect(facts([create(), tied, after]).ids).toEqual([jobId])
  })

  it('uses the last duplicate uuid value', () => {
    expect(facts([create(), result(), result({ toolUseResult: { id: jobId, durable: true } })]).status).toBe('inactive')
  })

  it('a later non-cron result replaces an earlier result with the same tool_use_id', () => {
    const replacement = result({
      uuid: 'replacement', parentUuid: 'result', timestamp: new Date(createdAt + 2000).toISOString(),
      toolUseResult: { message: 'Other result' },
    })
    expect(facts([create(), result(), replacement]).status).toBe('inactive')
    const arrayResult = result({ uuid: 'array', parentUuid: 'result', timestamp: new Date(createdAt + 2000).toISOString(), toolUseResult: [] })
    expect(facts([create(), result(), arrayResult]).status).toBe('inactive')
    const failed = result({
      uuid: 'failed', parentUuid: 'result', timestamp: new Date(createdAt + 2000).toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true }] },
      toolUseResult: { message: 'Failure' },
    })
    expect(facts([create(), result(), failed]).ids).toEqual([jobId])
  })

  it('honors explicit rewind and clear markers without restoring the discarded cron', () => {
    const root = asLine({ type: 'user', uuid: 'root', parentUuid: null, timestamp: new Date(createdAt - 1000).toISOString() })
    const lines = [root, create({ parentUuid: 'root' }), result()]
    expect(facts([...lines, asLine({ type: 'last-prompt', leafUuid: 'root', explicit: true })]).status).toBe('inactive')
    expect(facts([...lines, asLine({ type: 'last-prompt', leafUuid: null, explicit: true })])).toEqual({ status: 'inactive', ids: [], reason: 'cli-cleared' })
  })

  it('returns unknown for missing chain or an invalid creation time', () => {
    expect(facts([]).status).toBe('unknown')
    expect(facts([create({ timestamp: 'invalid' }), result()]).status).toBe('unknown')
  })

  it('does not restore a one-shot after its actual scheduled instant', () => {
    const oneShot = result({ toolUseResult: { id: jobId, recurring: false, durable: false } })
    const at = cliOneShotTime('* * * * *', createdAt, jobId, config)!
    expect(facts([create(), oneShot], at).status).toBe('active')
    expect(facts([create(), oneShot], at + 1).status).toBe('inactive')
  })

  it('obeys disabled and unlimited-age configuration', () => {
    expect(collectCronRestoreFacts([create(), result()], { ...config, enabled: false }, createdAt, cliOneShotTime).status).toBe('inactive')
    expect(collectCronRestoreFacts([create(), result()], { ...config, recurringMaxAgeMs: 0 }, createdAt + 1e12, cliOneShotTime).status).toBe('active')
  })
})

describe('host-local canonical transcript reading', () => {
  it('reads a dense transcript but retains only topology and cron facts', async () => {
    const file = path.join(directory, 'session.jsonl')
    const rows = Array.from({ length: 500 }, (_, i) => ({
      type: 'user', uuid: String(i), parentUuid: i === 0 ? null : String(i - 1),
      timestamp: new Date(createdAt + i).toISOString(), message: { content: '\u6587\u6863🙂'.repeat(1000) }, // CJK "document" + emoji: multi-byte content
    }))
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const before = await fs.readFile(file)
    const lines = await readCronTranscript(file, AbortSignal.timeout(10000))
    expect(lines).toHaveLength(500)
    expect(JSON.stringify(lines).length).toBeLessThan(100000)
    expect((await fs.readFile(file)).equals(before)).toBe(true)
  })

  it('applies both real large-file loader paths before collecting cron facts', async () => {
    const file = path.join(directory, 'large.jsonl')
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const rows: Record<string, unknown>[] = [
      { parentUuid: null, type: 'user', uuid: id(0), timestamp: new Date(createdAt - 1000).toISOString(), message: { content: 'x'.repeat(5 * 1024 * 1024) } },
      { parentUuid: id(0), type: 'assistant', uuid: id(1), timestamp: new Date(createdAt).toISOString(), message: { content: [{ type: 'tool_use', id: 'call-1', name: 'CronCreate', input: { cron: '* * * * *', prompt: 'Example' } }] } },
      { parentUuid: id(1), type: 'user', uuid: id(2), timestamp: new Date(createdAt + 1000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] }, toolUseResult: { id: jobId, durable: false, recurring: true } },
      { parentUuid: null, type: 'user', uuid: id(3), timestamp: new Date(createdAt + 2000).toISOString(), message: { content: 'Other branch' } },
      { type: 'last-prompt', leafUuid: id(2), explicit: true },
    ]
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const before = await fs.stat(file)
    expect(before.size).toBeGreaterThan(5 * 1024 * 1024)
    expect(facts(await readCronTranscript(file, AbortSignal.timeout(10000))).ids).toEqual([jobId])
    expect(facts(await readCronTranscript(file, AbortSignal.timeout(10000), true)).status).toBe('inactive')
    const after = await fs.stat(file)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
  })

  it('does not interpret a partial or corrupt line as no cron', async () => {
    const file = path.join(directory, 'session.jsonl')
    for (const text of ['{"type":"assistant"}', '{"type":\n', '{}\ninvalid\n']) {
      await fs.writeFile(file, text)
      await expect(readCronTranscript(file, AbortSignal.timeout(1000))).rejects.toThrow()
    }
  })

  it('supports cancellation and rejects missing files', async () => {
    const file = path.join(directory, 'session.jsonl')
    await expect(readCronTranscript(file, AbortSignal.timeout(1000))).rejects.toThrow()
    await fs.writeFile(file, '{}\n')
    await expect(readCronTranscript(file, AbortSignal.abort())).rejects.toThrow()
  })
})

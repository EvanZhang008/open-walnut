/**
 * The idle clock's fallback after a server start (src/core/transcript-last-activity.ts):
 * the newest timestamped entry of the CLI's own transcript.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { lastEntryTimestampMs, transcriptLastActivityMs } from '../../src/core/transcript-last-activity.js'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }) })

const entry = (ts: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', ...extra, timestamp: ts })

describe('lastEntryTimestampMs', () => {
  it('takes the newest entry with a timestamp and passes over lines without one', () => {
    const text = [entry('2026-10-26T01:00:00.000Z'), entry('2026-10-26T02:04:11.000Z'), '{"type":"cost-state","state":null}', ''].join('\n')
    expect(lastEntryTimestampMs(text)).toBe(Date.parse('2026-10-26T02:04:11.000Z'))
  })

  it('reads the entry\'s own timestamp, not one inside its content', () => {
    const line = JSON.stringify({ type: 'user', timestamp: '2026-10-26T02:00:00.000Z', toolUseResult: { timestamp: '2026-10-26T09:00:00.000Z' } })
    expect(lastEntryTimestampMs(line)).toBe(Date.parse('2026-10-26T02:00:00.000Z'))
  })

  it('null when nothing has one', () => {
    expect(lastEntryTimestampMs('')).toBeNull()
    expect(lastEntryTimestampMs('{"type":"cost-state"}\n')).toBeNull()
  })
})

describe('transcriptLastActivityMs', () => {
  it('reads only the tail of a large transcript and skips its cut first line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-tail-'))
    dirs.push(dir)
    const file = path.join(dir, 's.jsonl')
    const big = entry('2026-10-25T00:00:00.000Z', { pad: 'x'.repeat(400_000) })
    await fs.writeFile(file, [big, entry('2026-10-26T03:00:00.000Z'), '{"type":"cost-state"}', ''].join('\n'))
    expect(await transcriptLastActivityMs(file)).toBe(Date.parse('2026-10-26T03:00:00.000Z'))
  })

  it('steps back further when one entry fills the whole first tail', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-tail-'))
    dirs.push(dir)
    const file = path.join(dir, 's.jsonl')
    const huge = entry('2026-10-26T04:00:00.000Z', { pad: 'y'.repeat(600_000) })
    await fs.writeFile(file, [entry('2026-10-26T01:00:00.000Z', { pad: 'z'.repeat(300_000) }), huge, '{"type":"cost-state"}', ''].join('\n'))
    expect(await transcriptLastActivityMs(file)).toBe(Date.parse('2026-10-26T04:00:00.000Z'))
  })

  it('null for a tail that is one cut line with no newline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-tail-'))
    dirs.push(dir)
    const file = path.join(dir, 's.jsonl')
    await fs.writeFile(file, '{"a":"' + 'q'.repeat(5 * 1024 * 1024) + '","timestamp":"2026-10-26T05:00:00.000Z"}')
    expect(await transcriptLastActivityMs(file)).toBeNull()
  })

  it('null for a missing file', async () => {
    expect(await transcriptLastActivityMs('/nonexistent/x.jsonl')).toBeNull()
  })
})

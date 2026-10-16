/**
 * A host session's stream file read on the host while the Mac is away, by a
 * daemon without owner-scoped file reads (src/replica/host-history.ts, WP7):
 * Walnut's markers become the person's words (the last marker per message id),
 * every other line passes untouched, and the real transcript parsers read the
 * result. The answer is the leader's full answer's shape, always windowed.
 *
 * Parity: the mock CLI (tests/providers/mock-claude.mjs, the browser fixtures'
 * CLI) runs real turns; its stdout is what the daemon keeps in the stream file
 * (with the daemon's marker for each delivery), and the transcript it writes is
 * what the Mac's history route parses. The console's rows read from the stream
 * file must be the rows the Mac shows for the same turns.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostHistoryAnswer, hostHistoryMessages, hostTranscriptAnswer, streamFileForParse, HOST_HISTORY_TAIL_BYTES } from '../../src/replica/host-history.js'
import { parseSessionMessages } from '../../src/core/session-history.js'

const line = (o: unknown) => JSON.stringify(o)
const marker = (id: string, text: string, at: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: text }, walnutMessageId: id, timestamp: at, ...extra })
const reply = (id: string, text: string, at: string) =>
  line({ type: 'assistant', message: { id, role: 'assistant', model: 'm', content: [{ type: 'text', text }] }, parent_tool_use_id: null, timestamp: at })
const rows = (main: string) => hostHistoryMessages(streamFileForParse(main))

describe('the stream file as the parser reads it', () => {
  it('keeps the last marker of each message id as a plain user line, in its place', () => {
    const out = streamFileForParse([
      marker('qm-1', 'first', '2026-10-15T10:00:00.000Z', { walnutPid: 1 }),
      reply('msg_1', 'echo: first', '2026-10-15T10:00:01.000Z'),
      marker('qm-1', 'first', '2026-10-15T10:00:02.000Z', { walnutPid: 2 }),
    ].join('\n')).split('\n')
    expect(out).toHaveLength(2)
    expect(JSON.parse(out[0]!)).toMatchObject({ type: 'assistant' })
    expect(JSON.parse(out[1]!)).toEqual({ type: 'user', uuid: 'walnut-qm-1', message: { role: 'user', content: 'first' }, timestamp: '2026-10-15T10:00:02.000Z' })
  })

  it('passes a line that only mentions the marker, a broken line and an empty file through untouched', () => {
    const mention = reply('msg_2', 'the subtype walnut-injected is a marker', '2026-10-15T10:00:00.000Z')
    const broken = '{"type":"user","subtype":"walnut-injected"'
    expect(streamFileForParse([mention, broken].join('\n'))).toBe([mention, broken].join('\n'))
    expect(streamFileForParse('')).toBe('')
  })

  it('the console answer: the leader\'s full shape (cursor = every row, a full answer), always windowed, sliced from the newest', () => {
    // Unicode test data, as \u escapes.
    const words = 'Deploy \u00e9t\u00e9 \u4f60\u597d \u{1F680}'
    const main = [
      marker('qm-1', words, '2026-10-15T10:00:00.000Z'),
      reply('msg_1', `echo: ${words}`, '2026-10-15T10:00:01.000Z'),
      marker('qm-2', 'again', '2026-10-15T10:01:00.000Z'),
      reply('msg_2', 'echo: again', '2026-10-15T10:01:01.000Z'),
    ].join('\n') + '\n'
    const all = hostHistoryAnswer(rows(main), {})
    expect(all.messages.map((m) => `${m.role}: ${m.text}`)).toEqual([`user: ${words}`, `assistant: echo: ${words}`, 'user: again', 'assistant: echo: again'])
    expect({ total: all.total, cursor: all.cursor, delta: all.delta, windowed: all.windowed }).toEqual({ total: 4, cursor: 4, delta: false, windowed: true })
    // A slice keeps the cursor of the whole window: the client's next `since` counts every row.
    expect(hostHistoryAnswer(rows(main), { tail: 1 })).toMatchObject({ total: 4, cursor: 4, windowed: true, messages: [{ text: 'echo: again' }] })
    expect(hostHistoryAnswer(rows(main), { turns: 1 }).messages.map((m) => m.text)).toEqual(['again', 'echo: again'])
    expect(JSON.stringify(hostTranscriptAnswer('s1', main))).toContain(words)
  })

  it('a short file is still a window: the daemon without cut reports cannot prove the start, so older rows need the Mac', () => {
    const main = [marker('qm-1', 'only', '2026-10-15T10:00:00.000Z'), reply('msg_1', 'echo: only', '2026-10-15T10:00:01.000Z')].join('\n')
    expect(hostHistoryAnswer(rows(main), {}).windowed).toBe(true)
    expect(HOST_HISTORY_TAIL_BYTES).toBe(1024 * 1024)
  })
})

describe('parity with the Mac: the same turns, read from the stream file and from the CLI\'s transcript', () => {
  it('the mock CLI\'s turns, stream file side and transcript side, give the same rows (Unicode intact)', () => {
    const mock = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'host-history-parity-'))
    try {
      const transcripts = path.join(work, 'projects')
      const sid = 'cccccccc-7003-4003-8003-000000000003'
      // Unicode test data, as \u escapes.
      // The CLI's transcript, where the mock appends each plain turn the way the real CLI files it.
      fs.mkdirSync(path.join(transcripts, 'marina-project'), { recursive: true })
      fs.writeFileSync(path.join(transcripts, 'marina-project', `${sid}.jsonl`), '')
      const asked = ['Why does the build fail on marina?', 'Caf\u00e9 \u2603 \u{1F330}: and now?', 'Ship it']
      const stream: string[] = []
      asked.forEach((text, i) => {
        const at = new Date(Date.UTC(2026, 9, 15, 10, i, 0)).toISOString()
        // The daemon's marker for the delivery (the CLI does not echo the person's words), then the CLI's stdout.
        stream.push(marker(`qm-${i}`, text, at, { walnutDelivery: 'ordered' }))
        const run = spawnSync(process.execPath, [mock, '-p', '--output-format', 'stream-json', '--verbose', ...(i === 0 ? ['--session-id', sid] : ['--resume', sid]), text], {
          cwd: work, encoding: 'utf8', timeout: 20_000,
          env: { PATH: process.env.PATH ?? '', HOME: work, MOCK_CLAUDE_PLAIN_ECHO: '1', MOCK_CLAUDE_PERSIST_DIR: transcripts, MOCK_CLAUDE_PERSIST_SESSIONS: sid },
        })
        expect(run.status, run.stderr).toBe(0)
        for (const l of run.stdout.split('\n')) if (l.trim()) stream.push(l)
      })
      const transcript = fs.readFileSync(path.join(transcripts, 'marina-project', `${sid}.jsonl`), 'utf8')
      const key = (m: { role: string; text: string }) => `${m.role}: ${m.text}`
      const mac = parseSessionMessages(transcript).map(key)
      const here = hostHistoryAnswer(rows(stream.join('\n') + '\n'), {}).messages.map(key)
      expect(mac.length).toBe(asked.length * 2)
      expect(here).toEqual(mac)
      expect(here.join('\n')).toContain('Caf\u00e9 \u2603 \u{1F330}')
    } finally {
      fs.rmSync(work, { recursive: true, force: true })
    }
  })
})

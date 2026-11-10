/**
 * Every Walnut MCP tool answer fits one agent tool result, whatever the op
 * (src/lib/tool-answer-fit.ts). 2026-11-10: board_get answered 165,884 characters,
 * over Claude Code's MCP output limit, and the agent read nothing. The guard is
 * in the servers, not in each op, so an op that grows later (or a new one) is
 * covered too: these tests drive both servers' result paths with a huge answer.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fitToolAnswer, TOOL_ANSWER_MAX_CHARS } from '../../src/lib/tool-answer-fit.js'
import { createWalnutMcpHandler } from '../../src/providers/walnut-mcp-stdio.js'

const dirs: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-answer-fit-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const huge = () => ({
  outcome: 'Board of Team: 40 projects.', next: 'Read parts ["html"] before an edit.',
  rows: Array.from({ length: 3000 }, (_, i) => ({ id: `row-${i}`, text: 'x'.repeat(60) })),
})

describe('a tool answer never exceeds one tool result', () => {
  it('an answer that fits is the JSON itself (compact; pretty only when asked and it still fits)', () => {
    expect(fitToolAnswer({ a: 1 }, { op: 'task_get' })).toBe('{"a":1}')
    expect(fitToolAnswer({ a: 1 }, { op: 'task_get', pretty: true })).toBe('{\n  "a": 1\n}')
  })

  it('a too-big answer is written whole to a file; the tool answers its outcome, next, the file and a head', () => {
    const dir = tmp()
    const payload = huge()
    const text = fitToolAnswer(payload, { op: 'board_get', dir })
    expect(text.length).toBeLessThanOrEqual(TOOL_ANSWER_MAX_CHARS)
    const note = JSON.parse(text)
    expect(note).toMatchObject({ too_big: true, op: 'board_get', outcome: payload.outcome, next: payload.next })
    expect(note.chars).toBe(JSON.stringify(payload).length)
    expect(JSON.parse(fs.readFileSync(note.file, 'utf-8'))).toEqual(payload)
    expect(note.hint).toContain(note.file)
  })

  it('a board page too big for one answer is named with the exact command for its html; nothing to encode crashes', () => {
    const dir = tmp()
    const note = JSON.parse(fitToolAnswer({ board: { html: '<p>' + 'x'.repeat(70_000) + '</p>', version: 4 } }, { op: 'board_get', dir }))
    expect(note.hint).toContain(`jq -r .board.html ${note.file}`)
    expect(fitToolAnswer(undefined, { op: 'x', pretty: true })).toBe('null')
  })

  it('never writes into an answer directory others can open', () => {
    const dir = tmp()
    fs.chmodSync(dir, 0o777)
    const note = JSON.parse(fitToolAnswer(huge(), { op: 'board_get', dir }))
    expect(note.file).toBeUndefined()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('the host server (walnut mcp-server) caps every op answer the same way', async () => {
    const dir = tmp()
    const handle = createWalnutMcpHandler({
      answerDir: dir, formatError: (e) => [e.message],
      request: async () => ({ ok: true, result: huge() }),
    })
    const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'any_new_read_op', arguments: {} } })
    const text = (reply?.result as { content: Array<{ text: string }> }).content[0].text
    expect(text.length).toBeLessThanOrEqual(TOOL_ANSWER_MAX_CHARS)
    expect(JSON.parse(text)).toMatchObject({ too_big: true, op: 'any_new_read_op' })
  })

  it('both Walnut MCP servers send every op answer through it (a new result path must too)', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    for (const file of ['src/mcp/tools.ts', 'src/providers/walnut-mcp-stdio.ts']) {
      const src = fs.readFileSync(path.join(root, file), 'utf-8')
      // A text content built from an op result anywhere else bypasses the cap.
      const direct = [...src.matchAll(/type: 'text', text: ([^}]+)\}/g)].map((m) => m[1].trim())
        .filter((t) => /result|payload/.test(t) && !t.startsWith('fitToolAnswer('))
      expect(direct, file).toEqual([])
      expect(src, file).toContain('fitToolAnswer(')
    }
  })
})

/**
 * The mock CLI reads its command words (`error`, `parse-error`, `check background status`, ...)
 * from the message without what Walnut puts around it, as the scenario words are read
 * (computeMessageParts). 2026-11-04: `error` was matched on the raw text, so a resumed session's
 * first message, which carries hints, ran as a normal turn and two e2e tests passed only on CI's
 * retry. Every hint kind is tried, and the source may not match a raw message again.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeHinted, renderHintBlock } from '../../src/core/hints/hint-format.js'

const MOCK = path.resolve(import.meta.dirname, 'mock-claude.mjs')

function run(message: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-command-words-'))
  try {
    return spawnSync(process.execPath, [MOCK, message], { encoding: 'utf-8', timeout: 20_000, env: { ...process.env, HOME: home } })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const hinted = (words: string) => composeHinted(words, {
  before: [renderHintBlock('reply-language', 'Reply in the language of the user.'), renderHintBlock('question', 'Begin with [Q3].', '3')],
  after: [renderHintBlock('rich-output', 'Rich output mode is on.')],
})

describe('the mock CLI reads its command words without Walnut hints', () => {
  it.each([
    ['plain', 'error'],
    ['hinted', hinted('error')],
  ])('%s `error` exits 1 with its stderr', (_label, message) => {
    const r = run(message)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Mock error output')
  })

  it('hinted `parse-error` prints its garbage line', () => {
    const r = run(hinted('parse-error'))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('not valid json at all')
  })

  it('words that only contain a command word are a normal turn', () => {
    const r = run(hinted('explain the error'))
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('Mock error output')
  })

  it('the source never matches a command word on a raw message', () => {
    const src = fs.readFileSync(MOCK, 'utf-8')
    const raw = [...src.matchAll(/(?<![.\w])(message|line|content)\s*(===|!==)\s*'|(?<![.\w])(message|line|content)\.(startsWith|endsWith)\('/g)]
      .map((m) => src.slice(0, m.index).split('\n').length)
    expect(raw, `raw message matched at line(s) ${raw.join(', ')}: match stripInputDecorations(stripBanners(...))`).toEqual([])
  })
})

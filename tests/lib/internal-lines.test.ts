/**
 * Walnut's own line formats never show in a reply the user reads, and no text Walnut gives a session
 * tells it to write them there (src/lib/internal-lines.ts; 2026-11-20: replies of several tasks ended
 * with "FOR_USER_STATE: working" / FOR_USER_NOW / FOR_USER_NEXT after op answers and a built-in skill
 * told them to write FOR_USER_ASK "at the end of your turn"; 2026-11-19: "[v16908844]" in front of replies).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { stripInternalLines } from '../../src/lib/internal-lines.js'
import { NO_ACTION_TAG, readTurnMarker, stripTurnMarker } from '../../src/lib/turn-end-marker.js'
import { parseSessionMessages } from '../../src/core/history-parse.js'
import { shownAcpMessages } from '../../src/providers/acp-journal-projector.js'

/** The reply in the screenshot of 2026-11-20 (mulhj6ie-48d5), in its shape: words, then the report. */
const LEAKED = [
  '两个子 agent 还在跑，完成后我核对、评审、上线。',
  '',
  'FOR_USER_STATE: working',
  'FOR_USER_NOW: 两个子 agent 在实现第一阶段收尾',
  'FOR_USER_NEXT: 核对、评审并上线',
].join('\n')

describe('the text as the screen shows it leaves Walnut\'s lines out', () => {
  // Every way a reply reaches a screen as text goes through these (turn-end-marker.ts is the web
  // chat's, the thread cards' and the session find's).
  // The server reads a session's rows here: the history every client gets (web, phone, task_history,
  // search, notices), and an ACP engine's; the web chat and the thread cards read through stripTurnMarker.
  const base = { sessionId: 's-1', cwd: '/w', version: '2.1.0' }
  const viaHistory = (t: string) => {
    const jsonl = [
      { type: 'user', uuid: 'u-1', parentUuid: null, timestamp: '2026-11-20T01:00:00.000Z', ...base, message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', timestamp: '2026-11-20T01:00:01.000Z', ...base, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: t }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n'
    return parseSessionMessages(jsonl).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n')
  }
  const SHOWN: Array<[string, (t: string) => string]> = [
    ['stripInternalLines', (t) => stripInternalLines(t)],
    ['stripTurnMarker', (t) => stripTurnMarker(t)],
    ['stripTurnMarker while streaming', (t) => stripTurnMarker(t, true)],
    ['the session history (history-parse.ts)', viaHistory],
    ['an ACP engine\'s history', (t) => shownAcpMessages([{ role: 'assistant', text: t, timestamp: '2026-11-20T01:00:01.000Z' }])[0].text],
  ]
  const leaksALine = (shown: string) => shown.split('\n').some((l) => /^\s*(?:[-*]\s+)?(?:\*\*)?FOR_USER_[A-Z]/.test(l) || /^\s*\[v[0-9a-f]{8}\]/.test(l))

  const CASES: Array<[string, string, string]> = [
    ['the status report after the words', LEAKED, LEAKED.split('\n')[0]],
    ['any field, a new one with an id included', 'Done.\n\nFOR_USER_THREAD t1: working | still on it\nFOR_USER_THREAD_NEW: working | Title | words', 'Done.'],
    ['bold or listed field names', 'Done.\n\n**FOR_USER_STATE:** working\n- FOR_USER_NOW: tests', 'Done.'],
    ['a value that wraps onto the next lines', 'Done.\nFOR_USER_ASK: pick one\n  A) keep\n    B) drop\n- C) later', 'Done.'],
    ['a version tag on a report line, a full-width colon, Windows line ends', 'Done.\r\n\r\n[v16908844] FOR_USER_STATE: working\r\nFOR_USER_NOW\uFF1A tests\r\n', 'Done.'],
    ['the Brief block, blank lines and all', 'Done.\nFOR_USER_BRIEF\n- one\n\n- two', 'Done.'],
    ['a version tag at the start of a line', '[v16908844] **进度**：好了。\n[v16908844] 第二行', '**进度**：好了。\n第二行'],
  ]
  for (const [fn, show] of SHOWN) {
    it.each(CASES)(`${fn}: %s`, (_label, text, shown) => {
      const out = show(text)
      expect(leaksALine(out)).toBe(false)
      expect(out).toBe(shown)
    })
  }

  it('keeps the session\'s words: a field line with words after it, a list explaining the fields (review, 2026-11-20)', () => {
    for (const text of [
      'Done.\nFOR_USER_STATE: working\nI also fixed the tests.',
      'The report has these fields:\n- FOR_USER_STATE: one of working or waiting\n- FOR_USER_NOW: what runs\n- Other fields are optional.',
      'Done.\nFOR_USER_ASK: pick one\n  A) keep\n\nAfter it.',
      'See:\r\n```\r\nFOR_USER_STATE: working\r\n```\r\nEnd.',
    ]) expect(stripInternalLines(text)).toBe(text)
  })

  it('the Brief block runs to the end, and Walnut\'s tag lines after it stay', () => {
    const text = `Done.\nFOR_USER_BRIEF\n- a\n\nMore prose.\n${NO_ACTION_TAG}`
    expect(stripInternalLines(text)).toBe(`Done.\n${NO_ACTION_TAG}`)
    expect(readTurnMarker(stripInternalLines(text))).toEqual({ text: 'Done.', noAction: true })
  })

  it('keeps what is not a line of the report: code, a mention in a sentence, a reply that is only the report', () => {
    const code = 'See:\n```\nFOR_USER_STATE: working\n```'
    expect(stripInternalLines(code)).toBe(code)
    const mention = 'The side question asks the FOR_USER_STATE line, not the reply.'
    expect(stripInternalLines(mention)).toBe(mention)
    // A session answering Walnut's own question: no chat shows that as a reply, and it is not cut to nothing.
    const answer = 'FOR_USER_STATE: working\nFOR_USER_NOW: tests'
    expect(stripInternalLines(answer)).toBe(answer)
    const plain = '普通的回复。\nFOR the record: fine.'
    expect(stripInternalLines(plain)).toBe(plain)
  })

  it('the turn-end marker right after the report still folds the turn', () => {
    const text = `Nothing for you.\nFOR_USER_STATE: working\n${NO_ACTION_TAG}`
    expect(readTurnMarker(stripInternalLines(text))).toEqual({ text: 'Nothing for you.', noAction: true })
    expect(stripTurnMarker(text)).toBe('Nothing for you.')
  })

  it('while a reply streams in, the start of a field name never flashes up', () => {
    expect(stripTurnMarker('Done.\n\nFOR_USER_ST', true)).toBe('Done.')
    expect(stripTurnMarker('Done.\n\nFOR_', true)).toBe('Done.')
    // Once written, a bare field name is a line of the report too; a stray "FOR_" is kept when not streaming.
    expect(stripTurnMarker('Done.\n\nFOR_', false)).toBe('Done.\n\nFOR_')
  })
})

// The rules as cases both clients run: the phone's port (ios-native/Walnut/Timeline/InternalLines.swift,
// WalnutTests/InternalLinesTests.swift) reads the same file, so the two never drift apart.
describe('the shared cases (tests/fixtures/internal-lines/cases.json)', () => {
  const cases: Array<{ label: string; text: string; streaming?: boolean; shown: string }> =
    JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/internal-lines/cases.json'), 'utf8'))
  it('has cases', () => expect(cases.length).toBeGreaterThan(20))
  it.each(cases.map((c) => [c.label, c] as const))('%s', (_label, c) => {
    expect(stripInternalLines(c.text, c.streaming ?? false)).toBe(c.shown)
  })
})

describe('no text Walnut gives a session tells it to write the report in a reply', () => {
  // The status side question and the summary ask the FOR_USER_ lines, and read them back: only
  // their files name the fields in text a session reads. Anything else says STATUS_REPORT_CHANNEL
  // (2026-11-20: task_send's and task_complete's answers and the walnut-trigger skill said
  // "FOR_USER_ASK at the end of your turn", and sessions wrote it at the end of their replies).
  const ASKS_THE_REPORT = new Set([
    'src/core/session-hooks/builtins.ts',
    'src/core/sessions/status-question.ts',
    // The status side question's per-thread lines (2026-11-20): it asks them and reads them back.
    'src/core/sessions/status-threads.ts',
    'src/core/ask-decision.ts',
    'src/core/same-ask-tree.ts',
    'src/core/sessions/user-asks-model.ts',
    // The ACP side question's frame: "do not write FOR_USER_ lines" there.
    'src/providers/acp-session.ts',
    'src/lib/internal-lines.ts',
  ])
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.(ts|md)$/.test(e.name) ? [p] : []
  })

  it('outside the side question, no string or skill names a FOR_USER_ field', () => {
    const offenders: string[] = []
    for (const file of files('src')) {
      const rel = file.split(path.sep).join('/')
      if (ASKS_THE_REPORT.has(rel)) continue
      const md = rel.endsWith('.md')
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!line.includes('FOR_USER_')) return
        if (md && !/FOR_USER_[A-Z]/.test(line)) return
        // A comment explains code to the people who read it; a session never reads it.
        if (!md && /^\s*(?:\/\/|\*|\/\*)/.test(line)) return
        // Any use of a field name in code (a string, a template's next line, a name built from it):
        // only the side question's files name the fields. An identifier that merely holds the
        // words (ASK_WITHDRAWN_FOR_USER_WORDS) is no field name.
        if (!md && !/(?<![A-Za-z0-9_])FOR_USER_[A-Z]/.test(line)) return
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

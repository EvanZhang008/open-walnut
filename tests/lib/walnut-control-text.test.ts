/**
 * Walnut's control markup never reaches a person as an agent's words (src/lib/walnut-control-text.ts;
 * 2026-11-14: an approval's reason read `<walnut-turn status="agent-ack"/>`). The cleaning lives in
 * one place: a new regex for these tags elsewhere in src/ is a second, partial copy and fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { hasWordsBeyondControl, withoutWalnutControl } from '../../src/lib/walnut-control-text.js'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

describe('withoutWalnutControl', () => {
  it('removes the turn marker, whole blocks, stray tags and reminders, and keeps the words', () => {
    expect(withoutWalnutControl('<walnut-turn status="agent-ack"/>').trim()).toBe('')
    expect(withoutWalnutControl('Done. <walnut-turn status="done"/>').trim()).toBe('Done.')
    expect(withoutWalnutControl('<walnut-message kind="peer-note" from="a">hello</walnut-message>Mine').trim()).toBe('Mine')
    expect(withoutWalnutControl('a <walnut-ask thread="t"> b').replace(/\s+/g, ' ')).toBe('a b')
    expect(withoutWalnutControl('<system-reminder>\nWalnut (x)\n</system-reminder>words').trim()).toBe('words')
    expect(withoutWalnutControl('plain <b>html</b> stays')).toBe('plain <b>html</b> stays')
    expect(hasWordsBeyondControl('<walnut-turn status="agent-ack"/>\n')).toBe(false)
    expect(hasWordsBeyondControl('ok <walnut-turn status="agent-ack"/>')).toBe(true)
  })
})

describe('one place cleans control markup out of agent text', () => {
  // Files that only DETECT a control tag (never strip it from words a person reads).
  const DETECTS_ONLY = new Set([
    'src/core/sessions/session-request-notify.ts', // ACK_LINE: tells an ack-only turn apart
    'src/core/org/message-about.ts', // reads from-task off a notice envelope
    'src/core/sessions/side-thread-digest.ts', // its own digest block, removed from its own prompt
    'src/core/org/thread-answers.ts', // LEADING_ENVELOPE_RE: the user's row, not agent prose
    'src/core/hints/hint-send.ts', // reads an ask's name
    'src/lib/history-session-envelope.ts', // parses envelopes
    'src/lib/ai-only-envelope.ts', // parses envelopes
  ])
  it('no other file strips the turn marker or Walnut tags with its own regex', () => {
    const offenders: string[] = []
    for (const f of walk('src')) {
      const rel = f.split(path.sep).join('/')
      if (rel === 'src/lib/walnut-control-text.ts' || DETECTS_ONLY.has(rel)) continue
      const src = fs.readFileSync(f, 'utf8')
      if (/\/<\\?\/?walnut-(?:turn|\[)/.test(src) || /\/<walnut-turn/.test(src)) offenders.push(rel)
    }
    expect(offenders, 'read agent text through withoutWalnutControl (src/lib/walnut-control-text.ts)').toEqual([])
  })
})

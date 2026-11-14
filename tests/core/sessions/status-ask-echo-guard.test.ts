/**
 * Guard for one class of cost bug (2026-11-09): Walnut asks an idle session a quiet side question
 * (its status, a summary, a title), the ask's own stream lines move the session record's
 * last_status_change, and a scheduler reading that as a new turn end asks again. The status
 * reconcile loop did this for days, and every ask on a cold prompt cache rewrote the whole
 * conversation (about $2.40 an ask, $700 a day).
 *
 * Every place that asks a session a side question is listed here with what keeps it from asking
 * for its own echo. A new caller fails until it is added with its reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

const ASKERS: Record<string, string> = {
  // askStatus
  'src/core/sessions/status-question.ts': 'asked from a turn end the runner reports (and a rerun of one), never from a record change',
  'src/core/sessions/status-reconcile.ts': 'statusMissed: an answer after the last main-loop request covers every status change since; the cap counts asks by that request',
  'src/core/sessions/task-watch.ts': 'a running turn, or statusMissed (the same rule), and a watch fires once per expiry',
  // requestTurnCompleteSelfReport / askSideQuestion
  'src/core/session-hooks/builtins.ts': 'turn-end summary and new-session title: driven by turn-end and launch events, not by a record change',
  'src/core/diff-summary.ts': 'asked through the sessions route when a person opens a diff summary',
  'src/providers/acp-session.ts': 'the ACP transport\'s own method (an ACP engine is never asked by the schedulers above)',
  // Same name, not a side question.
  'src/core/router/handoff-approval.ts': 'a local askStatus that reads an approval record, no model call',
  'src/core/sessions/session-extras.ts': 'a person\'s own side question (the session menu)',
  'src/providers/claude-code-session.ts': 'the transport itself',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('every side-question asker is listed with what keeps it from asking for its own echo', () => {
  it('finds no unlisted caller', () => {
    const callers = new Set<string>()
    for (const file of walk(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      if (/\b(askStatus|requestTurnCompleteSelfReport|askSideQuestion)\(/.test(text)) {
        callers.add(path.relative(ROOT, file))
      }
    }
    const unlisted = [...callers].filter((f) => !ASKERS[f])
    expect(unlisted, `New side-question callers: say in ASKERS why each never asks for its own ask's echo`).toEqual([])
  })

  it('lists no file that no longer asks', () => {
    for (const f of Object.keys(ASKERS)) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(/\b(askStatus|requestTurnCompleteSelfReport|askSideQuestion)\(/.test(text), f).toBe(true)
    }
  })
})

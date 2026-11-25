/**
 * Every place that frames a line for a session (sessions/send-frame.ts) frames words that are new
 * there: what this send composed, or what a person or agent wrote just now. A row another queue
 * framed already (the leader's queue row handed to the host that runs the session) goes through
 * frameQueuedRow, which keeps its envelopes and frames only loose words. Framing such a row whole
 * again wraps it in a second envelope and escapes the first into words (2026-11-24: ten rows of a
 * lead's session arrived as "Walnut (peer)" holding a subtask's reply as text, and a plugin job's
 * note as "Walnut (program run)").
 *
 * This list names each file that calls the framers, how many times, and what words it frames. A new
 * call fails until it is classified here: if it frames a stored or handed row, use frameQueuedRow.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const CALL = /\b(frameAsWalnut|frameForSource|frameStartText|frameStartData)\(/g

const KNOWN: Record<string, { count: number; frames: string }> = {
  'src/core/sessions/send-frame.ts': { count: 5, frames: 'the framers themselves: one framer handing words to another' },
  'src/core/session-message-queue.ts': { count: 2, frames: 'a send\'s body before Walnut\'s notes and hints are added to it, and a browser under automation\'s new text' },
  'src/core/sessions/session-send-core.ts': { count: 1, frames: 'a send to a session waiting on a permission: the text this send built' },
  'src/core/sessions/task-start.ts': { count: 3, frames: 'the first message of a start, and its reply trailer on its own' },
  'src/core/sessions/engine-switch.ts': { count: 3, frames: 'the message a person or agent gave the switch' },
  'src/core/sessions/engine-switch-context.ts': { count: 1, frames: 'the line the switch composes about the user\'s last message' },
  'src/core/sessions/folder-gone.ts': { count: 1, frames: 'the "Continue this task." line it composes' },
  'src/core/sessions/lane-turn.ts': { count: 1, frames: 'a side lane\'s first message' },
  'src/core/sessions/quick-start.ts': { count: 2, frames: 'a quick start\'s first message' },
  'src/core/sessions/usage-limit-wait.ts': { count: 1, frames: 'the continue line it composes' },
  'src/core/human-inbox/letter-ops.ts': { count: 1, frames: 'a letter answer\'s text' },
  'src/core/router/service.ts': { count: 1, frames: 'the routed message the router starts a task with' },
  'src/core/routines/clock-routine-start.ts': { count: 1, frames: 'a routine\'s prompt' },
  'src/core/routines/executors/claude-code.ts': { count: 1, frames: 'a routine\'s prompt' },
  'src/core/routines/offline-run.ts': { count: 1, frames: 'a routine\'s prompt' },
  'src/providers/claude-code-session.ts': { count: 2, frames: 'a start event\'s first message (the runner\'s net under every start)' },
  'src/replica/ask-launch.ts': { count: 1, frames: 'a start\'s first message' },
  'src/replica/away-starts.ts': { count: 5, frames: 'a start\'s first message, by who started it' },
  'src/web/routes/api-v1.ts': { count: 2, frames: 'a start\'s first message, and a forwarded copy of a message, quoted as words on purpose' },
  'src/core/session-channel/host-routes.ts': { count: 1, frames: 'a send to the host with no queued lines: words no queue framed yet' },
  'src/web/routes/session-launch-v1.ts': { count: 1, frames: 'a launch\'s first message' },
  'src/web/routes/sessions.ts': { count: 2, frames: 'the plan execution message and its typed instructions' },
}

function srcFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) out.push(...srcFiles(rel))
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** Calls, not the definitions (`export function frameX(`). */
function callsIn(text: string): number {
  return [...text.matchAll(CALL)].filter((m) => !/function\s+$/.test(text.slice(Math.max(0, m.index! - 16), m.index!))).length
}

describe('every framing of a line frames new words, never a row framed already', () => {
  it('the files that frame, and how often, are the known ones', () => {
    const found: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      const n = callsIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      if (n > 0) found[f] = n
    }
    expect(found, 'a new framing call: say what words it frames here; a stored or handed row goes through frameQueuedRow')
      .toEqual(Object.fromEntries(Object.entries(KNOWN).map(([f, k]) => [f, k.count])))
  })

  it('the host queues a leader\'s handed rows through frameQueuedRow', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/core/sessions/handed-holds.ts'), 'utf8')
    expect(text).toMatch(/frameQueuedRow\(l\.message, source\)/)
    expect(callsIn(text)).toBe(0)
  })
})

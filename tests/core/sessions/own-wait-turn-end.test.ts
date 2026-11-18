/**
 * Ratchet: every op or notice that tells a session to end its turn while something of its own runs
 * (a subagent, an approval, a reply, its own background job) says how: OWN_WAIT_TURN_END, words and
 * never the agent-ack line. 2026-11-18, the org reflection: sessions took a bare "end your turn" as
 * "answer with the ack line" and acked after real work, one with an hour-limited fix undone.
 *
 * A NEW "end your turn" literal in src/ fails here until it uses the constant or is listed below
 * with why it is not about such a wait.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OWN_WAIT_TURN_END } from '../../../src/lib/turn-end-marker.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
/** Files whose "end your/the turn" is not a wait on the session's own work. */
const NOT_A_WAIT: Record<string, string> = {
  'src/core/sessions/session-control-guard.ts': 'a session asked to stop itself: complete the task or end the turn',
  'src/core/sessions/user-asks-model.ts': 'an answer to the user, never an agent message',
  'src/core/task-wait-resume.ts': 'a phase to set before the turn ends',
  'src/core/sessions/brief-refresh.ts': 'a Brief reminder with no change: the ack line is the right answer there',
  'src/ops/task-lifecycle.ts': 'a session asked to stop itself (own_session), as session-control-guard.ts',
  'src/core/sessions/owed-to-user.ts': 'a close refused while the user\'s own items are open: the turn ends with them open',
  'src/core/org/org-autostart.ts': 'the first note to a new Main or lead: nobody waits on an answer once its Brief is written',
  'src/lib/turn-end-marker.ts': 'the constant itself',
  'src/core/sessions/session-context.ts': 'the prompt\'s background-job line; its ack paragraph says how (session-context.test.ts pins it)',
}
const PHRASE = /\b(?:end your turn|end the turn)\b/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Lines inside string literals (quotes or template) that name the phrase; comments are skipped. */
function literalHits(file: string): number[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const hits: number[] = []
  lines.forEach((line, i) => {
    const code = line.trimStart()
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
    if (line.includes('never the agent-ack line')) return // says it in place
    for (const m of line.matchAll(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"/g)) {
      if (PHRASE.test(m[0])) { hits.push(i + 1); return }
    }
  })
  return hits
}

describe('a turn that waits on its own work ends in words', () => {
  it('the constant says words, never the ack line', () => {
    expect(OWN_WAIT_TURN_END).toMatch(/^end your turn with one plain sentence on what you wait for, never the agent-ack line/)
  })

  it('every "end your turn" literal in src uses OWN_WAIT_TURN_END or is listed as no wait', () => {
    const offenders: string[] = []
    for (const abs of walk(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, abs)
      if (rel.startsWith('src/providers/daemon-')) continue // the daemon twins only describe CLI turns
      if (NOT_A_WAIT[rel]) continue
      for (const n of literalHits(abs)) offenders.push(`${rel}:${n}`)
    }
    expect(offenders).toEqual([])
  })

  it('the ops that send a session to wait carry it', async () => {
    const { getOp } = await import('../../../src/ops/index.js')
    for (const name of ['subagent_run', 'approval_request']) {
      const op = getOp(name) as { description?: string } | undefined
      expect(op?.description ?? '', name).toContain(OWN_WAIT_TURN_END)
    }
  })
})

/**
 * A live model change is no turn (2026-11-05, the user: "I switch and terminate
 * and then go, why it still continue"). Claude Code 2.1.284 answers an
 * apply_flag_settings model change with ONE stream line of its own,
 * `{"type":"user","message":{"content":"<local-command-stdout>Set model to …"}}`,
 * and no result after it. Both folds read a string `user` line as a turn start, so
 * the session read as working until its next turn, and an engine switch waited
 * for that turn forever. The CLI's local-command echo lines start no turn, in
 * both folds (daemon-fold.ts twin copy and session-reconcile.ts).
 */
import { describe, it, expect } from 'vitest'
import { foldLines, assembleSnapshot } from '../../src/providers/daemon-fold.js'
import { CLI_LOCAL_COMMAND_ECHO, foldSessionTail, isRealUserLine } from '../../src/core/session-reconcile.js'

const sid = '36e77f8a-9251-4e5d-adf0-b79a0dc128c3'
const line = (o: unknown) => JSON.stringify(o)
// The exact lines the CLI printed for: one turn, then a live model change (recorded 2026-11-05).
const turn = [
  line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'say hi in one word' }, session_id: sid }),
  line({ type: 'system', subtype: 'init', session_id: sid }),
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, session_id: sid }),
  line({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: sid }),
  line({ type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: sid }),
]
const echo = (tag: string) => line({
  type: 'user', message: { role: 'user', content: `${tag}Set model to \`global.anthropic.claude-sonnet-5-5[1m]\`${tag.replace('<', '</')}` },
  session_id: sid, parent_tool_use_id: null, uuid: 'f323ea4d-fe02-4f14-9bd8-90655888606e',
})

const daemonState = (lines: string[]) => assembleSnapshot({
  foldState: foldLines(lines.join('\n') + '\n'), pendingCtrl: null, dead: false, pid: 1234, exitCode: null,
}).cliState

describe('a CLI local-command echo is no turn start', () => {
  for (const tag of CLI_LOCAL_COMMAND_ECHO) {
    it(`${tag}: the daemon fold keeps the session idle`, () => {
      expect(daemonState([...turn, echo(tag)])).toBe('idle')
    })
    it(`${tag}: the server fold finds no new turn`, () => {
      const parsed = JSON.parse(echo(tag)) as Record<string, unknown>
      expect(isRealUserLine(parsed)).toBe(false)
      const fold = foldSessionTail([...turn, echo(tag)].join('\n') + '\n')
      // The turn's own result still ends the window: the echo opened no newer turn.
      expect(fold.lastResult).not.toBeNull()
      expect(fold.lastResult?.isError).toBe(false)
    })
  }

  it('an echo with leading whitespace is no turn start either (both folds)', () => {
    const padded = line({ type: 'user', message: { role: 'user', content: '\n  <local-command-stdout>Set model to sonnet</local-command-stdout>' }, session_id: sid })
    expect(isRealUserLine(JSON.parse(padded) as Record<string, unknown>)).toBe(false)
    expect(daemonState([...turn, padded])).toBe('idle')
  })

  it('a real typed message after the echo still starts a turn (both folds)', () => {
    const next = line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'recap' }, session_id: sid })
    expect(daemonState([...turn, echo('<local-command-stdout>'), next])).toBe('running')
    expect(isRealUserLine(JSON.parse(next) as Record<string, unknown>)).toBe(true)
  })

  it('a typed slash command (the CLI answers it with a result) still starts a turn', () => {
    const typed = line({ type: 'user', message: { role: 'user', content: '/model sonnet' }, session_id: sid })
    expect(isRealUserLine(JSON.parse(typed) as Record<string, unknown>)).toBe(true)
    expect(daemonState([...turn, typed])).toBe('running')
  })

  it('the daemon twin lists the same echo openings as session-reconcile.ts', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../../src/providers/daemon-fold.ts', import.meta.url), 'utf8')
    for (const tag of CLI_LOCAL_COMMAND_ECHO) expect(src, tag).toContain(`head.startsWith('${tag}')`)
  })
})

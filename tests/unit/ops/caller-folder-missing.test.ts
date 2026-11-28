/**
 * Every op that takes a caller's `cwd` answers a folder that is not there to the caller.
 *
 * Incident this pins (2026-11-28): a session on the Mac called subagent_run with a dev box's
 * folder and no `host`. Nothing checked the folder, so each run was started, died at the spawn's
 * folder check ("Working directory no longer exists"), and Walnut Health counted the deaths as
 * background session errors, raising its alarm. The caller had made the mistake and was the one
 * who could fix it; the person read an alarm instead.
 *
 * The class is every op whose input has `cwd`. Each one is listed below with how a missing folder
 * is answered: refused to the caller before anything starts (and the source file that refuses it),
 * made by the op, or not a start at all (the folder is only shown, or the op's own run reports it).
 * A new op that takes `cwd` fails here until it says which, so no new start can die in the
 * background on a caller's wrong folder.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listOps } from '../../../src/ops/index.js'

const ROOT = path.resolve(__dirname, '../../..')

type Answer =
  /** Refused to the caller before anything starts: `file` holds the check, `token` names it. */
  | { refused: { file: string; token: string } }
  /** The op makes the folder (or picks one) itself: `file` holds that step. */
  | { made: { file: string; token: string } }
  /** A new task's start is refused to the caller; an existing task's session keeps working through
   *  the folder-gone way ("Continue in a new folder"), which the person sees on that task. */
  | { refused: { file: string; token: string }; kept: { file: string; token: string } }
  /** No session or run starts in the folder: why. */
  | { notAStart: string }

const NEW_TASK_START = { refused: { file: 'src/core/sessions/quick-start.ts', token: 'missingStartFolder' } }
const TASK_START: Answer = {
  ...NEW_TASK_START,
  kept: { file: 'src/core/sessions/folder-gone.ts', token: 'export function continueInNewFolder' },
}

const ANSWERS: Record<string, Answer> = {
  subagent_run: { refused: { file: 'src/core/subagents/registry.ts', token: "'cwd_missing'" } },
  task_create: NEW_TASK_START,
  task_start: TASK_START,
  session_start: TASK_START,
  host_exec: { refused: { file: 'src/providers/host-start-core.ts', token: "'cwd_missing'" } },
  host_exec_pinned: { refused: { file: 'src/providers/host-start-core.ts', token: "'cwd_missing'" } },
  host_mcp_list: { refused: { file: 'src/providers/host-mcp-core.ts', token: "'cwd_missing'" } },
  host_mcp_tools: { refused: { file: 'src/providers/host-mcp-core.ts', token: "'cwd_missing'" } },
  host_mcp_call: { refused: { file: 'src/providers/host-mcp-core.ts', token: "'cwd_missing'" } },
  task_transfer: { made: { file: 'src/core/transfer/transfer.ts', token: 'ensureCwd' } },
  trigger_create: { notAStart: 'the folder of a check script the daemon runs; a failing check is the trigger\'s own error, shown on its card' },
  trigger_test: { notAStart: 'runs the check once and returns its output to the caller' },
  trigger_update: { notAStart: 'changes a check\'s folder; the check reports its own failures' },
  approval_request: { notAStart: 'the asking process\'s folder, only shown to the person' },
  password_use: { notAStart: 'the caller\'s folder, only shown to the person' },
  workspace_providers: { notAStart: 'reads which workspace kinds fit a folder; starts nothing' },
}

describe('an op that takes a caller\'s cwd', () => {
  const withCwd = listOps({ includeDeprecated: true }).filter((op) => op.input && 'cwd' in op.input).map((op) => op.name).sort()

  it('is listed here with how a missing folder is answered', () => {
    expect(withCwd.length).toBeGreaterThan(5)
    const unlisted = withCwd.filter((name) => !(name in ANSWERS))
    expect(unlisted, `ops that take cwd but say nothing of a missing folder: ${unlisted.join(', ')}. `
      + 'Refuse it to the caller before anything starts (as subagent_run does), and list the op in ANSWERS').toEqual([])
  })

  it('names a check that is really in its source', () => {
    for (const [name, answer] of Object.entries(ANSWERS)) {
      const checks = [
        'refused' in answer ? answer.refused : null,
        'made' in answer ? answer.made : null,
        'kept' in answer ? answer.kept : null,
      ].filter((c): c is { file: string; token: string } => c !== null)
      for (const where of checks) {
        const text = fs.readFileSync(path.join(ROOT, where.file), 'utf8')
        expect(text.includes(where.token), `${name}: ${where.file} no longer holds ${where.token}`).toBe(true)
      }
    }
  })

  it('lists no op that no longer takes cwd', () => {
    const gone = Object.keys(ANSWERS).filter((name) => !withCwd.includes(name))
    expect(gone, `listed but taking no cwd now: ${gone.join(', ')}`).toEqual([])
  })
})

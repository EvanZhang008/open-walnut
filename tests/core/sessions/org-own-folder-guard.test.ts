/**
 * A VP, lead or router node runs in its own task directory, decided by ONE rule
 * (src/core/sessions/org-own-folder.ts). 2026-11-12: the Walnut VP ran in the repository, its
 * project's default folder, and every request carried the repository's instruction files.
 *
 * Every session start writes the session's folder in one place, `createSessionRecord`. This test
 * enumerates those calls from the source and fails on a new one until it is listed here: either it
 * decides the folder through the rule, or why it is no start of a VP's or lead's own session. It
 * also pins that the rule sits where the start paths and the spawn go through.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** Each file that seeds a session record, how many calls, and how its folder is decided. */
const KNOWN: Record<string, { count: number; how: string }> = {
  'src/core/sessions/task-start.ts': { count: 1, how: 'task_start and every startSessionForTask caller: prepareLaunch -> resolveTaskLaunchReadOnly -> ownFolderStartCwd' },
  'src/core/sessions/quick-start.ts': { count: 1, how: 'a launch on an existing task with no conversation calls ownFolderStartCwd; a new task is no org node yet (Main starts as an ask)' },
  'src/providers/claude-code-session.ts': { count: 2, how: 'persists the folder the spawn ran in; a resume spawn moves a VP or lead first (moveToOwnFolderBeforeSpawn in send)' },
  'src/providers/acp-session.ts': { count: 1, how: 'persists the folder an ACP start was given by task_start (the rule above)' },
  'src/core/sessions/session-rewind.ts': { count: 1, how: 'a rewind continues the same conversation in its folder; its spawn moves a VP or lead' },
  'src/core/sessions/session-controls.ts': { count: 1, how: 'a fork keeps the source conversation\'s folder: the CLI reads the transcript it forks from there' },
  'src/core/sessions/side-thread-fork.ts': { count: 1, how: 'a side question has no task of its own' },
  'src/core/sessions/lane-fork.ts': { count: 1, how: 'a Personal AI lane fork (an ask, never a VP)' },
  'src/core/sessions/personal-ai-lane.ts': { count: 1, how: 'an ask lane in Walnut\'s data folder' },
  'src/core/sessions/cloud-chat-lane.ts': { count: 1, how: 'the companion\'s chat lane has no task' },
  'src/core/ai/ai-agent.ts': { count: 1, how: 'a one-shot agent call has no task' },
  'src/core/offline-merge/apply-session.ts': { count: 2, how: 'records a session that already ran on a host while the Mac was away; its next spawn moves a VP or lead' },
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(p)
    else if (/\.(ts|tsx)$/.test(entry.name)) yield p
  }
}
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
/** Code lines only: a comment naming a call is not one. */
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

/** The body of a top-level function, from its declaration to the next top-level declaration. */
function body(text: string, decl: RegExp): string {
  const m = decl.exec(text)
  if (!m) throw new Error(`not found: ${decl}`)
  const rest = text.slice(m.index)
  const end = rest.slice(1).search(/\n(?:export |async function |function |const |let |class )/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

describe('every session start decides a VP\'s or lead\'s folder through the one rule', () => {
  it('the source seeds session records in exactly the known places', () => {
    const found: Record<string, number> = {}
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      if (rel === 'src/core/session-tracker.ts') continue // the definition
      const n = (code(fs.readFileSync(file, 'utf8')).match(/\bcreateSessionRecord\(/g) ?? []).length
      if (n) found[rel] = n
    }
    const known = Object.fromEntries(Object.entries(KNOWN).map(([k, v]) => [k, v.count]))
    expect(found, 'a new createSessionRecord call: decide its folder with ownFolderStartCwd (org-own-folder.ts), or list it here with why it is no VP\'s or lead\'s start').toEqual(known)
  })

  it('task_start\'s plan applies the rule, and every startSessionForTask goes through the plan', () => {
    expect(body(read('src/core/sessions/task-launch-plan.ts'), /export async function resolveTaskLaunchReadOnly/)).toMatch(/ownFolderStartCwd\(/)
    const start = read('src/core/sessions/task-start.ts')
    expect(body(start, /async function prepareLaunch/)).toMatch(/resolveTaskLaunchReadOnly\(task, params\)/)
    expect(body(start, /async function startSessionForTaskNow/)).toMatch(/prepareLaunch\(task,/)
  })

  it('a launch on an existing task applies the rule', () => {
    expect(body(read('src/core/sessions/quick-start.ts'), /export async function quickStartSession/)).toMatch(/ownFolderStartCwd\(/)
  })

  it('the spawn itself moves a resumed VP or lead first, so Restart, a cold resume and the prompt respawn all do', () => {
    const runner = read('src/providers/claude-code-session.ts')
    const spawn = runner.slice(runner.indexOf('const startSpawn = async'), runner.indexOf('const spawnPromise = startSpawn()'))
    expect(spawn).toMatch(/moveToOwnFolderBeforeSpawn\(/)
    // Who holds the transcript is asked on the link this start goes through, not some pooled one.
    expect(spawn).toMatch(/cliHolder: t\.cliHolder/)
    // After every check that may refuse the start (stop fence, cwd, cost state, ACP), right
    // before the daemon is asked to start it, so a refusal there costs no move.
    expect(spawn.indexOf('moveToOwnFolderBeforeSpawn(')).toBeGreaterThan(spawn.indexOf("stepDone('costStateMs')"))
    expect(spawn.indexOf('moveToOwnFolderBeforeSpawn(')).toBeLessThan(spawn.indexOf('transport.start('))
    // A start the daemon then refuses puts the conversation back, only on a failure that proves
    // nothing started (a start that went out and failed late may have a CLI writing there).
    const after = runner.slice(runner.indexOf('const spawnPromise = startSpawn()'), runner.indexOf('const spawnPromise = startSpawn()') + 1200)
    expect(after).toMatch(/if \(undo && startProvedNothingStarted\(err, startSent\)\)/)
    expect(spawn.indexOf('startSent = true')).toBeLessThan(spawn.indexOf('transport.start('))
    expect(spawn.indexOf('startSent = true')).toBeGreaterThan(spawn.indexOf('moveToOwnFolderBeforeSpawn('))
  })

  it('a node\'s workers inherit the folder it was moved from, never its own directory', () => {
    expect(body(read('src/core/sessions/caller-placement.ts'), /export async function resolveCallerPlacement/)).toMatch(/handedDownCwd\(record\)/)
  })

  /** Server code that queues a task_start op itself: the op marks a folder it names as chosen (cwd_chosen). */
  const QUEUES_START: Record<string, string> = {
    'src/core/human-inbox/item-plans.ts': 'an inbox action names the previewed folder only for a task that is no VP or lead (runsInOwnFolder)',
  }

  it('a plan that fills a folder in never passes it off as a person\'s choice for a VP or lead', () => {
    const found: string[] = []
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      if (rel.startsWith('src/ops/')) continue // the op itself (task-execution.ts startTask)
      if (/tool: ['"]task_start['"]/.test(code(fs.readFileSync(file, 'utf8')))) found.push(rel)
    }
    expect(found.sort(), 'a new server-side task_start op: name a folder only when a person picked it, or skip it for an org node (runsInOwnFolder)').toEqual(Object.keys(QUEUES_START).sort())
    expect(read('src/core/human-inbox/item-plans.ts')).toMatch(/!!launchCwd && !runsInOwnFolder\(launchTask\)/)
    // The op says a named folder was chosen, so its callers above must not name a filled-in one.
    expect(body(read('src/ops/task-execution.ts'), /export async function startTask/)).toMatch(/cwd_chosen: true/)
  })

  /** Files that name an org role and a folder together, and why that is no folder decision of their own. */
  const NAMES_BOTH: Record<string, string> = {
    'src/core/routines/executors/session.ts': 'a trigger aimed at a VP with no session starts one with the task\'s or the check\'s folder, through quickStartSession\'s existing-task branch (run-start-deps.ts), which applies the rule',
  }

  it('no other module decides on its own that an org node runs somewhere', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      if (rel === 'src/core/sessions/org-own-folder.ts' || NAMES_BOTH[rel]) continue
      const text = code(fs.readFileSync(file, 'utf8'))
      // A cwd decided from the org role, without the rule (e.g. `task.org_role === 'lead' ? ... cwd`).
      if (/org_role[^\n]{0,80}\bcwd\b|\bcwd\b[^\n]{0,80}org_role/.test(text) && !/org-own-folder\.js/.test(text)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})

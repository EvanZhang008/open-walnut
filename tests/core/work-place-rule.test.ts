/**
 * Where work lives (src/core/work-place.ts, src/lib/task-dir.ts): the rule and
 * the program behind it reach every place a session learns or meets them.
 *
 * Why (2026-10-25): a restart emptied /tmp, and with it several tasks' clones,
 * one task's only copy of an unmerged commit, and kept evidence. Each pin below
 * is one way that could come back: a role that never hears the rule, a session
 * spawned before it with no way to read it, a twin that stops handing out the
 * directory, a spawn path that drops the guard, an ephemeral or test server
 * writing into the real directories, or a personal path in the public text.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-work-place'))

import { WORK_PLACE_RULE, taskDirLine } from '../../src/core/work-place.js'
import { buildSessionContext } from '../../src/core/sessions/session-context.js'
import { renderSelfKnowledgeContract } from '../../src/core/self-knowledge-contract.js'
import { buildRoleSection } from '../../src/core/sessions/persona-sections.js'
import { getOp } from '../../src/ops/index.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'
import { ephemeralChildEnv } from '../../src/commands/ephemeral-snapshot.js'
import { localTaskDirRoot } from '../../src/core/sessions/task-dir-place.js'
import type { Task } from '../../src/core/types.js'

const REPO = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf-8')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

function task(over: Partial<Task>): Task {
  return { id: 'mt-place-1', title: 'Fix the flaky auth test', project: 'marina', phase: 'IN_PROGRESS', ...over } as Task
}

describe('the rule itself', () => {
  it('says what goes where, and that Walnut enforces and cleans it', () => {
    for (const re of [
      /Temp directories \(\/tmp and the OS temp dir\) are emptied at every reboot and swept by cleaners/,
      /Only what you can lose goes there: screenshots, one-off scratch output, builds you can rebuild/,
      /your task directory, `\$WALNUT_TASK_DIR`: drafts, plans and notes, temporary clones and worktrees, unmerged commits, candidate builds, evidence and reports/,
      /remove what you no longer need when you finish/,
      /keeps it across reboots, and removes it \d+ days after the task completes, never while a repo in it holds changes or commits that exist nowhere else/,
      /Walnut refuses a git clone, git worktree add or git commit in a temp directory, and flags a draft, plan or note saved there with Write/,
      /`walnut tools call task_dir` makes it and prints its path/,
      /Clone from a local checkout with `git clone --shared` \(or add a worktree\) instead of a full copy/,
      /keep one build output per repo \(one `-derivedDataPath`, one `dist`\) and reuse it/,
      /delete DerivedData, `dist`, `node_modules`, `\.xcresult` bundles and downloaded installers as soon as their result is recorded/,
    ]) expect(WORK_PLACE_RULE).toMatch(re)
  })

  it('is plain ASCII English with no dash punctuation and no personal path', () => {
    for (const text of [WORK_PLACE_RULE, taskDirLine('/x/y'), taskDirLine(null)]) {
      expect(text).not.toMatch(/[–—]/)
      expect(text).not.toMatch(/ - /)
      expect(text).toMatch(/^[\x20-\x7e\n]+$/)
      expect(text).not.toMatch(/\/Users\/|\/home\/[a-z]/)
    }
  })
})

describe('every role hears it at spawn (buildSessionContext)', () => {
  const cases: Array<[string, Task]> = [
    ['worker', task({})],
    ['subtask of a leader', task({ parent_task_id: 'mt-place-0' })],
    ['ask', task({ project: 'Ask Walnut', walnut_agent: true } as Partial<Task>)],
    ['project lead', task({ org_role: 'lead' } as Partial<Task>)],
    ['main agent', task({ org_role: 'main', project: 'Ask Walnut', walnut_agent: true } as Partial<Task>)],
  ]
  for (const [label, t] of cases) {
    it(`a ${label} gets the rule once and its own directory on the local host`, async () => {
      const { systemPrompt } = await buildSessionContext(t.id, '/x', undefined, { task: t })
      expect(count(systemPrompt, WORK_PLACE_RULE)).toBe(1)
      expect(systemPrompt).toContain(`Your task directory on this host is ${path.join(localTaskDirRoot(), t.id)}`)
    })
  }

  it('a remote host that has not told its root is named by the variable alone', async () => {
    const { systemPrompt } = await buildSessionContext('mt-place-1', '/x', 'some-remote', { task: task({}) })
    expect(systemPrompt).toContain(taskDirLine(null))
    expect(count(systemPrompt, WORK_PLACE_RULE)).toBe(1)
  })

  it('a session with no task still gets the rule', async () => {
    const { systemPrompt } = await buildSessionContext('', '/x')
    expect(count(systemPrompt, WORK_PLACE_RULE)).toBe(1)
    expect(systemPrompt).not.toContain('Your task directory')
  })
})

describe('the Personal AI and console agents (operating contract)', () => {
  it('carries the rule once', () => {
    expect(count(renderSelfKnowledgeContract(), WORK_PLACE_RULE)).toBe(1)
    expect(count(buildRoleSection('Ada'), WORK_PLACE_RULE)).toBe(1)
  })
})

describe('a session spawned before the change (live op help)', () => {
  it('task_dir exists, makes the directory, and its help carries the whole rule', () => {
    const op = getOp('task_dir')
    expect(op).toBeTruthy()
    expect(op!.bind).toEqual({ method: 'GET', path: '/me/task-dir' })
    expect(op!.description).toContain(WORK_PLACE_RULE.replace(/^## Where work lives\n\n/, ''))
  })
})

describe('shipped skills', () => {
  it('the walnut skill has the section, and no skill sends evidence to /tmp', () => {
    const skill = read('src/data/skills/walnut/SKILL.md')
    expect(skill).toContain('## Where your work lives')
    expect(skill).toContain('`$WALNUT_TASK_DIR`')
    expect(skill).toMatch(/`git clone`, `git worktree add` or `git commit` in a temp directory is refused/)
    expect(skill).toMatch(/drafts, plans and notes you write/)
    expect(skill).toMatch(/A draft, plan, note or evidence\s+file you write into a temp directory with the Write tool is kept, with a note/)
    for (const name of fs.readdirSync(path.join(REPO, 'src/data/skills'))) {
      const file = path.join(REPO, 'src/data/skills', name, 'SKILL.md')
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf-8')
      expect(text, name).not.toMatch(/(Logs|Evidence|Report|evidence|report)s?: \/tmp\//)
      expect(text, name).not.toMatch(/git (clone|worktree add)[^\n`]*\/tmp\//)
    }
  })
})

describe('the program side', () => {
  it('every Claude Code spawn path gets the /tmp git guard and the /tmp write note next to the compact hook', () => {
    const hooks = sessionSettingsHooks({}) as Record<string, Array<{ matcher: string }>>
    expect(hooks.PreToolUse[0].matcher).toBe('Bash')
    expect(hooks.PostToolUse[0].matcher).toBe('Write')
    expect(hooks.SessionStart[0].matcher).toBe('compact')
    for (const file of ['src/providers/claude-code-session.ts', 'src/providers/spawn-template.ts']) {
      expect(read(file), file).toMatch(/sessionSettingsHooks\(/)
      expect(read(file), file).not.toMatch(/compactOpenItemsHooks\(/)
    }
  })

  it('both daemon twins hand out the directory at spawn, scrub an inherited one, and report their root', () => {
    const standalone = read('src/providers/daemon-standalone.ts')
    const source = read('src/providers/daemon-source.ts')
    expect(standalone).toMatch(/WALNUT_TASK_DIR: taskDir \?\? undefined,/)
    expect(source).toMatch(/WALNUT_TASK_DIR: taskDir \|\| undefined,/)
    for (const twin of [standalone, source]) {
      expect(twin).toMatch(/taskDirRoot: TASK_DIR_ROOT/)
      for (const cmd of ['taskdir.ensure', 'taskdir.list', 'taskdir.remove']) expect(twin).toContain(`case '${cmd}'`)
      // The ACP spawn (Codex and other ACP engines) gets it too.
      expect(twin).toMatch(/cmdAcpStart[\s\S]{0,2500}WALNUT_TASK_DIR/)
    }
    // The cloud bridge may never delete host files.
    const bridgeList = standalone.match(/const BRIDGE_ALLOWED_COMMANDS = new Set\(\[[\s\S]*?\n\]\)/)?.[0] ?? ''
    expect(bridgeList).toContain("'status'")
    expect(bridgeList).not.toContain('taskdir.')
  })

  it('the sidecar ships, is hashed into the daemon version, and gates the capability', () => {
    expect(read('scripts/build-daemon.sh')).toMatch(/--outfile "\$OUTDIR\/task-dir-core.cjs"/)
    for (const f of ['src/providers/daemon-connection.ts', 'src/providers/local-daemon.ts']) expect(read(f)).toContain("'task-dir-core.cjs'")
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/task-dir-core.ts'")
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/lib/task-dir.ts'")
    expect(read('src/providers/daemon-source.ts')).toMatch(/SIDECAR_GATED_CAPABILITIES = new Set\(\[[^\]]*'task-dir-v1'/)
    expect(read('src/providers/daemon-capabilities.ts')).toMatch(/^\s+'task-dir-v1',$/m)
  })

  it('an ephemeral server keeps task directories inside its own runtime dir and drops the parent session\'s', () => {
    const env = ephemeralChildEnv({ WALNUT_TASK_DIR: '/real/tasks/mine', HOME: '/h' }, '/eph/data', '/eph/run')
    expect(env.WALNUT_TASK_DIR).toBeUndefined()
    expect(env.WALNUT_TASK_DIR_ROOT).toBe(path.join('/eph/run', 'task-dirs'))
  })

  it('tests never write into the real task directories', () => {
    expect(process.env.WALNUT_TASK_DIR_ROOT).toBeTruthy()
    expect(process.env.WALNUT_TASK_DIR).toBeUndefined()
    expect(localTaskDirRoot()).toBe(path.resolve(process.env.WALNUT_TASK_DIR_ROOT!))
  })
})

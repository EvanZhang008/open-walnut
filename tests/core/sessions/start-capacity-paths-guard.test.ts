import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'

// Every new start caller must name how it handles automatic capacity waits or why it is a person's start.
const CALLERS: Record<string, string> = {
  'commands/direct-commands.ts': 'A person runs this CLI command.',
  'core/health-monitor/fix-task.ts': 'An approved repair starts as the person requested.',
  'core/sessions/mobile-launch.ts': 'A person launches from the phone.',
  'core/router/service.ts': 'Router conversation setup retains its own workspace constraints.',
  'core/router/wake.ts': 'Router work resumes its durable target conversation.',
  'web/routes/task-v1.ts': 'Person or caller-attributed task start uses the common task gate.',
  'web/routes/sessions.ts': 'A person launches from the web.',
  'core/sessions/engine-switch.ts': 'An engine switch is an own move, not a new automatic task.',
  'web/routes/notifications.ts': 'The person approved starting a fix.',
  'core/sessions/task-start.ts': 'Automatic unpinned starts persist through waitForHostSlot; explicit agent constraints fail.',
  'core/routines/run-start-deps.ts': 'Routine and isolated-trigger runs persist the original launch in start_queue.',
  'core/routines/run-placement.ts': 'Every routine tries capability-safe fallback through the shared admission lock.',
  'core/transfer/transfer.ts': 'A transfer is an own move and keeps its host/files constraints.',
  'core/sessions/start-queue.ts': 'The persisted task or routine start replays; full waits remain queued.',
  'web/routes/triage-rules-v1.ts': 'Routing sends into the named durable target task.',
  'core/org/org-autostart.ts': 'Org task starts and Main ask starts both use the shared capacity queue.',
  'web/routes/quick-input-v1.ts': 'A person or attributed caller uses the common task gate.',
  'core/workspaces/manager.ts': 'Workspace setup retains explicit provider and folder constraints.',
  'providers/subagent-runner.ts': 'The configured console agent uses its own ask conversation.',
}

function startCallers(): string[] {
  const found: string[] = []
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true)
        let calls = false
        function visit(node: ts.Node): void {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && ['admitHostStart', 'quickStartSession', 'startSessionForTask'].includes(node.expression.text)) calls = true
          ts.forEachChild(node, visit)
        }
        visit(source)
        if (calls) found.push(path.relative('src', full).split(path.sep).join('/'))
      }
    }
  }
  walk('src')
  return found.sort()
}

describe('automatic start entry points keep accepted work through a full host', () => {
  it('enumerates real calls, including any new entry point, rather than comments or a fixed case list', () => {
    expect(startCallers()).toEqual(Object.keys(CALLERS).sort())
    expect(Object.values(CALLERS).every(why => why.length > 30)).toBe(true)
  })

  it('routine priority is enforced at the shared admission gate, not only by a queue sort', () => {
    const admission = fs.readFileSync('src/core/sessions/host-admission.ts', 'utf8')
    const queue = fs.readFileSync('src/core/sessions/start-queue.ts', 'utf8')
    // These mandatory branches cover future automatic callers that do not opt in to FIFO.
    expect(admission).toContain('opts.respectWaiting || !opts.routine')
    expect(admission).toContain('opts.routine ? isQueuedRoutine(t)')
    expect(admission).toContain('routineQueueEnabled(t, switches)')
    expect(queue).toContain('Number(!isQueuedRoutine(a)) - Number(!isQueuedRoutine(b))')
    expect(queue).toContain("t.start_queue.routine.source !== 'org-autostart'")
  })

  it('the admission callers preserve a full-host replay instead of consuming the request', () => {
    const task = fs.readFileSync('src/core/sessions/task-start.ts', 'utf8')
    const routine = fs.readFileSync('src/core/routines/run-start-deps.ts', 'utf8')
    const queue = fs.readFileSync('src/core/sessions/start-queue.ts', 'utf8')
    expect(task).toContain('return waitForHostSlot(params, d)')
    expect(task).toContain('params.queuedAt && waitingTask.start_queue?.wait_for_slot')
    expect(routine).toContain('routine: launch')
    expect(routine).toContain('return { task: waiting, queued: true }')
    expect(routine).not.toMatch(/waitMs:\s*ROUTINE_WAIT_MS/)
    expect(queue).toContain('entry.wait_for_slot && err instanceof HostsFullError')
    expect(queue).toContain("out.held.push(t.id); continue;")
    for (const executor of ['session', 'watcher']) {
      const text = fs.readFileSync(`src/core/routines/executors/${executor}.ts`, 'utf8')
      expect(text).toContain('defaultRunStartDeps().launch(')
      expect(text).not.toContain('quickStartSession({')
      expect(text).toContain('queued')
    }
  })
})

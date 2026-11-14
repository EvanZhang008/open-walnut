/**
 * Router area launch guard: a router's session spawns only with its isolated profile, and a
 * cold resume never drops that profile. Since 2026-11-14 only a router runs isolated: the work
 * it hands items to is ordinary, whatever an older build marked on it.
 *
 * What is pinned:
 *   1. send() of a valid area profile builds the argv the policy promises: no built-in
 *      tools (`--tools ''`), no settings sources, strict MCP with exactly the walnut
 *      server, the router's two ops, a replaced system prompt, no session hooks,
 *      and the Claude Code memory / CLAUDE.md loading turned off through settings env.
 *   2. send() refuses, synchronously and before any transport exists, a wrong or old
 *      policy version, extra tools, extra MCP servers, a non-slim or appended prompt,
 *      a fork, a session with no task, a remote host, and a respawn of a scoped
 *      session that lost its profile.
 *   3. The env added for an area session never leaks into the shared user-settings
 *      env cache, so a later unscoped slim session does not inherit it.
 *   4. resolveResumeArgs fails closed: a missing record, an unreadable area file for a
 *      marked task, a dropped profile or an old policy version all reject; an ordinary
 *      task with an unreadable area file still resumes.
 *
 * ZERO real side effects: createSessionManager returns a fake transport whose every
 * method is a stub (start captures the argv and never resolves), so no daemon, CLI,
 * socket or network is touched and no process is signalled. The cwd check, task-dir
 * restore, user settings, session records, tasks and the area file are all faked.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { SessionProfile } from '../../src/core/types.js'
import type { RouterAreasFile } from '../../src/core/router/areas.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-router-area-launch'))

const h = vi.hoisted(() => {
  const starts: Array<{ args: string[]; [k: string]: unknown }> = []
  const transportCalls: string[] = []
  /** One shared object, as the real readUserSettingsEnv returns its cache. */
  const sharedUserEnv: Record<string, string> = { ANTHROPIC_MODEL: 'test-model' }
  const records = new Map<string, Record<string, unknown>>()
  const tasks = new Map<string, Record<string, unknown>>()
  const areas = { value: null as unknown, error: null as Error | null }
  const daemon = { mcp: true }
  return { starts, transportCalls, sharedUserEnv, records, tasks, areas, daemon }
})

/** A transport whose every member is a stub; start() records the argv and never settles. */
function fakeTransport(): unknown {
  const stubs = new Map<PropertyKey, unknown>()
  const target = {
    start: vi.fn((opts: { args: string[] }) => {
      h.starts.push({ ...opts, args: [...opts.args] })
      return new Promise(() => {})
    }),
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return (t as Record<PropertyKey, unknown>)[prop]
      // Never a thenable, never a symbol-keyed protocol.
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      if (!stubs.has(prop)) {
        stubs.set(prop, vi.fn(() => {
          h.transportCalls.push(String(prop))
          return undefined
        }))
      }
      return stubs.get(prop)
    },
  })
}

const { createSessionManagerMock } = vi.hoisted(() => ({ createSessionManagerMock: vi.fn() }))

vi.mock('../../src/providers/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSessionManager: createSessionManagerMock,
  registerSessionManager: vi.fn(),
  unregisterSessionManager: vi.fn(),
}))
vi.mock('../../src/providers/cwd-check.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkCwdExists: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../src/core/sessions/task-dir-place.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  restoreOwnTaskDir: vi.fn(async () => false),
}))
vi.mock('../../src/providers/inline-subagent.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readUserSettingsEnv: () => h.sharedUserEnv,
  slimChildSettingsArg: () => undefined,
}))
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSessionByClaudeId: vi.fn(async (sid: string) => h.records.get(sid)),
  updateSessionRecord: vi.fn(async () => undefined),
}))
vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTask: vi.fn(async (id: string) => {
    const task = h.tasks.get(id)
    // The store's own words for a task that is not there (task-manager.ts).
    if (!task) throw new Error(`No task found matching ID prefix "${id}"`)
    return task
  }),
}))
vi.mock('../../src/core/router/areas.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRouterAreas: vi.fn(async () => {
    if (h.areas.error) throw h.areas.error
    return h.areas.value
  }),
}))

vi.mock('../../src/core/hosts/link.js', () => ({ link: vi.fn(async () => ({ hasCapability: (cap: string) => cap === 'walnut-mcp-v1' && h.daemon.mcp })) }))

import { ClaudeCodeSession, sessionRunner } from '../../src/providers/claude-code-session.js'
import { routerAreaProfile } from '../../src/core/router/session-policy.js'
import { hostWalnutMcpServer } from '../../src/core/sessions/walnut-mcp-mount.js'
import { WALNUT_HOME } from '../../src/constants.js'

const MOCK_CLI = '/nonexistent/claude-never-run'
const AREA_ID = 'personal'

const AREAS: RouterAreasFile = {
  version: 1,
  areas: [{ id: AREA_ID, name: 'Personal', host: '__local__', taskIds: ['t-legacy', 't-router'], sources: [] }],
  routers: [{ taskId: 't-router', areaId: AREA_ID, paused: false }],
  items: [],
}

createSessionManagerMock.mockImplementation(() => fakeTransport())

async function waitUntil(pred: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`)
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

interface SendInput {
  taskId?: string
  profile?: SessionProfile
  appendSystemPrompt?: string
  host?: string
  resumeId?: string
  fork?: boolean
}

function callSend(session: ClaudeCodeSession, input: SendInput): void {
  session.send(
    'hello', WALNUT_HOME, input.resumeId, 'dontAsk', undefined, input.appendSystemPrompt,
    input.host, undefined, input.fork, undefined, undefined, undefined, undefined, undefined,
    { ...(input.profile ? { profile: input.profile } : {}), stopFence: null },
  )
}

/** Spawn through the fake transport and return the argv handed to it. */
async function spawnArgs(input: SendInput): Promise<string[]> {
  const before = h.starts.length
  const session = new ClaudeCodeSession(input.taskId ?? 't-router', 'proj', MOCK_CLI)
  callSend(session, input)
  await waitUntil(() => h.starts.length > before, 5000, 'transport.start')
  return h.starts.at(-1)!.args
}

/** The send is refused synchronously and no transport is ever made. */
function expectRefused(input: SendInput, session?: ClaudeCodeSession): void {
  const made = createSessionManagerMock.mock.calls.length
  const starts = h.starts.length
  const target = session ?? new ClaudeCodeSession(input.taskId ?? 't-router', 'proj', MOCK_CLI)
  expect(() => callSend(target, input)).toThrow()
  expect(createSessionManagerMock.mock.calls.length).toBe(made)
  expect(h.starts.length).toBe(starts)
}

function settingsOf(args: string[]): Record<string, unknown> {
  const raw = flagValue(args, '--settings')
  expect(raw, '--settings must be present').toBeTruthy()
  return JSON.parse(raw!) as Record<string, unknown>
}

beforeEach(() => {
  h.starts.length = 0
  h.transportCalls.length = 0
  h.records.clear()
  h.tasks.clear()
  h.areas.value = structuredClone(AREAS)
  h.areas.error = null
  h.daemon.mcp = true
  for (const key of Object.keys(h.sharedUserEnv)) delete h.sharedUserEnv[key]
  h.sharedUserEnv.ANTHROPIC_MODEL = 'test-model'
  createSessionManagerMock.mockClear()
})

describe('area session spawn argv', () => {
  it('a router session gets no built-ins, strict walnut-only MCP, its two ops and memory off', async () => {
    const args = await spawnArgs({ taskId: 't-router', profile: routerAreaProfile(AREA_ID) })

    expect(args).toContain('--tools')
    expect(flagValue(args, '--tools')).toBe('')
    expect(args).toContain('--setting-sources')
    expect(flagValue(args, '--setting-sources')).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--disable-slash-commands')
    expect(JSON.parse(flagValue(args, '--mcp-config')!)).toEqual({ mcpServers: { walnut: hostWalnutMcpServer() } })
    expect(flagValue(args, '--allowedTools')).toBe('mcp__walnut__router_context,mcp__walnut__router_route')
    expect(flagValue(args, '--system-prompt')).toBe(routerAreaProfile(AREA_ID).systemPrompt)
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--fork-session')

    const settings = settingsOf(args)
    const env = settings.env as Record<string, string>
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1')
    // A slim session carries none of Walnut's session hooks.
    expect(settings.hooks).toBeUndefined()
    // No signalling or other transport member was used on the way to start().
    expect(h.transportCalls.filter((m) => /stop|kill|terminate|signal/i.test(m))).toEqual([])
  })
})

describe('area session spawn refusals (no transport is made)', () => {
  const good = (): SessionProfile => routerAreaProfile(AREA_ID)

  it('refuses a profile with no policy version (an older Walnut wrote it)', () => {
    const { areaPolicyVersion: _dropped, ...old } = good()
    expectRefused({ profile: old as SessionProfile })
  })

  it('refuses an unknown policy version', () => {
    expectRefused({ profile: { ...good(), areaPolicyVersion: 2 } })
  })

  it('refuses the full built-in toolbelt (tools unset) and any named built-in', () => {
    const { tools: _t, ...noTools } = good()
    expectRefused({ profile: noTools as SessionProfile })
    expectRefused({ profile: { ...good(), tools: ['Bash'] } })
  })

  it('refuses extra allowed tools and the deleted receiver ops', () => {
    expectRefused({ profile: { ...good(), allowedTools: [...good().allowedTools!, 'Bash'] } })
    expectRefused({ profile: { ...good(), allowedTools: ['mcp__walnut__router_item', 'mcp__walnut__router_work'] } })
  })

  it('refuses an extra or replaced MCP server', () => {
    expectRefused({ profile: { ...good(), mcpServers: { ...good().mcpServers, other: { command: '/bin/true', args: [] } } } })
    expectRefused({ profile: { ...good(), mcpServers: { walnut: { command: '/bin/sh', args: ['-c', 'exec other-mcp'] } } } })
  })

  it('refuses a non-slim profile and an appended system prompt', () => {
    expectRefused({ profile: { ...good(), slim: false } })
    expectRefused({ profile: { ...good(), systemPromptMode: 'append' } })
    expectRefused({ profile: good(), appendSystemPrompt: 'global session context' })
  })

  it('refuses a fork of an area session', () => {
    expectRefused({ profile: good(), resumeId: '00000000-0000-4000-8000-000000000001', fork: true })
  })

  it('refuses an area profile on a session with no task (a side-thread fork carries taskId "")', () => {
    expectRefused({ taskId: '', profile: good() })
  })

  it('refuses a remote host', () => {
    expectRefused({ profile: good(), host: 'remote-box' })
  })

  it('refuses a respawn of a scoped session that lost its profile', async () => {
    const session = new ClaudeCodeSession('t-router', 'proj', MOCK_CLI)
    callSend(session, { profile: good() })
    await waitUntil(() => h.starts.length === 1, 5000, 'first spawn')
    expectRefused({ taskId: 't-router' }, session)
  })
})

describe('user settings env cache', () => {
  it('an area session never writes its memory switches into the shared env cache', async () => {
    await spawnArgs({ taskId: 't-router', profile: routerAreaProfile(AREA_ID) })
    expect(h.sharedUserEnv).toEqual({ ANTHROPIC_MODEL: 'test-model' })

    // A later unscoped slim session reads the same cache and must not inherit them.
    const args = await spawnArgs({
      taskId: 't-plain',
      profile: { slim: true, systemPrompt: 'tiny', systemPromptMode: 'replace', tools: [''] },
    })
    const env = settingsOf(args).env as Record<string, string>
    expect(env.ANTHROPIC_MODEL).toBe('test-model')
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined()
  })
})

describe('shared direct and event launch guard', () => {
  const runner = sessionRunner as unknown as {
    assertStartRouting(data: Record<string, unknown>): Promise<void>
  };
  it('rejects a router task from the quick launcher without an isolated profile', async () => {
    h.tasks.set('t-router', { id: 't-router', source: 'local', router_area_id: AREA_ID, org_role: 'router' });
    await expect(runner.assertStartRouting({ taskId: 't-router', mode: 'bypassPermissions' })).rejects.toThrow();
    expect(createSessionManagerMock).not.toHaveBeenCalled();
  });
  it('accepts the same isolated profile through the shared start gate', async () => {
    h.tasks.set('t-router', { id: 't-router', source: 'local', router_area_id: AREA_ID, org_role: 'router' });
    await expect(runner.assertStartRouting({ taskId: 't-router', mode: 'dontAsk', profile: routerAreaProfile(AREA_ID) })).resolves.toBeUndefined();
  });
  it('rejects a daemon without the isolated MCP capability before creating a manager', async () => {
    h.tasks.set('t-router', { id: 't-router', source: 'local', router_area_id: AREA_ID, org_role: 'router' });
    h.daemon.mcp = false;
    await expect(runner.assertStartRouting({ taskId: 't-router', mode: 'dontAsk', profile: routerAreaProfile(AREA_ID) })).rejects.toThrow('cannot serve isolated routing tools');
    expect(createSessionManagerMock).not.toHaveBeenCalled();
  });
  it('starts work an older build marked and listed in the area as an ordinary task', async () => {
    h.tasks.set('t-legacy', { id: 't-legacy', source: 'local', router_area_id: AREA_ID });
    h.daemon.mcp = false;
    await expect(runner.assertStartRouting({ taskId: 't-legacy', mode: 'bypassPermissions' })).resolves.toBeUndefined();
  });
  it('does not require isolated MCP support for an ordinary task', async () => {
    h.tasks.set('t-plain', { id: 't-plain', source: 'local' });
    h.daemon.mcp = false;
    await expect(runner.assertStartRouting({ taskId: 't-plain' })).resolves.toBeUndefined();
  });
  it('rejects a fork out of an area even when the target task is ordinary', async () => {
    h.tasks.set('t-plain', { id: 't-plain', source: 'local' });
    h.records.set('source-area', { taskId: 't-router', profile: routerAreaProfile(AREA_ID) });
    await expect(runner.assertStartRouting({ taskId: 't-plain', forkedFromSessionId: 'source-area' })).rejects.toThrow('cannot be copied');
  });
  it('the direct and event start sites both use the shared gate before hints or engine selection', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../src/providers/claude-code-session.ts'), 'utf8');
    const event = source.slice(source.indexOf('case EventNames.SESSION_START:'), source.indexOf('case EventNames.SESSION_SEND:'));
    expect(event.indexOf('await this.assertStartRouting(startData)')).toBeLessThan(event.indexOf('await prepareStartHints(startData)'));
    expect(source).toContain('await this.assertStartRouting(data)');
  });
});

describe('area reconnect prerequisites', () => {
  it('rejects a dropped area profile before attaching a manager', async () => {
    h.tasks.set('t-router', { id: 't-router', source: 'local', router_area_id: AREA_ID, org_role: 'router' })
    await expect(ClaudeCodeSession.attachToExisting({ taskId: 't-router', claudeSessionId: 'attach-area' } as import('../../src/core/types.js').SessionRecord))
      .rejects.toThrow('attached session does not match')
    expect(createSessionManagerMock).not.toHaveBeenCalled()
  })

  it('rejects missing MCP support before any daemon attach or tail read', async () => {
    h.tasks.set('t-router', { id: 't-router', source: 'local', router_area_id: AREA_ID, org_role: 'router' })
    h.daemon.mcp = false
    await expect(ClaudeCodeSession.attachToExisting({ taskId: 't-router', claudeSessionId: 'attach-area', profile: routerAreaProfile(AREA_ID) } as import('../../src/core/types.js').SessionRecord))
      .rejects.toThrow('cannot serve isolated routing tools')
    expect(createSessionManagerMock).not.toHaveBeenCalled()
    expect(h.transportCalls).toEqual([])
  })
})

describe('resolveResumeArgs fails closed for area sessions', () => {
  const runner = sessionRunner as unknown as {
    resolveResumeArgs(sessionId: string): Promise<{ profile?: SessionProfile }>
  }
  const SID = 'resume-area'

  function areaTask(id = 't-router'): void {
    h.tasks.set(id, { id, title: 'router', source: 'local', router_area_id: AREA_ID, org_role: 'router', phase: 'IN_PROGRESS' })
  }

  it('resumes a valid area record with its exact profile', async () => {
    areaTask()
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME, profile: routerAreaProfile(AREA_ID) })
    const resolved = await runner.resolveResumeArgs(SID)
    expect(resolved.profile).toEqual(routerAreaProfile(AREA_ID))
  })

  it('refuses a resume after the daemon loses isolated MCP support', async () => {
    areaTask()
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME, profile: routerAreaProfile(AREA_ID) })
    h.daemon.mcp = false
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow('cannot serve isolated routing tools')
    expect(createSessionManagerMock).not.toHaveBeenCalled()
  })

  it('rejects when the session store cannot be read', async () => {
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    vi.mocked(getSessionByClaudeId).mockRejectedValueOnce(new Error('disk I/O error'))
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow('disk I/O error')
  })

  it('an unknown session with no area evidence resumes on its defaults', async () => {
    expect((await runner.resolveResumeArgs('resume-missing')).profile).toBeUndefined()
  })

  it('rejects an area record whose stored task a prefix lookup answers with another', async () => {
    h.tasks.set('t-gone', { id: 't-gone-other', title: 'ordinary task', phase: 'IN_PROGRESS' })
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-gone', cwd: WALNUT_HOME, profile: routerAreaProfile(AREA_ID) })
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow('prefix match')
    expect(createSessionManagerMock).not.toHaveBeenCalled()
  })

  it('rejects when a prefix lookup hides a stored task the area file lists', async () => {
    areaTask()
    h.tasks.delete('t-router')
    h.tasks.set('t-router', { id: 't-work-other', title: 'ordinary task', phase: 'IN_PROGRESS' })
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME })
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow('prefix match')
  })

  it('an ordinary record whose task is gone resumes on its own fields', async () => {
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-gone', cwd: WALNUT_HOME, mode: 'plan' })
    const resolved = await runner.resolveResumeArgs(SID)
    expect(resolved.profile).toBeUndefined()
    expect(resolved.mode).toBe('plan')
  })

  it('rejects when the task store cannot be read', async () => {
    const { getTask } = await import('../../src/core/task-manager.js')
    vi.mocked(getTask).mockRejectedValueOnce(new Error('disk I/O error'))
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-plain', cwd: WALNUT_HOME })
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow('disk I/O error')
  })

  it('rejects a marked task whose area file is unreadable', async () => {
    areaTask()
    h.areas.error = new Error('corrupt areas.json')
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME, profile: routerAreaProfile(AREA_ID) })
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow()
  })

  it('rejects an area task whose record dropped its profile', async () => {
    areaTask()
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME })
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow()
  })

  it('rejects a record with an old policy version', async () => {
    areaTask()
    const { areaPolicyVersion: _dropped, ...old } = routerAreaProfile(AREA_ID)
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME, profile: old })
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow()
  })

  it('rejects a router assignment\'s task even without its durable mark', async () => {
    h.tasks.set('t-router', { id: 't-router', title: 'unmarked', phase: 'IN_PROGRESS' })
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME })
    await expect(runner.resolveResumeArgs(SID)).rejects.toThrow()
  })

  it('rejects a matching profile when its task lost or changed the durable area mark', async () => {
    for (const mark of [undefined, 'work']) {
      areaTask();
      h.tasks.get('t-router')!.router_area_id = mark;
      h.records.set(SID, { claudeSessionId: SID, taskId: 't-router', cwd: WALNUT_HOME, profile: routerAreaProfile(AREA_ID) });
      await expect(runner.resolveResumeArgs(SID)).rejects.toThrow();
    }
  });

  it('work an older build marked and listed in the area resumes as ordinary work', async () => {
    h.tasks.set('t-legacy', { id: 't-legacy', title: 'legacy', source: 'local', router_area_id: AREA_ID, phase: 'IN_PROGRESS' })
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-legacy', cwd: WALNUT_HOME, mode: 'plan' })
    const resolved = await runner.resolveResumeArgs(SID)
    expect(resolved.profile).toBeUndefined()
    expect(resolved.mode).toBe('plan')
  })

  it('an ordinary task still resumes when the area file is unreadable', async () => {
    h.tasks.set('t-plain', { id: 't-plain', title: 'plain', phase: 'IN_PROGRESS' })
    h.areas.error = new Error('corrupt areas.json')
    h.records.set(SID, { claudeSessionId: SID, taskId: 't-plain', cwd: WALNUT_HOME })
    const resolved = await runner.resolveResumeArgs(SID)
    expect(resolved.profile).toBeUndefined()
  })
})

/**
 * Which Walnut tools a Claude Code session lists (experiment mcp_tools_by_role): its role, from its
 * task (src/core/sessions/tool-listing-role.ts), and the groups that role lists (src/ops/op-groups.ts).
 *
 * Listing only, so what matters is that a session never misses a tool Walnut's own words name, and
 * that it is told where the rest are. So every op that Walnut text a session reads names is listed
 * for the roles that read it:
 *   - every always-loaded prompt block (src/core/sessions/prompt-blocks.ts PROMPT_BLOCKS), built by
 *     its real builder (the session context, the personas, the fleet line, the MCP instructions),
 *     or, for the state blocks a spawn builds inline, read from that builder's source;
 *   - every built-in message hint (src/core/hints/hint-registry.ts), rendered with each kind of state.
 * Both are enumerated from their registries: a new block or a new hint kind with no entry here
 * fails, so a new prompt naming an unlisted op cannot slip past (2026-11-22: the fleet line named
 * host_mcp_call and host_http, which workers did not list, and the old scan of the default
 * instructions alone never saw it).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { listingRoleForCaller, listingRoleOfTask, toolListingOfTask, type ToolListingDeps } from '../../../src/core/sessions/tool-listing-role.js'
import { composeInstructions, DEMO_CONTEXT_LINE } from '../../../src/core/sessions/session-context.js'
import { consoleAgentPersona, GLOBAL_MEMORY_HEADING, personalAiPersona } from '../../../src/core/sessions/profiles.js'
import { PROMPT_BLOCKS } from '../../../src/core/sessions/prompt-blocks.js'
import { fleetPromptLine } from '../../../src/core/hosts/fleet-prompt.js'
import { taskDirLine } from '../../../src/core/work-place.js'
import { ownNotesIndexLine } from '../../../src/core/sessions/memory-folder.js'
import { HINT_TRIGGERS, effectiveHints, type HintContentInput } from '../../../src/core/hints/hint-registry.js'
import { putHintContext } from '../../../src/core/hints/hint-context.js'
import { walnutMcpInstructions } from '../../../src/mcp/instructions.js'
import { listOps } from '../../../src/ops/index.js'
import { LISTING_ROLES, listedForRole, type ListingRole } from '../../../src/ops/op-groups.js'

const SRC = path.resolve(__dirname, '../../../src')

type TaskSlice = Awaited<ReturnType<ToolListingDeps['task']>>

function deps(task: TaskSlice, over: Partial<ToolListingDeps> = {}): ToolListingDeps {
  return {
    flagOn: async () => true,
    session: async (sid) => (sid === 'sid-1' ? { taskId: 't1' } : null),
    task: async (id) => (id === 't1' ? task : undefined),
    ...over,
  }
}

describe('a session\'s listing', () => {
  it('comes from its task: Main and a VP are the org, an Ask speaks as Main, a task with Threads keeps them', async () => {
    expect(await listingRoleForCaller('sid-1', deps({}))).toEqual({ role: 'worker' })
    expect(await listingRoleForCaller('sid-1', deps({ source: 'local' }))).toEqual({ role: 'worker' })
    expect(await listingRoleForCaller('sid-1', deps({ org_role: 'main' }))).toEqual({ role: 'org' })
    expect(await listingRoleForCaller('sid-1', deps({ org_role: 'lead' }))).toEqual({ role: 'org' })
    expect(await listingRoleForCaller('sid-1', deps({ walnut_agent: true }))).toEqual({ role: 'org' })
    expect(await listingRoleForCaller('sid-1', deps({ threads_on: true }))).toEqual({ role: 'thread_keeper' })
  })

  it('a task a plugin syncs lists that plugin\'s tools too', () => {
    expect(toolListingOfTask({ source: 'todo-sync' })).toEqual({ role: 'worker', plugins: ['todo-sync'] })
    expect(listedForRole(toolListingOfTask({ source: 'todo-sync' })!, 'todo_sync_status', 'todo-sync')).toBe(true)
    expect(listedForRole(toolListingOfTask({})!, 'todo_sync_status', 'todo-sync')).toBe(false)
  })

  it('lists everything (no role) with the experiment off, for a router, an outside caller, an unknown session or task, or a failed read', async () => {
    expect(await listingRoleForCaller('sid-1', deps({}, { flagOn: async () => false }))).toBeUndefined()
    // A router keeps its own four ops (router/gateway-policy.ts).
    expect(await listingRoleForCaller('sid-1', deps({ org_role: 'router' }))).toBeUndefined()
    expect(await listingRoleForCaller('external', deps({}))).toBeUndefined()
    expect(await listingRoleForCaller('', deps({}))).toBeUndefined()
    expect(await listingRoleForCaller('sid-2', deps({}))).toBeUndefined()
    expect(await listingRoleForCaller('sid-1', deps(undefined))).toBeUndefined()
    expect(await listingRoleForCaller('sid-1', deps({}, { task: async () => { throw new Error('db locked') } }))).toBeUndefined()
    expect(await listingRoleForCaller('sid-1', deps({}, { flagOn: async () => { throw new Error('no config') } }))).toBeUndefined()
  })
})

/** The op names a text mentions, as whole words. */
function opsNamedIn(text: string): string[] {
  const names = listOps().map((o) => o.name).sort((a, b) => b.length - a.length)
  const re = new RegExp(`\\b(${names.join('|')})\\b`, 'g')
  return [...new Set([...text.matchAll(re)].map((m) => m[1]))]
}

/** A source file's code without its comments (only what can reach a prompt). */
function codeOf(rel: string, from?: string, to?: string): string {
  let text = fs.readFileSync(path.join(SRC, rel), 'utf8')
  if (from) {
    const at = text.indexOf(from)
    expect(at, `${rel}: ${from}`).toBeGreaterThanOrEqual(0)
    text = text.slice(at)
    if (to) text = text.slice(0, text.indexOf(to) >= 0 ? text.indexOf(to) : undefined)
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const ALL_ROLES = LISTING_ROLES
const ORG: readonly ListingRole[] = ['org']

/** Op names a role's Walnut text names that the role does not list. */
function missingFor(roles: readonly ListingRole[], text: string): string[] {
  const named = opsNamedIn(text)
  return roles.flatMap((role) => named.filter((n) => !listedForRole(role, n)).map((n) => `${role}: ${n}`))
}

describe('every op an always-loaded prompt block names is listed for the roles that read it', () => {
  const caps = {
    tags: ['browser', 'ios', 'always-on'], alwaysOn: true, placement: 'local', os: 'macos', ios: { xcode: 'Xcode 26', runtimes: ['iOS 26'] },
    browsers: [{ name: 'Chrome', relay: true }], mcp: [{ name: 'docs' }], clis: ['git', 'gh'], declared: ['gpu'], unknown: [],
  }
  const fleet = fleetPromptLine([
    { host: 'local', label: '', local: true, caps }, { host: 'devbox', label: 'Linux box', local: false, caps },
  ] as never, 'devbox')
  const state = {
    // The task line is built inline by the spawn (composeSessionContext): its words are read from its source below.
    taskLine: 'You are working on the task "T" (id t1, project "P").\n\n',
    taskDir: taskDirLine('/home/user/.local/state/open-walnut/tasks/t1'),
    fleet,
    ownNotes: ownNotesIndexLine([{ name: 'plan.md', bytes: 1200, at: '2026-11-22T00:00:00Z', walnut: false, shared: false }]),
  }
  const tasks: Array<[string, Record<string, unknown>]> = [
    ['worker', { id: 't1', project: 'P' }],
    ['thread keeper', { id: 't1', project: 'P', threads_on: true }],
    ['Main', { id: 't1', org_role: 'main', walnut_agent: true }],
    ['a VP', { id: 't1', org_role: 'lead', project: 'Walnut', org_leads: ['Walnut'] }],
    ['an Ask', { id: 't1', walnut_agent: true }],
  ]
  const covered = new Set<string>()
  const rolesOf = (task: Record<string, unknown>): ListingRole[] => [listingRoleOfTask(task)!]

  it.each(tasks)('the session context of %s', (_label, task) => {
    const c = composeInstructions(task as never, state)
    for (const b of c.blocks) if (b.text.trim()) covered.add(b.id)
    expect(missingFor(rolesOf(task), c.text())).toEqual([])
  })

  it('the personas of Main, an ask and a console agent (all the org)', () => {
    const memory = `## The user\n\nAda.\n\n${GLOBAL_MEMORY_HEADING}\n\n- keep notes short`
    for (const p of [
      personalAiPersona('Ada', 'skill-a: does a', memory, {}),
      personalAiPersona('Ada', 'skill-a: does a', memory, { withSessionContext: true, routingInContext: true }),
      consoleAgentPersona({ id: 'mentor', name: 'Mentor', system_prompt: 'You are Mentor.' }, 'skill-a: does a', 'Mentor notes.', {}),
    ]) {
      for (const b of p.blocks) if (b.text.trim()) covered.add(b.id)
      expect(missingFor(ORG, p.systemPrompt)).toEqual([])
    }
  })

  it('the MCP instructions, for every role', () => {
    const text = walnutMcpInstructions()
    covered.add('mcp-instructions')
    expect(opsNamedIn(text).length).toBeGreaterThan(10)
    expect(missingFor(ALL_ROLES, text)).toEqual([])
  })

  it('the state blocks a spawn builds outside the composer, read from their builders\' source', () => {
    // The task line: its subtask, review, workspace, reports-to and Board branches (composeSessionContext).
    const taskState = codeOf('core/sessions/session-context.ts', 'export async function composeSessionContext(', 'const composed = composeInstructions(found')
      + codeOf('core/workspaces/scripts.ts', 'export function setupPromptLine(', '\nexport ')
    expect(missingFor(ALL_ROLES, taskState)).toEqual([])
    // The fleet's secrets line (hosts/fleet-prompt.ts buildFleetPromptLine adds it).
    expect(missingFor(ALL_ROLES, codeOf('core/secrets/fleet-secrets.ts', 'export async function secretsPromptLine', '\nexport '))).toEqual([])
    covered.add('task-state')
    // Only the shared Demo: Main is who uses it there, and it names no op.
    expect(missingFor(ALL_ROLES, DEMO_CONTEXT_LINE)).toEqual([])
    covered.add('demo')
  })

  it('and every registered block was read by one of the above (a new block needs its entry here)', () => {
    // The user's own words, never Walnut's text: what the user writes may name any op.
    const usersOwn = new Set(['user-profile', 'standing-user', 'agent-persona'])
    const unread = PROMPT_BLOCKS.map((b) => b.id).filter((id) => !covered.has(id) && !usersOwn.has(id))
    expect(unread).toEqual([])
  })
})

describe('every op a message hint names is listed for the roles that get it', () => {
  const now = Date.now()
  const contextId = putHintContext({ name: 'The page', text: 'A page the person had open.' })
  const thread = {
    threadId: 'th1', title: 'Fix the login', created: true, followUp: false, duplicate: false,
    follows: { id: 'th0', title: 'Old login' }, movedTo: { task: 't9', title: 'Login team' }, popped: true, joined: 'reopened',
    open: [{ id: 'th2', title: 'Ship it', state: 'needs', snoozedUntil: new Date(now + 3600_000).toISOString(), pinnedBy: 'human' }],
    closed: [{ id: 'th3', title: 'Done thing', how: 'acked', by: 'human' }],
  }
  const tidy = { items: (['reacted', 'untitled', 'state', 'summary'] as const).map((why, i) => ({ id: `th${i}`, title: `T${i}`, state: 'working', why })), key: 'k' }
  const guidance = { node: 'Walnut VP', lines: ['Keep changes small.'], file: 'team-guidance.md', skills: [{ name: 'deploy', description: 'How to deploy' }] }
  /** Each built-in kind: the inputs that make it speak (each branch), and the roles that get it. */
  const HINTS: Record<string, { roles: readonly ListingRole[]; inputs: HintContentInput[] }> = {
    question: { roles: ALL_ROLES, inputs: [{ config: null, record: null, request: { arg: '6.1' }, message: 'why is it slow?' }] },
    'rich-output': { roles: ALL_ROLES, inputs: [{ config: null, record: { output_mode: 'rich' } }, { config: null, record: { output_mode: 'markdown' }, toldHash: 'rich' }] },
    'voice-reply': { roles: ALL_ROLES, inputs: [{ config: null, record: null, request: {} }] },
    'object-context': { roles: ALL_ROLES, inputs: [{ config: null, record: null, request: { arg: contextId } }] },
    'team-guidance': { roles: ALL_ROLES, inputs: [{ config: null, record: null, teamGuidance: guidance as never }] },
    // A task that keeps Threads hears where the user is, and its threads, as Main and a VP do.
    'user-away': { roles: ['thread_keeper', 'org'], inputs: [{ config: null, record: null, away: { away: true, lastSeenAt: now - 600_000 } }, { config: null, record: null, away: { away: false, lastSeenAt: now }, toldHash: 'away' }] },
    'user-focus': { roles: ['thread_keeper', 'org'], inputs: [{ config: null, record: null, focus: { name: 'Launch', until: now + 3600_000 } }, { config: null, record: null, focus: null, toldHash: 'focus Launch|' }] },
    threads: { roles: ['thread_keeper', 'org'], inputs: [{ config: null, record: null, thread: thread as never }, { config: null, record: null, thread: { ...thread, created: false, followUp: true, follows: undefined, movedTo: undefined } as never }] },
    'threads-tidy': { roles: ['thread_keeper', 'org'], inputs: [{ config: null, record: null, threadsTidy: tidy as never }] },
    brief: { roles: ORG, inputs: [{ config: null, record: null, brief: { at: null, stale: true, words: '2 lines moved since', key: 'k' } }] },
    'hand-on': { roles: ORG, inputs: [{ config: null, record: null, role: 'main' }, { config: null, record: null, role: 'lead' }] },
  }

  it('every built-in hint kind has its entry here', () => {
    const builtIn = effectiveHints(null).filter((h) => h.builtIn).map((h) => h.kind).sort()
    expect(builtIn).toEqual(Object.keys(HINTS).sort())
  })

  it.each(Object.keys(HINTS))('%s', (kind) => {
    const hint = effectiveHints(null).find((h) => h.kind === kind)!
    const { roles, inputs } = HINTS[kind]
    let said = ''
    for (const input of inputs) {
      type Trigger = (typeof HINT_TRIGGERS)[number]
      const sets: ReadonlySet<Trigger>[] = [new Set<Trigger>(HINT_TRIGGERS), new Set<Trigger>(['every_turn']), new Set<Trigger>(['on_change'])]
      for (const reasons of sets) {
        said += `${hint.render(input, reasons)?.text ?? ''}\n`
      }
    }
    expect(said.trim(), `${kind} said nothing with its sample state`).not.toBe('')
    expect(missingFor(roles, said)).toEqual([])
  })
})

describe('the MCP instructions say where the unlisted tools are', () => {
  // Measured before the line (2026-11-21): 2,625 bytes, 2,819 with the core-tools note.
  const BEFORE = 2_625
  const BEFORE_CORE = 2_819

  it('in one short line, true whether or not anything is left out, at most about 200 bytes more', () => {
    const text = walnutMcpInstructions()
    // It names the CLI as the way to a tool that is not listed, and never claims one is missing.
    expect(text).toContain('use the CLI only for a scripted chain of calls or to reach a tool not listed here')
    expect(text).toContain('`walnut tools list` shows every tool by group')
    expect(text).not.toMatch(/not all are/)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(BEFORE + 200)
    // The core list already says tool_help lists the rest: unchanged.
    expect(Buffer.byteLength(walnutMcpInstructions({ core: true }), 'utf8')).toBeLessThanOrEqual(BEFORE_CORE)
  })
})

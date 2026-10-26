/**
 * The Mac's spawn template for a host (src/providers/spawn-template.ts), filled by the
 * daemon's core (src/providers/host-start-core.ts), equals what claude-code-session.ts
 * `send()` hands the daemon's `start` for the same inputs
 * (docs/plan/walnut-replica-servers-impl.md section 8, WP12).
 *
 * Why: a new ask while the Mac is away runs on the host from that template. If `send()`
 * gains a flag (a new hook in `--settings`, a capability flag) and the template does not,
 * a host-started ask runs a different CLI than the Mac would have started, which nothing
 * else notices until a user does. This drives the REAL `send()` against a mock daemon
 * (tests/helpers/mock-daemon.ts records every start payload) and compares argv element by
 * element: the `--settings` JSON with the compact hook, `--debug`, the mode, model,
 * effort, persona and tool flags. A model value outside the picker (a host catalog id)
 * rides as itself on both paths, with --effort by the same rule. Neither path mounts a
 * walnut MCP server on the host: the session's walnut tools are the `walnut` CLI through
 * the daemon's gateway socket. The start carries no env of its own (the daemon builds the
 * CLI's env for both paths alike), which is asserted too.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { createHostStart } from '../../src/providers/host-start-core.js'
import { buildHostSpawnTemplate, buildRoutineSpawnTemplate, hostEffortRules } from '../../src/providers/spawn-template.js'
import { START_TASK_TOKEN } from '../../src/providers/trigger-clock-core.js'
import { modelSupportsEffort } from '../../src/core/types.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { bus } from '../../src/core/event-bus.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
const HOME = '/Users/marina/.open-walnut'
const PERSONA = '## Persona override\n\nYou are Walnut, the personal AI of marina.\n\nUnicode: \u00e9\u4e2d\u{1F600}'
const CONTEXT = 'You are a coding session opened by Walnut.\n\nYou are working on the task "Plan the week" (id task-ask-9, project "Ask Walnut").'

let daemon: MockDaemon
let dir: string
const savedEnv = { debug: process.env.WALNUT_CLAUDE_DEBUG, compact: process.env.WALNUT_COMPACT_OPEN_ITEMS }

beforeAll(async () => { daemon = await createMockDaemon() })
afterAll(async () => { await daemon.stop() })
beforeEach(() => {
  bus.clear()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-parity-'))
})
afterEach(() => {
  if (savedEnv.debug === undefined) delete process.env.WALNUT_CLAUDE_DEBUG; else process.env.WALNUT_CLAUDE_DEBUG = savedEnv.debug
  if (savedEnv.compact === undefined) delete process.env.WALNUT_COMPACT_OPEN_ITEMS; else process.env.WALNUT_COMPACT_OPEN_ITEMS = savedEnv.compact
  fs.rmSync(dir, { recursive: true, force: true })
})

interface Case {
  name: string
  sid: string
  mode?: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  env: { WALNUT_CLAUDE_DEBUG?: string; WALNUT_COMPACT_OPEN_ITEMS?: string }
  streamPartial?: boolean
  permissionPrompt?: boolean
  bypassAllowed?: boolean
  /** The agent's tool lists, in the template and in send()'s profile alike. */
  allowedTools?: string[]
}

const CASES: Case[] = [
  { name: 'defaults: Auto model, the host default mode, debug and the compact hook on', sid: '11111111-2222-4333-8444-555555555551', env: {} },
  { name: 'plan, opus, low effort', sid: '11111111-2222-4333-8444-555555555552', mode: 'plan', model: 'opus', effort: 'low', env: {} },
  { name: 'haiku with an effort', sid: '11111111-2222-4333-8444-555555555553', model: 'haiku', effort: 'high', env: {} },
  { name: 'debug off, compact hook and /tmp git guard off (no --settings at all)', sid: '11111111-2222-4333-8444-555555555554', model: 'sonnet-1m', env: { WALNUT_CLAUDE_DEBUG: '0', WALNUT_COMPACT_OPEN_ITEMS: '0', WALNUT_TMP_GIT_GUARD: '0' } },
  { name: 'the /tmp git guard alone (compact hook off)', sid: '11111111-2222-4333-8444-55555555555a', env: { WALNUT_COMPACT_OPEN_ITEMS: '0' } },
  { name: 'no partial messages, no permission prompt tool', sid: '11111111-2222-4333-8444-555555555555', env: {}, streamPartial: false, permissionPrompt: false },
  { name: 'bypass allowed for this Walnut', sid: '11111111-2222-4333-8444-555555555556', mode: 'bypass', model: 'fable-1m', effort: 'max', env: {}, bypassAllowed: true },
  { name: 'a host catalog model value outside the picker, with an effort', sid: '11111111-2222-4333-8444-555555555557', model: 'global.anthropic.claude-fable-5[1m]', effort: 'high', env: {} },
  { name: 'an older model value that takes no effort', sid: '11111111-2222-4333-8444-555555555558', model: 'us.anthropic.claude-haiku-4-5', effort: 'high', env: {} },
  { name: 'the agent\'s tool lists', sid: '11111111-2222-4333-8444-555555555559', env: {}, allowedTools: ['Bash(walnut:*)', 'Read'] },
]

async function startPayload(sid: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const hit = daemon.getCommandHistoryFor('start').find((c) => c.payload.sid === sid)
    if (hit) return hit.payload
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`no start for ${sid}`)
}

describe('a filled template equals what claude-code-session.ts builds', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      for (const [k, v] of Object.entries(c.env)) process.env[k] = v
      if (!('WALNUT_CLAUDE_DEBUG' in c.env)) delete process.env.WALNUT_CLAUDE_DEBUG
      if (!('WALNUT_COMPACT_OPEN_ITEMS' in c.env)) delete process.env.WALNUT_COMPACT_OPEN_ITEMS
      if (!('WALNUT_TMP_GIT_GUARD' in c.env)) delete process.env.WALNUT_TMP_GIT_GUARD
      const hs = createHostStart({ fs, path, dir, keyOf: () => 'k', now: () => 1, log: () => {}, busy: () => 0 })
      hs.setTemplate(HOME, buildHostSpawnTemplate({
        home: HOME, hostKey: 'marina', cwd: dir, env: { ...process.env },
        streamPartialMessages: c.streamPartial, permissionPrompt: c.permissionPrompt, bypassAllowed: c.bypassAllowed,
        ...(c.allowedTools ? { agents: { general: { allowedTools: c.allowedTools } } } : {}),
      }))
      const filled = hs.plan(HOME, {
        sid: c.sid, taskId: 'task-ask-9', agentId: 'general', title: 'Plan the week',
        ...(c.mode ? { mode: c.mode } : {}), ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}),
        persona: { text: PERSONA, context: CONTEXT }, firstMessage: 'plan my week',
      }, 'marina')
      if (!filled.ok) throw new Error(filled.message)

      // The Mac's own path: the persona as the profile (no MCP mount, as every session this
      // Mac runs on a remote host), the session context as the append prompt, on a remote host.
      const session = new ClaudeCodeSession('task-ask-9', 'Ask Walnut', MOCK_CLI)
      ;(session as unknown as { _testDaemonUrl?: string })._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`
      session.send(
        'plan my week', dir, undefined, c.mode ?? filled.plan.mode, c.model, CONTEXT, 'marina', undefined, undefined,
        c.permissionPrompt, undefined, c.streamPartial, c.effort, undefined,
        { preassignedSessionId: c.sid, profile: { systemPrompt: PERSONA, systemPromptMode: 'append', ...(c.allowedTools ? { allowedTools: c.allowedTools } : {}) } },
      )
      const payload = await startPayload(c.sid)
      const built = payload.args as string[]
      expect(filled.plan.args).toEqual(built)
      // The start sends no env: the daemon builds the CLI's env itself, the same for both.
      expect(payload).not.toHaveProperty('env')
      expect(payload.cwd).toBe(filled.plan.cwd)
      expect(payload.mode).toBe(filled.plan.mode)

      const settingsAt = built.indexOf('--settings')
      if (c.env.WALNUT_COMPACT_OPEN_ITEMS === '0' && c.env.WALNUT_TMP_GIT_GUARD === '0') {
        expect(settingsAt).toBe(-1)
      } else {
        const settings = JSON.parse(built[settingsAt + 1]) as { env?: unknown; hooks?: { SessionStart?: Array<{ matcher: string }>; PreToolUse?: Array<{ matcher: string }> } }
        expect(settings.hooks?.SessionStart?.[0]?.matcher).toBe(c.env.WALNUT_COMPACT_OPEN_ITEMS === '0' ? undefined : 'compact')
        expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe(c.env.WALNUT_TMP_GIT_GUARD === '0' ? undefined : 'Bash')
        // A remote host's session never carries the Mac's API root.
        expect(settings.env).toBeUndefined()
      }
      expect(built.includes('--debug')).toBe(c.env.WALNUT_CLAUDE_DEBUG !== '0')
      expect(built).toContain('--allow-dangerously-skip-permissions')
      expect(built).not.toContain('--dangerously-skip-permissions')
      expect(built).not.toContain('--mcp-config')
      try { session.detach() } catch { /* the mock daemon reaps its CLIs at stop */ }
    })
  }
})

describe('the template\'s effort rules decide as the Mac does', () => {
  it('for every model value the Mac knows a rule for, and for ones it does not', () => {
    const rules = hostEffortRules()
    const hs = createHostStart({ fs, path, dir, keyOf: () => 'k', now: () => 1, log: () => {}, busy: () => 0 })
    const values = [
      'opus', 'sonnet', 'haiku', 'opus[1m]', 'global.anthropic.claude-fable-5[1m]', 'us.anthropic.claude-haiku-4-5',
      'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-sonnet-4-5', 'acme-model-7', 'mistral.large-3',
      ...rules.overrides.map((o) => `claude-${o.match}`), ...rules.families.map((f) => `x.${f.match}-9`),
    ]
    const t = buildHostSpawnTemplate({ home: HOME, hostKey: 'marina', cwd: dir, env: {}, now: 1 })
    hs.setTemplate(HOME, { ...t, models: {} })
    for (const [i, v] of values.entries()) {
      const r = hs.plan(HOME, {
        sid: `11111111-2222-4333-8444-${(700000000000 + i).toString().padStart(12, '0')}`, taskId: 'task-ask-9', title: 'x',
        model: v, effort: 'low', persona: { text: 'You are Walnut.' }, firstMessage: 'hi',
      }, 'marina')
      if (!r.ok) throw new Error(`${v}: ${r.message}`)
      expect(r.plan.args.includes('--effort'), v).toBe(modelSupportsEffort(v))
    }
  })
})

describe('a filled routine template equals what claude-code-session.ts builds for a routine run (clock-host-start-v1)', () => {
  // A routine run on the Mac: no profile, the session context as the append prompt, the
  // mode it names none of (DEFAULT_SESSION_MODE), its own folder, on that host.
  const ROUTINE_TASK = 'mrun1abc-0a1b2c3d'
  const context = (id: string) => `You are a coding session opened by Walnut.\n\nYou are working on the task "Routine: Nightly build" (id ${id}, project "Routines").`
  const RCASES: Array<{ name: string; sid: string; model?: string; effort?: 'low' | 'high' | 'max' }> = [
    { name: 'Auto model, no effort', sid: '22222222-2222-4333-8444-555555555551' },
    { name: 'opus with an effort', sid: '22222222-2222-4333-8444-555555555552', model: 'opus', effort: 'high' },
    { name: 'a host catalog model value', sid: '22222222-2222-4333-8444-555555555553', model: 'global.anthropic.claude-fable-5[1m]', effort: 'max' },
  ]
  for (const c of RCASES) {
    it(c.name, async () => {
      delete process.env.WALNUT_CLAUDE_DEBUG
      delete process.env.WALNUT_COMPACT_OPEN_ITEMS
      const hs = createHostStart({ fs, path, dir, keyOf: () => 'k', now: () => 1, log: () => {}, busy: () => 0 })
      hs.setTemplate(HOME, buildRoutineSpawnTemplate({ home: HOME, hostKey: 'marina', env: { ...process.env } }), 'routine')
      const filled = hs.planRoutine(HOME, {
        sid: c.sid, taskId: ROUTINE_TASK, title: 'Routine: Nightly build', cwd: dir, mode: 'bypass',
        ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}),
        context: context(START_TASK_TOKEN), taskToken: START_TASK_TOKEN, firstMessage: 'build the nightly', routine: { id: 'job-1', slotMs: 1 },
      }, 'marina')
      if (!filled.ok) throw new Error(filled.message)
      const session = new ClaudeCodeSession(ROUTINE_TASK, 'Routines', MOCK_CLI)
      ;(session as unknown as { _testDaemonUrl?: string })._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`
      session.send(
        'build the nightly', dir, undefined, undefined, c.model, context(ROUTINE_TASK), 'marina', undefined, undefined,
        undefined, undefined, undefined, c.effort, undefined, { preassignedSessionId: c.sid },
      )
      const payload = await startPayload(c.sid)
      expect(filled.plan.args).toEqual(payload.args)
      expect(payload).not.toHaveProperty('env')
      expect(payload.cwd).toBe(filled.plan.cwd)
      expect(payload.mode).toBe(filled.plan.mode)
      expect(payload.args as string[]).not.toContain('--allowedTools')
      try { session.detach() } catch { /* the mock daemon reaps its CLIs at stop */ }
    })
  }
})

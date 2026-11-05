/**
 * Guard: on EVERY ACP engine, Walnut answers the permission requests it owns and
 * a person sees only the rest (src/providers/acp-permission-posture.ts).
 *
 * 2026-11-05: a Codex reviewer task started by another task kept showing the
 * user an "execute" card for `walnut tools call task_send ...`. The path under
 * test is the real one minus the daemon: the scripted mock adapter sends
 * session/request_permission → the real AcpWorker journals it → each journal
 * line reaches a real AcpSession as the daemon pushes it ('jsonl', v = end
 * offset) → the session answers through `acpRespond`, relayed to the worker's
 * permissionResponse → the adapter reads the option it got back.
 *
 * Every engine in the catalog runs the matrix with its own shape of a shell
 * command request, so a new engine fails the ratchet until it is listed here.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-permission-every-engine'))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { acpEngineIds } from '../../src/core/agents/engine-registry.js'
import { _resetSessionTrackerForTesting, createSessionRecord } from '../../src/core/session-tracker.js'
import { _resetForTesting } from '../../src/core/task-manager.js'
import type { SessionEngine, SessionMode } from '../../src/core/types.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import { AcpModeRefusedError } from '../../src/providers/acp-permission-posture.js'
import { AcpWorker } from '../../src/providers/acp-worker/worker.js'
import { snapshotAcpConfigOptions } from '../../src/providers/acp-worker/protocol.js'

const MOCK_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-acp-agent.mjs')

const WALNUT_CMD = `walnut tools call task_send '{"to":"lead","text":"review done; see notes"}'`
/** POSIX single-quoting, as a shell join quotes an argument. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`
/** codex-acp's rawInput view of `zsh -lc <script>`: wrapper and outer quotes stripped. */
const codexShown = (script: string) => shQuote(script).slice(1, -1)

/**
 * Each engine's own shape of a shell-command permission request (title, kind,
 * rawInput), as its adapter reports one. `custom` is any adapter: argv form.
 */
const SHELL_SHAPES: Record<string, (command: string) => Record<string, unknown>> = {
  // codex-acp 1.4: the command it runs rides the request's _meta; rawInput is stripped.
  codex: (command) => ({
    toolCall: { kind: 'execute', rawInput: { command: codexShown(command), cwd: '/work' } },
    _meta: { codex: { params: { command: `/bin/zsh -lc ${shQuote(command)}`, cwd: '/work' } } },
  }),
  gemini: (command) => ({ kind: 'execute', title: command, rawInput: { command, description: 'Run it' } }),
  opencode: (command) => ({ kind: 'execute', title: 'bash', rawInput: { command, description: 'Run it' } }),
  goose: (command) => ({ kind: 'execute', title: 'developer__shell', rawInput: { command } }),
  pi: (command) => ({ kind: 'execute', title: 'bash', rawInput: { command } }),
  dsh: (command) => ({ kind: 'execute', title: 'shell', rawInput: { command } }),
  custom: (command) => ({ kind: 'execute', title: 'terminal', rawInput: { command: ['bash', '-lc', command] } }),
}

let tmpDir: string
let workers: AcpWorker[] = []

beforeEach(async () => {
  _resetForTesting()
  _resetSessionTrackerForTesting()
  await fs.promises.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.promises.mkdir(WALNUT_HOME, { recursive: true })
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-perm-engine-'))
  workers = []
})

afterEach(async () => {
  for (const w of workers) await w.handle({ id: 0, op: 'shutdown' as never }).catch(() => {})
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

let reqId = 0

interface Rig {
  session: AcpSession
  worker: AcpWorker
  cards: () => Array<Record<string, unknown>>
  prompt: (text: string) => Promise<void>
  /** Resolves with the adapter's own words about the answer it got. */
  outcome: (n: number) => Promise<string>
}

/** How the fake daemon answers the n-th `acpRespond` (1-based); default: relay to the worker. */
type Respond = (n: number) => 'relay' | 'throw' | 'not-ok'

async function rig(engine: SessionEngine, mode: SessionMode, respond: Respond = () => 'relay'): Promise<Rig> {
  const journal = path.join(tmpDir, `${engine}-${mode}.acp.jsonl`)
  let pushed = 0
  let session: AcpSession | null = null
  // The daemon's journal tail: every complete line, in order, v = its end offset.
  const pushLines = () => {
    if (!session) return
    const buf = fs.readFileSync(journal)
    const text = buf.subarray(pushed).toString('utf8')
    let at = pushed
    for (const line of text.split('\n')) {
      const end = at + Buffer.byteLength(line, 'utf8') + 1
      if (end > buf.length) break
      at = end
      if (!line.trim()) continue
      ;(session as unknown as { handleDaemonEvent(ev: unknown): void }).handleDaemonEvent({ sid: session.runtimeId, ev: 'jsonl', line, v: end })
    }
    pushed = at
  }
  const worker = new AcpWorker(journal, () => queueMicrotask(pushLines))
  workers.push(worker)
  const init = await worker.handle({ id: ++reqId, op: 'initialize', params: { adapterCommand: [process.execPath, MOCK_AGENT], cwd: tmpDir } } as never)
  expect(init.ok).toBe(true)
  const created = await worker.handle({ id: ++reqId, op: 'newSession', params: { cwd: tmpDir } } as never) as { ok: boolean; result?: unknown }
  expect(created.ok).toBe(true)
  const sessionResponse = created.result as { sessionId: string }
  const sid = sessionResponse.sessionId
  await createSessionRecord(sid, '', '', tmpDir, { mode, engine, initialProcessStatus: 'idle' } as never)

  session = new AcpSession({ taskId: '', project: '', cwd: tmpDir, mode, modeNamed: true, engine })
  // codex-acp advertises its presets as the `mode` control; the other adapters'
  // controls are their own, so only codex keeps the mock's presets.
  const controls = snapshotAcpConfigOptions(sessionResponse).filter((c) => engine === 'codex' || c.id !== 'mode')
  let responds = 0
  const send = vi.fn(async (command: string, params?: Record<string, unknown>) => {
    if (command === 'acpRespond') {
      const how = respond(++responds)
      if (how === 'throw') throw new Error('daemon connection lost')
      if (how === 'not-ok') return { ok: false, error: 'worker busy' }
      const resp = await worker.handle({ id: ++reqId, op: 'permissionResponse', params: {
        commandId: params!.commandId, providerRequestId: params!.providerRequestId, optionId: params!.optionId,
      } } as never)
      return resp
    }
    return { ok: true }
  })
  Object.assign(session as object, {
    conn: { connected: true, send },
    _active: true,
    _providerSessionId: sid,
    _configOptions: controls,
  })
  const emitted: Array<Record<string, unknown>> = []
  const realEmit = bus.emit.bind(bus)
  vi.spyOn(bus, 'emit').mockImplementation(((name: string, data: unknown, ...rest: unknown[]) => {
    if (name === EventNames.SESSION_PERMISSION_REQUEST && (data as { sessionId?: string }).sessionId === sid) emitted.push(data as Record<string, unknown>)
    return (realEmit as (...a: unknown[]) => unknown)(name, data, ...rest)
  }) as typeof bus.emit)

  let turns = 0
  return {
    session,
    worker,
    cards: () => emitted,
    prompt: async (text) => {
      const resp = await worker.handle({ id: ++reqId, op: 'prompt', params: { commandId: `cmd-${++turns}`, walnutMessageId: `qm-${turns}`, text } } as never)
      expect(resp.ok).toBe(true)
    },
    outcome: async (n) => {
      const deadline = Date.now() + 8000
      for (;;) {
        const said = fs.readFileSync(journal, 'utf8').split('\n')
          .flatMap((line) => line.match(/exec permission[^"]*/g) ?? [])
        if (said.length >= n) return said[n - 1]
        if (Date.now() > deadline) throw new Error(`no adapter outcome #${n}; cards: ${emitted.length}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    },
  }
}

const ask = (engine: string, command: string) => `exec-permission-test ${JSON.stringify(SHELL_SHAPES[engine](command))}`

async function waitForCard(r: Rig, n: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8000
  while (r.cards().length < n) {
    if (Date.now() > deadline) throw new Error(`no permission card #${n}`)
    await new Promise((res) => setTimeout(res, 20))
  }
  return r.cards()[n - 1]
}

describe('ratchet: every ACP engine in the catalog is covered', () => {
  it('lists a permission-request shape for each engine', () => {
    expect(Object.keys(SHELL_SHAPES).sort()).toEqual([...acpEngineIds()].sort())
  })
})

describe.each(acpEngineIds())('%s permission posture', (engine) => {
  it('bypass: Walnut answers the walnut CLI and a plain command, no card reaches the user', async () => {
    const r = await rig(engine, 'bypass')
    await r.prompt(ask(engine, WALNUT_CMD))
    expect(await r.outcome(1)).toBe('exec permission: allow-once')
    await r.prompt(ask(engine, 'ls'))
    expect(await r.outcome(2)).toBe('exec permission: allow-once')
    expect(r.cards()).toEqual([])
    expect(r.session.getPendingPermissionRequests()).toEqual([])
  }, 30_000)

  it('default: the walnut CLI is still answered; a plain command, a chain and host_exec ask the user', async () => {
    const r = await rig(engine, 'default')
    await r.prompt(ask(engine, WALNUT_CMD))
    expect(await r.outcome(1)).toBe('exec permission: allow-once')
    expect(r.cards()).toEqual([])

    await r.prompt(ask(engine, 'ls'))
    const card = await waitForCard(r, 1)
    expect(r.session.getPendingPermissionRequests().map((p) => p.requestId)).toEqual([card.requestId])
    expect(await r.session.resolvePermissionRequest(card.requestId as string, false)).toBe(true)
    expect(await r.outcome(2)).toBe('exec permission: reject-once')

    await r.prompt(ask(engine, 'walnut tools call task_list; rm -rf ~'))
    const chain = await waitForCard(r, 2)
    expect(await r.session.resolvePermissionRequest(chain.requestId as string, false)).toBe(true)
    expect(await r.outcome(3)).toBe('exec permission: reject-once')

    // A Walnut op that runs a command of the caller's choosing asks like one.
    await r.prompt(ask(engine, `walnut tools call host_exec '{"host":"box","cmd":"id"}'`))
    const hostExec = await waitForCard(r, 3)
    expect(await r.session.resolvePermissionRequest(hostExec.requestId as string, false)).toBe(true)
    expect(await r.outcome(4)).toBe('exec permission: reject-once')
  }, 30_000)
})

describe('codex: the command is read from _meta, never from the stripped rawInput', () => {
  it('a chain in the real command asks even when rawInput reads as a walnut call', async () => {
    const r = await rig('codex', 'default')
    await r.prompt(`exec-permission-test ${JSON.stringify({
      toolCall: { kind: 'execute', rawInput: { command: 'walnut tools call task_list' } },
      _meta: { codex: { params: { command: `/bin/zsh -lc ${shQuote('walnut tools call task_list; rm -rf ~')}` } } },
    })}`)
    const card = await waitForCard(r, 1)
    expect(await r.session.resolvePermissionRequest(card.requestId as string, false)).toBe(true)
    expect(await r.outcome(1)).toBe('exec permission: reject-once')
  }, 30_000)

  it('a Codex request with no _meta asks outside bypass', async () => {
    const r = await rig('codex', 'default')
    await r.prompt(`exec-permission-test ${JSON.stringify({ kind: 'execute', rawInput: { command: 'walnut tools call task_list' } })}`)
    const card = await waitForCard(r, 1)
    expect(await r.session.resolvePermissionRequest(card.requestId as string, false)).toBe(true)
    expect(await r.outcome(1)).toBe('exec permission: reject-once')
  }, 30_000)

  it('a Walnut MCP tool approval is answered; a permissions request titled like one asks', async () => {
    const r = await rig('codex', 'default')
    await r.prompt(`exec-permission-test ${JSON.stringify({
      toolCall: { kind: 'execute', rawInput: { server: 'walnut', tool: 'task_send', arguments: { to: 'lead' } } },
      _meta: { is_mcp_tool_approval: true },
    })}`)
    expect(await r.outcome(1)).toBe('exec permission: allow-once')
    await r.prompt(`exec-permission-test ${JSON.stringify({
      toolCall: { kind: 'other', title: 'mcp__walnut__task_send', rawInput: { reason: 'mcp__walnut__task_send', permissions: { network: true } } },
      _meta: { codex: { params: { reason: 'mcp__walnut__task_send' } } },
    })}`)
    const card = await waitForCard(r, 1)
    expect(await r.session.resolvePermissionRequest(card.requestId as string, false)).toBe(true)
    expect(await r.outcome(2)).toBe('exec permission: reject-once')
  }, 30_000)
})

describe('a failed automatic answer goes to a person', () => {
  beforeEach(() => { AcpSession.AUTO_ANSWER_RETRY_MS = 1 })
  afterEach(() => { AcpSession.AUTO_ANSWER_RETRY_MS = 250 })

  it('a rejected acpRespond is retried, then the request shows its card and can be answered', async () => {
    const r = await rig('gemini', 'bypass', (n) => n <= AcpSession.AUTO_ANSWER_ATTEMPTS ? 'throw' : 'relay')
    await r.prompt(ask('gemini', 'ls'))
    const card = await waitForCard(r, 1)
    expect(r.session.getPendingPermissionRequests().map((p) => p.requestId)).toEqual([card.requestId])
    expect(await r.session.resolvePermissionRequest(card.requestId as string, true)).toBe(true)
    expect(await r.outcome(1)).toBe('exec permission: allow-once')
  }, 30_000)

  it('a not-ok answer is retried, then the request shows its card', async () => {
    const r = await rig('opencode', 'default', (n) => n <= AcpSession.AUTO_ANSWER_ATTEMPTS ? 'not-ok' : 'relay')
    await r.prompt(ask('opencode', WALNUT_CMD))
    const card = await waitForCard(r, 1)
    expect(r.session.getPendingPermissionRequests().map((p) => p.requestId)).toEqual([card.requestId])
    expect(await r.session.resolvePermissionRequest(card.requestId as string, false)).toBe(true)
    expect(await r.outcome(1)).toBe('exec permission: reject-once')
  }, 30_000)

  it('a transient failure that clears within the attempts stays automatic', async () => {
    const r = await rig('pi', 'bypass', (n) => n === 1 ? 'throw' : 'relay')
    await r.prompt(ask('pi', 'ls'))
    expect(await r.outcome(1)).toBe('exec permission: allow-once')
    expect(r.cards()).toEqual([])
  }, 30_000)
})

describe('a restrictive Walnut mode never runs on a stale full-access preset', () => {
  const yoloControl = (current: string) => [{
    id: 'mode', name: 'Mode', type: 'select' as const, currentValue: current,
    options: ['default', 'yolo'].map((value) => ({ value, name: value })),
  }]

  it('a downgrade the adapter refuses fails the mode change, and Walnut answers nothing for it', async () => {
    const r = await rig('gemini', 'bypass')
    Object.assign(r.session as object, { _configOptions: yoloControl('yolo') })
    vi.spyOn(r.session, 'setConfigOption').mockResolvedValue(false)
    await expect(r.session.applyWalnutMode('default')).rejects.toBeInstanceOf(AcpModeRefusedError)
    expect(r.session.mode).toBe('default')
    await r.prompt(ask('gemini', 'ls'))
    const card = await waitForCard(r, 1)
    expect(await r.session.resolvePermissionRequest(card.requestId as string, false)).toBe(true)
    expect(await r.outcome(1)).toBe('exec permission: reject-once')
  }, 30_000)

  it('the refusal reaches the caller of a live mode change', async () => {
    const r = await rig('gemini', 'bypass')
    Object.assign(r.session as object, { _configOptions: yoloControl('yolo') })
    vi.spyOn(r.session, 'setConfigOption').mockResolvedValue(false)
    const { sessionRunner } = await import('../../src/providers/claude-code-session.js')
    vi.spyOn(sessionRunner, 'findAcpSession').mockReturnValue(r.session)
    vi.spyOn(sessionRunner, 'findOrAttachAcpSession').mockResolvedValue(r.session)
    const { changeSessionMode } = await import('../../src/core/sessions/session-lifecycle.js')
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const record = (await getSessionByClaudeId(r.session.sessionId!))!
    await expect(changeSessionMode(record, record.claudeSessionId, 'default')).rejects.toBeInstanceOf(AcpModeRefusedError)
  }, 30_000)

  it('a downgrade the adapter takes moves it to its asking preset', async () => {
    const r = await rig('gemini', 'bypass')
    Object.assign(r.session as object, { _configOptions: yoloControl('yolo') })
    const set = vi.spyOn(r.session, 'setConfigOption').mockResolvedValue(true)
    await r.session.applyWalnutMode('default')
    expect(set).toHaveBeenCalledWith('mode', 'default')
  }, 30_000)
})

describe('codex: the adapter\'s own preset', () => {
  it('a preset the user chose in the adapter control stands over a bypass Walnut mode', async () => {
    const r = await rig('codex', 'bypass')
    Object.assign(r.session as object, { _chosenMode: 'agent' })
    await r.prompt(ask('codex', 'ls'))
    const card = await waitForCard(r, 1)
    // The user then picks full access (what setConfigOption records): the waiting
    // card is answered for them.
    Object.assign(r.session as object, {
      _chosenMode: 'agent-full-access',
      _configOptions: r.session.sessionControls.map((c) => c.id === 'mode' ? { ...c, currentValue: 'agent-full-access' } : c),
    })
    await (r.session as unknown as { autoAllowPending(): Promise<void> }).autoAllowPending()
    expect(await r.outcome(1)).toBe('exec permission: allow-once')
    expect(card.requestId).toBeTruthy()
  }, 30_000)

  it('never answers a plan\'s go-ahead, even in bypass', async () => {
    const r = await rig('codex', 'bypass')
    await r.prompt(`exec-permission-test ${JSON.stringify({ kind: 'switch_mode', title: 'Implement this plan?', rawInput: { plan: 'x' } })}`)
    const card = await waitForCard(r, 1)
    expect(await r.session.resolvePermissionRequest(card.requestId as string, false)).toBe(true)
    expect(await r.outcome(1)).toBe('exec permission: reject-once')
  }, 30_000)
})

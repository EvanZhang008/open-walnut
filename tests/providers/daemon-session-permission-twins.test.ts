/**
 * Exercise both bridge permission entry points without booting either daemon.
 * Only named functions are evaluated in a VM with no process, filesystem or network
 * access. FIFO writes, registry persistence and snapshot pushes are stubs.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createLiveSettings } from '../../src/providers/live-settings-core.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SID = '11111111-2222-4333-8444-555555555555'
const OTHER_SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const REQUEST = 'permission-1'
const sources = {
  standalone: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8'),
  source: fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8'),
}
type Twin = keyof typeof sources
type Command = Record<string, unknown>
type Reply = { id: number; ok: boolean; error?: string; errorKind?: string; [key: string]: unknown }
type Pending = { reqId: string; request: Record<string, unknown> }

function functionText(src: string, name: string): string {
  const start = src.search(new RegExp('(?:async )?function ' + name + '\\('))
  expect(start, name).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  expect(end, name).toBeGreaterThan(start)
  return src.slice(start, end + 2)
}

function literals(src: string, name: string): string[] {
  const match = src.match(new RegExp(name + ' = (?:new Set\\()?\\[([\\s\\S]*?)\\]'))
  expect(match, name).not.toBeNull()
  return [...match![1]!.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

function pending(input: Record<string, unknown> = { command: 'read fixture.txt' }, tool = 'Bash', reqId = REQUEST): Pending {
  return { reqId, request: { subtype: 'can_use_tool', tool_name: tool, input } }
}

function buildTwin(kind: Twin, initial: Pending | null = pending()) {
  const replies: Reply[] = []
  const sessions = new Map<string, { pendingCtrl: Pending | null }>([[SID, { pendingCtrl: initial }]])
  let available = true
  const writes = vi.fn(async (_sid: string, _line: string) => available ? 'ok' as const : 'failed' as const)
  const persistRegistry = vi.fn()
  const pushSnapshot = vi.fn()
  const unrelatedWrite = vi.fn(async () => { throw new Error('unexpected settings write') })
  const liveSettings = createLiveSettings({
    writeLine: unrelatedWrite,
    randomHex: () => 'abcd',
    now: () => 1,
    log: vi.fn(),
  })
  const work: Promise<unknown>[] = []
  const run = vi.fn((fn: () => unknown) => {
    const result = fn()
    work.push(Promise.resolve(result))
    return result
  })
  const injected = {
    sessions,
    liveSettings,
    core: { handleSendRawCommand: async (sid: string, line: string) => ({ ok: (await writes(sid, line)) === 'ok' }) },
    writeSessionLine: writes,
    persistRegistry,
    pushSnapshot,
    logMsg: vi.fn(),
    safeSend: (ws: { send: (line: string) => void }, line: string) => ws.send(line),
    daemonCommands: { admit: (fn: () => unknown) => fn(), run },
    BRIDGE_ALLOWED_COMMANDS: new Set(literals(sources[kind], 'BRIDGE_ALLOWED_COMMANDS')),
    FOLLOWER_ALLOWED_COMMANDS: new Set(literals(sources[kind], 'FOLLOWER_ALLOWED_COMMANDS')),
    LANE_ALLOWED_COMMANDS: new Set(literals(sources[kind], 'LANE_ALLOWED_COMMANDS')),
    followerReads: { settle: vi.fn(() => null) },
    followerScope: vi.fn(() => false),
  }
  const code = ['handleCommand', 'dispatchCommand', 'cmdSessionPermission', 'answerPermission', 'isJournalSid', 'sendOk', 'sendError']
    .map((name) => functionText(sources[kind], name)).join('\n')
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const context = vm.createContext(injected, { codeGeneration: { strings: false, wasm: false } })
  const handle = vm.runInContext(js + '\nhandleCommand', context) as (ws: unknown, line: string) => void
  let nextId = 1
  const call = async (body: Command, origin: string | null = 'bridge'): Promise<Reply> => {
    const id = nextId++
    const socket = { send: (line: string) => replies.push(JSON.parse(line) as Reply), ...(origin ? { origin } : {}) }
    const ws = kind === 'standalone' ? { ...socket, data: origin ? { origin } : {} } : socket
    const at = work.length
    handle(ws, JSON.stringify({ id, cmd: 'session.permission', sid: SID, requestId: REQUEST, allow: true, ...body }))
    await Promise.all(work.slice(at))
    const reply = replies.find((r) => r.id === id)
    expect(reply, 'one command must reply').toBeDefined()
    expect(replies.filter((r) => r.id === id)).toHaveLength(1)
    expect(unrelatedWrite).not.toHaveBeenCalled()
    return reply!
  }
  return { call, sessions, writes, persistRegistry, pushSnapshot, liveSettings, run, unavailable: () => { available = false }, available: () => { available = true } }
}

for (const kind of ['standalone', 'source'] as const) {
  describe(`${kind} twin: bridge permission answer`, () => {
    it('allows exactly the current daemon-owned tool input and clears the prompt', async () => {
      const input = { command: 'read fixture.txt', timeout: 2500 }
      const h = buildTwin(kind, pending(input))
      expect(await h.call({})).toMatchObject({ ok: true, status: 'resolved', requestId: REQUEST, allow: true })
      expect(h.run).toHaveBeenCalledOnce()
      expect(h.writes).toHaveBeenCalledOnce()
      expect(h.writes.mock.calls[0]![0]).toBe(SID)
      expect(JSON.parse(h.writes.mock.calls[0]![1])).toEqual({
        type: 'control_response',
        response: { subtype: 'success', request_id: REQUEST, response: { behavior: 'allow', updatedInput: input } },
      })
      expect(h.sessions.get(SID)!.pendingCtrl).toBeNull()
      expect(h.persistRegistry).toHaveBeenCalledOnce()
      expect(h.pushSnapshot).toHaveBeenCalledExactlyOnceWith(SID, false)
    })

    it.each([undefined, 'Please use a different file.'])('denies with the normal message (%s)', async (message) => {
      const h = buildTwin(kind)
      expect(await h.call({ allow: false, ...(message === undefined ? {} : { message }) }))
        .toMatchObject({ ok: true, status: 'resolved', requestId: REQUEST, allow: false })
      expect(JSON.parse(h.writes.mock.calls[0]![1]).response.response)
        .toEqual({ behavior: 'deny', message: message ?? 'User denied permission' })
      expect(h.sessions.get(SID)!.pendingCtrl).toBeNull()
    })

    it('uses AskUserQuestion answers without replacing questions or other tool input', async () => {
      const question = 'Choose a region\nSecond line'
      const input = { questions: [{ question, options: [{ label: 'North' }, { label: 'South' }] }], metadata: { fixture: true } }
      const unicode = String.fromCodePoint(0x43, 0x61, 0x66, 0xe9, 0x20, 0x6e2c, 0x8a66)
      const answers = { [question]: 'North', 'Extra note': unicode + ' ' + 'a'.repeat(8192) }
      const h = buildTwin(kind, pending(input, 'AskUserQuestion'))
      expect(await h.call({ answers })).toMatchObject({ ok: true, allow: true })
      expect(JSON.parse(h.writes.mock.calls[0]![1]).response.response)
        .toEqual({ behavior: 'allow', updatedInput: { ...input, answers } })
      expect(input).not.toHaveProperty('answers')
    })

    it('ignores raw lines, control requests and general updatedInput fields', async () => {
      const input = { command: 'read fixture.txt' }
      const h = buildTwin(kind, pending(input))
      expect(await h.call({
        line: '{"type":"control_request"}', raw: 'untrusted input',
        control_request: { subtype: 'interrupt' }, updatedInput: { command: 'replace fixture.txt' },
      })).toMatchObject({ ok: true, allow: true })
      expect(h.writes).toHaveBeenCalledOnce()
      expect(JSON.parse(h.writes.mock.calls[0]![1]).response.response.updatedInput).toEqual(input)
    })

    it.each([
      ['another request', pending(), { requestId: 'permission-other' }],
      ['no pending request', null, {}],
      ['another control subtype', { reqId: REQUEST, request: { subtype: 'set_permission_mode' } }, {}],
      ['missing session', pending(), { sid: OTHER_SID }],
    ] as const)('refuses %s without any write or prompt change', async (_label, prompt, body) => {
      const h = buildTwin(kind, prompt)
      expect(await h.call(body)).toMatchObject({ ok: false, errorKind: 'not_found' })
      expect(h.writes).not.toHaveBeenCalled()
      expect(h.persistRegistry).not.toHaveBeenCalled()
      expect(h.pushSnapshot).not.toHaveBeenCalled()
      expect(h.sessions.get(SID)!.pendingCtrl).toBe(prompt)
    })

    it.each([true, false])('retries a resolved answer idempotently and keeps its original decision (%s)', async (allow) => {
      const h = buildTwin(kind)
      expect(await h.call({ allow })).toMatchObject({ ok: true, allow })
      expect(await h.call({ allow })).toMatchObject({ ok: true, status: 'resolved', requestId: REQUEST, allow })
      expect(await h.call({ allow: !allow })).toMatchObject({ ok: true, allow })
      expect(h.writes).toHaveBeenCalledOnce()
      expect(h.persistRegistry).toHaveBeenCalledOnce()
      expect(h.pushSnapshot).toHaveBeenCalledOnce()
      h.sessions.set(OTHER_SID, { pendingCtrl: null })
      expect(await h.call({ sid: OTHER_SID, allow })).toMatchObject({ ok: false, errorKind: 'not_found' })
      expect(h.writes).toHaveBeenCalledOnce()
    })

    it('does not clear a newer prompt when an old answered request is retried', async () => {
      const h = buildTwin(kind)
      await h.call({})
      const next = pending({ command: 'read next.txt' }, 'Bash', 'permission-2')
      h.sessions.get(SID)!.pendingCtrl = next
      expect(await h.call({})).toMatchObject({ ok: true, allow: true })
      expect(h.sessions.get(SID)!.pendingCtrl).toBe(next)
      expect(h.writes).toHaveBeenCalledOnce()
      expect(await h.call({ requestId: next.reqId, allow: false })).toMatchObject({ ok: true, allow: false })
      expect(h.writes).toHaveBeenCalledTimes(2)
      expect(h.sessions.get(SID)!.pendingCtrl).toBeNull()
    })

    it('does not clear a prompt that arrives while the previous answer is being written', async () => {
      const h = buildTwin(kind)
      let release!: (value: 'ok') => void
      const waiting = new Promise<'ok'>((resolve) => { release = resolve })
      h.writes.mockImplementationOnce(() => waiting)
      const reply = h.call({})
      const next = pending({ command: 'read next.txt' }, 'Bash', 'permission-2')
      h.sessions.get(SID)!.pendingCtrl = next
      release('ok')
      expect(await reply).toMatchObject({ ok: true, status: 'resolved', requestId: REQUEST })
      expect(h.sessions.get(SID)!.pendingCtrl).toBe(next)
      expect(h.persistRegistry).not.toHaveBeenCalled()
      expect(h.pushSnapshot).not.toHaveBeenCalled()
      expect(await h.call({})).toMatchObject({ ok: true, allow: true })
      expect(h.writes).toHaveBeenCalledOnce()
    })

    it('rejects malformed retries even when the request was answered before', async () => {
      const h = buildTwin(kind)
      await h.call({})
      expect(await h.call({ allow: 'true' })).toMatchObject({ ok: false, errorKind: 'bad_request' })
      expect(await h.call({ answers: { question: 1 } })).toMatchObject({ ok: false, errorKind: 'bad_request' })
      expect(h.writes).toHaveBeenCalledOnce()
    })

    it('keeps a prompt after a failed FIFO write and resolves it when retried', async () => {
      const prompt = pending()
      const h = buildTwin(kind, prompt)
      h.unavailable()
      expect(await h.call({})).toMatchObject({ ok: false, errorKind: 'not_live' })
      expect(h.sessions.get(SID)!.pendingCtrl).toBe(prompt)
      expect(h.persistRegistry).not.toHaveBeenCalled()
      expect(h.pushSnapshot).not.toHaveBeenCalled()
      h.available()
      expect(await h.call({})).toMatchObject({ ok: true, status: 'resolved' })
      expect(h.writes).toHaveBeenCalledTimes(2)
      expect(h.persistRegistry).toHaveBeenCalledOnce()
      expect(h.sessions.get(SID)!.pendingCtrl).toBeNull()
      expect(await h.call({})).toMatchObject({ ok: true })
      expect(h.writes).toHaveBeenCalledTimes(2)
    })

    it.each(['trusted', 'follower', 'lane'])('refuses a non-bridge %s socket', async (origin) => {
      const prompt = pending()
      const h = buildTwin(kind, prompt)
      const reply = await h.call({}, origin === 'trusted' ? null : origin)
      expect(reply).toMatchObject({ ok: false, errorKind: origin === 'trusted' ? 'refused' : `${origin}_refused` })
      expect(h.writes).not.toHaveBeenCalled()
      expect(h.sessions.get(SID)!.pendingCtrl).toBe(prompt)
    })

    it.each([
      ['empty sid', { sid: '' }], ['traversal sid', { sid: '../session' }],
      ['absolute sid', { sid: '/session' }], ['backslash sid', { sid: 'session\\other' }],
      ['oversized sid', { sid: 'a'.repeat(129) }], ['non-string sid', { sid: 1 }],
      ['null sid', { sid: null }], ['newline sid', { sid: 'session\nother' }],
      ['empty request', { requestId: '' }], ['non-string request', { requestId: 1 }],
      ['missing request', { requestId: undefined }], ['non-boolean allow', { allow: 'true' }],
      ['missing allow', { allow: undefined }], ['null message', { message: null }],
      ['object message', { message: {} }], ['null answers', { answers: null }],
      ['array answers', { answers: [] }], ['numeric answer', { answers: { question: 1 } }],
    ] as const)('rejects malformed %s without writing', async (_label, body) => {
      const prompt = pending()
      const h = buildTwin(kind, prompt)
      expect(await h.call(body)).toMatchObject({ ok: false, errorKind: 'bad_request' })
      expect(h.writes).not.toHaveBeenCalled()
      expect(h.persistRegistry).not.toHaveBeenCalled()
      expect(h.pushSnapshot).not.toHaveBeenCalled()
      expect(h.sessions.get(SID)!.pendingCtrl).toBe(prompt)
    })

    it('does not let an arbitrary raw command reach dispatch over the bridge', async () => {
      const h = buildTwin(kind)
      for (const cmd of ['sendRaw', 'start', 'stop']) {
        expect(await h.call({ cmd, line: 'untrusted input' })).toMatchObject({ ok: false })
      }
      expect(h.run).not.toHaveBeenCalled()
      expect(h.writes).not.toHaveBeenCalled()
    })
  })
}

describe('bridge permission literal parity', () => {
  it('adds the same narrow bridge command and capability in both twins', () => {
    for (const list of ['BRIDGE_ALLOWED_COMMANDS', 'BRIDGE_CAPABILITIES']) {
      expect(literals(sources.standalone, list)).toEqual(literals(sources.source, list))
    }
    for (const src of Object.values(sources)) {
      const allowed = literals(src, 'BRIDGE_ALLOWED_COMMANDS')
      expect(allowed.filter((c) => c === 'session.permission')).toHaveLength(1)
      expect(allowed.filter((c) => c === 'bridgeResume')).toHaveLength(1)
      for (const cmd of ['sendRaw', 'start', 'stop']) expect(allowed).not.toContain(cmd)
      expect(literals(src, 'BRIDGE_CAPABILITIES')).toEqual([
        'bridge-stream-v1', 'send-dedupe-v1', 'send-lost-line-v1', 'session-permission-v1',
      ])
      expect(functionText(src, 'cmdSessionPermission')).toContain("'session.permission: the cloud bridge only'")
      expect(functionText(src, 'cmdSessionPermission')).toContain('if (!isJournalSid(cmd.sid))')
      expect(functionText(src, 'cmdSessionPermission')).toContain(
        "answerPermission(cmd.sid, { requestId: cmd.requestId, allow: cmd.allow, message: cmd.message, answers: cmd.answers }, 'session.permission')",
      )
      expect(functionText(src, 'cmdSessionPermission')).not.toMatch(/cmd\.(line|raw|updatedInput|control_request)/)
      expect(functionText(src, 'dispatchCommand')).toMatch(/case 'session\.permission': return daemonCommands\.run\(/)
      expect(literals(src, 'FOLLOWER_ALLOWED_COMMANDS')).not.toContain('session.permission')
      expect(literals(src, 'LANE_ALLOWED_COMMANDS')).not.toContain('session.permission')
    }
  })

  it('keeps the capability hide gate in both bridge advertisements', () => {
    expect(sources.standalone).toMatch(/BRIDGE_CAPABILITIES = \[[^\n]+\]\.filter\(\(c\) => !BRIDGE_HIDDEN_CAPS\.includes\(c\)\)/)
    expect(sources.source).toMatch(/BRIDGE_CAPABILITIES = \[[^\n]+\]\.filter\(function \(c\) \{\s*return BRIDGE_HIDDEN_CAPS\.indexOf\(c\) === -1;/)
  })
})

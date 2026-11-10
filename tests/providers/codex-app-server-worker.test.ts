/**
 * The ACP worker on the direct Codex path (WALNUT_CODEX_TRANSPORT=app-server):
 * a real AcpWorker and CodexDirectConnection against the scripted app-server in
 * tests/providers/mock-codex-app-server.mjs. Only the Codex binary is mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AcpWorker } from '../../src/providers/acp-worker/worker.js'
import { readJournal } from '../../src/providers/acp-worker/journal.js'
import type { JournalRecord, WorkerStateSnapshot } from '../../src/providers/acp-worker/protocol.js'
import { classifyTurnError } from '../../src/providers/daemon-core.js'
import { CODEX_TRANSPORT_ENV, describeResumeFailure, resolveCodexTransport } from '../../src/providers/codex-app-server/transport.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_CODEX = path.join(__dirname, 'mock-codex-app-server.mjs')
const MOCK_ACP = path.join(__dirname, 'mock-acp-agent.mjs')

let tmpDir: string
let workers: AcpWorker[]
let gone: string[]
let reqId = 0

const journalPath = () => path.join(tmpDir, 'session.acp.jsonl')
const logPath = () => path.join(tmpDir, 'codex-requests.jsonl')

type Logged = { pid: number; kind: string; method?: string; params?: Record<string, unknown>; argv?: string[]; answer?: Record<string, unknown> }
function codexLog(): Logged[] {
  try { return fs.readFileSync(logPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const requests = (method: string) => codexLog().filter((e) => e.kind === 'request' && e.method === method)

async function op(w: AcpWorker, name: string, params?: Record<string, unknown>) {
  return w.handle({ id: ++reqId, op: name as never, params })
}

function directEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CODEX_PATH: MOCK_CODEX,
    CODEX_HOME: path.join(tmpDir, 'codex-home'),
    MOCK_CODEX_LOG: logPath(),
    [CODEX_TRANSPORT_ENV]: 'app-server',
    ...extra,
  }
}

async function startWorker(extra: Record<string, string> = {}): Promise<AcpWorker> {
  const w = new AcpWorker(journalPath(), () => {}, () => {}, () => gone.push('adapter-gone'))
  workers.push(w)
  const init = await op(w, 'initialize', { adapterCommand: ['/nonexistent/codex-acp'], cwd: tmpDir, env: directEnv(extra) })
  expect(init.ok, JSON.stringify(init)).toBe(true)
  return w
}

async function startSession(extra: Record<string, string> = {}): Promise<{ w: AcpWorker; threadId: string }> {
  const w = await startWorker(extra)
  const ns = await op(w, 'newSession', { cwd: tmpDir })
  expect(ns.ok, JSON.stringify(ns)).toBe(true)
  return { w, threadId: (ns.result as { sessionId: string }).sessionId }
}

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const records = (): JournalRecord[] => readJournal(journalPath()).records.map((r) => r.record)
const metas = (recs = records()) =>
  recs.filter((r): r is Extract<JournalRecord, { kind: 'meta' }> => r.kind === 'meta').map((r) => r.event as Record<string, unknown> & { type: string })
const updates = (recs = records()) => recs
  .filter((r) => r.kind === 'acp' && (r.frame as { method?: string }).method === 'session/update')
  .map((r) => (r.frame as { params: { update: Record<string, unknown> } }).params.update)
const agentText = (recs = records()) => updates(recs)
  .filter((u) => u.sessionUpdate === 'agent_message_chunk')
  .map((u) => (u.content as { text: string }).text).join('')
const ended = (commandId: string) => (recs: JournalRecord[]) =>
  metas(recs).some((e) => (e.type === 'turn-ended' || e.type === 'turn-interrupted') && e.commandId === commandId)
const waitTurn = (commandId: string, timeoutMs?: number) => waitFor(records, ended(commandId), `turn ${commandId}`, timeoutMs)
const errorRows = () => metas().filter((e) => e.type === 'error')

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-direct-'))
  fs.mkdirSync(path.join(tmpDir, 'codex-home'))
  workers = []
  gone = []
})

afterEach(async () => {
  for (const w of workers) await op(w, 'shutdown').catch(() => {})
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('direct Codex: start and a plain turn', () => {
  it('starts app-server itself, offers inject-only steering and a graceful stop, and journals a turn as before', async () => {
    const w = await startWorker()
    const spawn = codexLog().find((e) => e.kind === 'spawn')
    expect(spawn?.argv?.at(-1)).toBe('app-server')
    await waitFor(codexLog, (l) => l.some((e) => e.kind === 'notification' && e.method === 'initialized'), 'initialized')

    const state = (await op(w, 'getState')).result as WorkerStateSnapshot
    expect(state.capabilities?.steering).toBe(true)
    expect(state.capabilities?.steeringInjectOnly).toBe(true)
    expect(state.adapterPid).toBe(spawn?.pid)

    const ns = await op(w, 'newSession', { cwd: tmpDir })
    const session = ns.result as { sessionId: string; models: { currentModelId: string; availableModels: unknown[] }; modes: { currentModeId: string } }
    expect(session.models.currentModelId).toBe('gpt-mock[medium]')
    expect(session.models.availableModels.length).toBeGreaterThan(0)
    const start = requests('thread/start')[0].params!
    expect((start.config as { projects: Record<string, { trust_level: string }> }).projects[tmpDir].trust_level).toBe('trusted')

    expect((await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'hello there' })).ok).toBe(true)
    await waitTurn('c1')
    expect(agentText()).toContain('echo: hello there')
    const end = metas().find((e) => e.type === 'turn-ended' && e.commandId === 'c1')!
    expect(end.stopReason).toBe('end_turn')
    // Input net of the cached part, as the adapter reported it.
    expect(end.usage).toMatchObject({ totalTokens: 120, inputTokens: 60, cachedReadTokens: 40, outputTokens: 20 })
    expect(updates().some((u) => u.sessionUpdate === 'usage_update' && u.size === 200000)).toBe(true)
    // Every turn carries the session's approval and sandbox policy.
    const turnStart = requests('turn/start')[0].params!
    expect(turnStart.approvalPolicy).toBeDefined()
    expect(turnStart.sandboxPolicy).toBeDefined()
  })

  it('names nothing the session did not pick: provider, model, effort and the rest come from the host\'s Codex config', async () => {
    const { w } = await startSession()
    expect(requests('thread/start')[0].params!.modelProvider).toBeUndefined()
    expect(codexLog().find((e) => e.kind === 'spawn')?.argv).toEqual(['app-server'])
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'hi' })
    await waitTurn('c1')
    const first = requests('turn/start')[0].params!
    for (const key of ['model', 'effort', 'summary', 'serviceTier', 'personality', 'cwd']) expect(first[key], key).toBeUndefined()
    // A pick names the model and effort from the next turn on.
    expect((await op(w, 'setConfigOption', { commandId: 'k1', configId: 'model', value: 'gpt-mock-mini' })).ok).toBe(true)
    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'again' })
    await waitTurn('c2')
    expect(requests('turn/start')[1].params).toMatchObject({ model: 'gpt-mock-mini', effort: 'low' })
  })

  it('a provider Walnut was given (engines.codex.provider) goes on the app-server and on the thread', async () => {
    const config = { model_provider: 'walnut-provider', model_providers: { 'walnut-provider': { name: 'walnut-provider', base_url: 'http://127.0.0.1:9/v1', wire_api: 'responses', requires_openai_auth: false } } }
    await startSession({ CODEX_CONFIG: JSON.stringify(config) })
    const argv = codexLog().find((e) => e.kind === 'spawn')!.argv!
    expect(argv.join(' ')).toContain('model_provider="walnut-provider"')
    expect(argv.at(-1)).toBe('app-server')
    expect(requests('thread/start')[0].params!.modelProvider).toBe('walnut-provider')
  })

  it('full access sends approval never and a full sandbox on every turn', async () => {
    const { w } = await startSession({ INITIAL_AGENT_MODE: 'agent-full-access' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'hi' })
    await waitTurn('c1')
    const p = requests('turn/start')[0].params!
    expect(p.approvalPolicy).toBe('never')
    expect(p.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  })

  it('maps a command item to the terminal tool card the adapter sent', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'CMD' })
    await waitTurn('c1')
    const call = updates().find((u) => u.sessionUpdate === 'tool_call')!
    expect(call).toMatchObject({ kind: 'execute', title: 'echo hi', status: 'in_progress' })
    const done = updates().filter((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === call.toolCallId)
    expect(done.some((u) => u.status === 'completed')).toBe(true)
  })
})

describe('direct Codex: steering', () => {
  it('a steer joins the live turn by its id, once', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'SLOW 1500' })
    await waitFor(() => requests('turn/start'), (r) => r.length === 1, 'turn start')
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
    const st = await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'also this' })
    expect(st.ok, JSON.stringify(st)).toBe(true)
    await waitTurn('c1')
    const steer = requests('turn/steer')
    expect(steer).toHaveLength(1)
    expect(steer[0].params!.expectedTurnId).toMatch(/^turn_/)
    expect(agentText().match(/\[steered: also this\]/g)).toHaveLength(1)
    // Answered in the turn: no follow-up turn repeats it.
    expect(requests('turn/start')).toHaveLength(1)
    expect(metas().filter((e) => e.type === 'steer-accepted' && e.walnutMessageId === 'm2')).toHaveLength(1)
    expect(errorRows()).toHaveLength(0)
  })

  it('several steers in a row each land once, in order', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'SLOW 2000' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
    const results = await Promise.all(['one', 'two', 'three'].map((text, i) =>
      op(w, 'steer', { commandId: `s${i}`, walnutMessageId: `ms${i}`, text })))
    expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true)
    await waitTurn('c1')
    const text = agentText()
    for (const word of ['one', 'two', 'three']) expect(text.match(new RegExp(`\\[steered: ${word}\\]`, 'g'))).toHaveLength(1)
    expect(text.indexOf('[steered: one]')).toBeLessThan(text.indexOf('[steered: three]'))
    expect(requests('turn/start')).toHaveLength(1)
    expect(errorRows()).toHaveLength(0)
  })

  for (const kind of ['RACE', 'RACE_LATE'] as const) {
    it(`a steer that meets the turn's end (${kind}) is handed back to the caller, with no error row and no turn of its own`, async () => {
      const { w } = await startSession()
      await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: kind })
      await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
      const st = await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'late words' })
      expect(st.ok).toBe(false)
      expect(st.error?.kind).toBe('steer_race')
      await waitTurn('c1')
      expect(metas().find((e) => e.type === 'turn-ended' && e.commandId === 'c1')?.stopReason).toBe('end_turn')
      // Codex was never asked to start a turn for the steer: the caller's queue sends it, with its id.
      expect(requests('turn/start')).toHaveLength(1)
      expect(metas().some((e) => e.type === 'steer-accepted')).toBe(false)
      expect(errorRows()).toHaveLength(0)
      // ...and the next prompt is that message, delivered once.
      const again = await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'late words' })
      expect(again.ok, JSON.stringify(again)).toBe(true)
      await waitTurn('c2')
      expect(agentText().match(/echo: late words/g)).toHaveLength(1)
    })
  }

  it('late events of an ended turn never land in the next one', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'GHOST' })
    await waitTurn('c1')
    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'second' })
    await waitTurn('c2')
    expect(agentText()).toContain('echo: second')
    expect(agentText()).not.toContain('GHOST TEXT')
    expect(metas().find((e) => e.type === 'turn-ended' && e.commandId === 'c2')?.usage).toMatchObject({ totalTokens: 120 })
  })

  for (const timeout of ['200', '']) {
    it(`a steer Codex took stays taken when its answer comes after the turn ended${timeout ? ' and past its deadline' : ''}`, async () => {
      // With a deadline, the answer never comes in time (a lost answer); without, it is only late.
      const { w } = await startSession(timeout ? { WALNUT_CODEX_STEER_TIMEOUT_MS: timeout, MOCK_STEER_ACK_MS: '60000' } : {})
      await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'SLOW_ACK' })
      await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
      const st = await Promise.race([
        op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'taken words' }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('steer did not settle in 5 s')), 5000)),
      ])
      // Handed back, the caller's queue would send these words again as a turn of their own.
      expect(st.ok, JSON.stringify(st)).toBe(true)
      await waitTurn('c1')
      expect(metas().filter((e) => e.type === 'steer-accepted' && e.walnutMessageId === 'm2')).toHaveLength(1)
      expect(requests('turn/start')).toHaveLength(1)
      expect(errorRows()).toHaveLength(0)
    })
  }

  it('a steer is recorded when Codex reports it, before its late answer and before what answers it', async () => {
    const { w } = await startSession({ MOCK_FINAL_STEER_ACK_MS: '3000' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'STEER_AFTER_FINAL' })
    await waitFor(() => agentText(), (t) => t.includes('ok'), 'first answer')
    const t0 = Date.now()
    expect((await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'taken words' })).ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2000)
    await waitTurn('c1')
    const recs = records()
    const accepted = recs.findIndex((r) => r.kind === 'meta' && r.event.type === 'steer-accepted' && r.event.walnutMessageId === 'm2')
    const answer = recs.findIndex((r) => r.kind === 'acp' && JSON.stringify(r.frame).includes('echo: taken words'))
    expect(accepted).toBeGreaterThan(-1)
    expect(answer).toBeGreaterThan(accepted)
  })

  it('a steer is proved by its own client id: the same words reported later as the turn\'s own input are not a second steer', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'HOLD_OWN' })
    await waitFor(() => agentText(), (t) => t.includes('working'), 'turn running')
    expect((await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'HOLD_OWN' })).ok).toBe(true)
    await waitTurn('c1')
    // The steer was answered in the turn; the late report of the turn's own input asks nothing more.
    expect(requests('turn/start')).toHaveLength(1)
    expect(requests('turn/steer')[0].params!.clientUserMessageId).toMatch(/^walnut-/)
    expect(metas().filter((e) => e.type === 'steer-accepted' && e.walnutMessageId === 'm2')).toHaveLength(1)
    // The report and its answer arrive back to back: the person's line is still recorded first.
    const recs = records()
    const accepted = recs.findIndex((r) => r.kind === 'meta' && r.event.type === 'steer-accepted')
    const answer = recs.findIndex((r) => r.kind === 'acp' && JSON.stringify(r.frame).includes('[steered: HOLD_OWN]'))
    expect(accepted).toBeGreaterThan(-1)
    expect(answer).toBeGreaterThan(accepted)
  })

  it('a refused steer is not taken because the turn\'s own input has the same words', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'REJECT_SAME' })
    await waitFor(() => agentText(), (t) => t.includes('working'), 'turn running')
    const st = await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'REJECT_SAME' })
    // Handed back: the caller's queue sends it as the next turn, so nothing is lost.
    expect(st.ok).toBe(false)
    expect(st.error?.kind).toBe('steer_race')
    expect(metas().some((e) => e.type === 'steer-accepted' && e.walnutMessageId === 'm2')).toBe(false)
  })

  it('a Codex that reports no client id is still read by the words', async () => {
    const { w } = await startSession({ MOCK_NO_CLIENT_ID: '1' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'STEER_AFTER_FINAL' })
    await waitFor(() => agentText(), (t) => t.includes('ok'), 'first answer')
    expect((await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'late words' })).ok).toBe(true)
    await waitTurn('c1')
    expect(requests('turn/start')).toHaveLength(2)
    expect(agentText().match(/echo: late words/g)).toHaveLength(1)
  })

  it('a stop that meets the turn\'s end ends it there: no follow-up turn, no forced stop', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'STOP_RACE_FINAL' })
    await waitFor(() => agentText(), (t) => t.includes('ok'), 'first answer')
    expect((await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'more words' })).ok).toBe(true)
    const stop = await op(w, 'cancel', { commandId: 'x1' })
    expect((stop.result as { turnClosed?: boolean } | undefined)?.turnClosed ?? true, JSON.stringify(stop)).not.toBe(false)
    await waitTurn('c1')
    expect(requests('turn/start')).toHaveLength(1)
    expect(agentText()).not.toContain('echo: more words')
    // The steer Codex took is named, never dropped in silence.
    expect(agentText()).toContain('The turn stopped before Codex answered: "more words". Send it again to ask once more.')
  })

  it('a message sent while a stop is on its way is not steered into the stopping turn', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'DEAF' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
    const stop = op(w, 'cancel', { commandId: 'x1' })
    await waitFor(() => requests('turn/interrupt'), (r) => r.length > 0, 'interrupt sent')
    const st = await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'after stop' })
    // Handed back: the caller's queue sends it as the next turn.
    expect(st.ok).toBe(false)
    expect(st.error?.kind).toBe('steer_race')
    expect(requests('turn/steer')).toHaveLength(0)
    await stop
  })

  it('a steer left unanswered past the follow-up limit is named in the chat, never dropped in silence', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'STEER_AFTER_FINAL' })
    for (let i = 1; i <= 3; i++) {
      await waitFor(() => agentText(), (t) => (t.match(/ok/g) ?? []).length >= i, `answer ${i}`)
      // Each follow-up runs these words as STEER_AFTER_FINAL again, so Codex leaves each steer unanswered.
      expect((await op(w, 'steer', { commandId: `s${i}`, walnutMessageId: `ms${i}`, text: 'STEER_AFTER_FINAL' })).ok).toBe(true)
    }
    await waitTurn('c1', 10_000)
    expect(requests('turn/start')).toHaveLength(3)
    expect(agentText()).toContain('Codex ended its turn without answering: "STEER_AFTER_FINAL". Send it again to ask once more.')
    expect(metas().filter((e) => e.type === 'turn-ended' && e.commandId === 'c1')).toHaveLength(1)
  })

  it('a warning Codex repeats each turn is shown once per session', async () => {
    const { w } = await startSession()
    for (const n of [1, 2]) {
      await op(w, 'prompt', { commandId: `c${n}`, walnutMessageId: `m${n}`, text: 'WARN' })
      await waitTurn(`c${n}`)
    }
    expect(agentText().match(/Warning: Model metadata/g)).toHaveLength(1)
  })

  it('a steer Codex took after its last word and left unanswered is answered in the same turn, once', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'STEER_AFTER_FINAL' })
    await waitFor(() => agentText(), (t) => t.includes('ok'), 'first answer')
    const st = await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'late words' })
    expect(st.ok, JSON.stringify(st)).toBe(true)
    await waitTurn('c1')
    // Codex ended its turn without answering; the same Walnut turn went on with those words.
    const starts = requests('turn/start')
    expect(starts).toHaveLength(2)
    expect((starts[1].params!.input as Array<{ text: string }>)[0].text).toBe('late words')
    expect(agentText().match(/echo: late words/g)).toHaveLength(1)
    expect(metas().filter((e) => e.type === 'turn-ended' && e.commandId === 'c1')).toHaveLength(1)
    expect(metas().filter((e) => e.type === 'steer-accepted' && e.walnutMessageId === 'm2')).toHaveLength(1)
    expect(errorRows()).toHaveLength(0)
  })

  it('a late answer to the first start never takes the follow-up turn\'s place', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'LATE_ACK_FINAL' })
    await waitFor(() => agentText(), (t) => t.includes('ok'), 'first answer')
    // The follow-up runs 800 ms, so the first start's answer (400 ms) comes while it runs.
    expect((await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'SLOW 800' })).ok).toBe(true)
    await waitTurn('c1', 5000)
    expect(requests('turn/start')).toHaveLength(2)
    expect(metas().filter((e) => e.type === 'turn-ended' && e.commandId === 'c1')).toHaveLength(1)
  })

  it('a turn Codex will not steer hands the text back, with no error row', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'NOT_STEERABLE' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
    const st = await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'x' })
    expect(st.error?.kind).toBe('steer_race')
    expect(errorRows()).toHaveLength(0)
    await op(w, 'cancel', { commandId: 'x1' })
    await waitTurn('c1')
  })

  it('a steer with no live turn is refused before Codex is asked', async () => {
    const { w } = await startSession()
    const st = await op(w, 'steer', { commandId: 's1', walnutMessageId: 'm2', text: 'x' })
    expect(st.error?.kind).toBe('no_turn')
    expect(requests('turn/steer')).toHaveLength(0)
    expect(errorRows()).toHaveLength(0)
  })
})

describe('direct Codex: stop', () => {
  it('a stop interrupts the turn and keeps the app-server; the next message runs at once', async () => {
    const { w } = await startSession()
    const pid = ((await op(w, 'getState')).result as WorkerStateSnapshot).adapterPid
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'SLOW 20000' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
    const t0 = Date.now()
    const cancel = await op(w, 'cancel', { commandId: 'x1' })
    expect(cancel.result).toMatchObject({ cancelled: true, turnClosed: true })
    expect(Date.now() - t0).toBeLessThan(3000)
    await waitTurn('c1')
    expect(metas().find((e) => e.type === 'turn-ended' && e.commandId === 'c1')?.stopReason).toBe('cancelled')
    expect(requests('turn/interrupt')).toHaveLength(1)
    expect(requests('thread/backgroundTerminals/list')).toHaveLength(1)

    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'right after' })
    await waitTurn('c2')
    expect(agentText()).toContain('echo: right after')
    expect(((await op(w, 'getState')).result as WorkerStateSnapshot).adapterPid).toBe(pid)
    expect(codexLog().filter((e) => e.kind === 'spawn')).toHaveLength(1)
    expect(errorRows()).toHaveLength(0)
  })

  it('a turn Codex does not end within the bound reports turnClosed false (the daemon then tears it down)', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'DEAF' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'turn-started'), 'turn started')
    const cancel = await op(w, 'cancel', { commandId: 'x1' })
    expect(cancel.result).toMatchObject({ cancelled: true, turnClosed: false })
  }, 20_000)
})

describe('direct Codex: failures', () => {
  it('an app-server that dies mid-turn is a runtime error at once, and the worker goes', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'DIE' })
    await waitTurn('c1')
    const err = errorRows().find((e) => e.commandId === 'c1')
    expect(err?.errorKind).toBe('app_server_exited')
    expect(classifyTurnError(`${err?.errorKind}: ${err?.message}`)).toBe('retryable')
    await waitFor(() => gone, (g) => g.length > 0, 'adapter gone')
    void w
  })

  it('an app-server killed while idle is seen at once', async () => {
    const { w } = await startSession()
    const pid = ((await op(w, 'getState')).result as WorkerStateSnapshot).adapterPid!
    expect(pid).toBeGreaterThan(1)
    process.kill(pid, 'SIGKILL')
    await waitFor(() => gone, (g) => g.length > 0, 'adapter gone', 3000)
    expect(metas().some((e) => e.type === 'turn-interrupted')).toBe(false)
  })

  const failures: Array<[string, string, 'retryable' | 'terminal']> = [
    ['USAGE_LIMIT', 'usage_limit', 'terminal'],
    ['RATE_LIMIT', 'rate_limited', 'retryable'],
    ['OVERLOADED', 'overloaded', 'retryable'],
    ['HTTP_502', 'server_error', 'retryable'],
  ]
  for (const [word, kind, retry] of failures) {
    it(`a ${word} turn is a ${kind} row, read as ${retry}`, async () => {
      const { w } = await startSession()
      await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: word })
      await waitTurn('c1')
      const err = errorRows().find((e) => e.commandId === 'c1')
      expect(err?.errorKind).toBe(kind)
      expect(classifyTurnError(`${err?.errorKind}: ${err?.message}`)).toBe(retry)
      if (kind === 'usage_limit') {
        // Read for the auto-continue after the limit (session-auto-continue.ts): Codex's own words
        // in the transcript, as the adapter wrote them, and the reset on the row.
        expect(agentText()).toContain("You've hit your usage limit")
        // Its own block: the reply's last words ("working") do not run into it.
        const chunk = updates().find((u) => u.sessionUpdate === 'agent_message_chunk' && String((u.content as { text: string }).text).startsWith("You've hit"))
        expect(String(chunk?.messageId)).toMatch(/^codex-error:/)
        expect(Number(err?.resetsAt)).toBeGreaterThan(Date.now() + 2.9 * 3600_000)
      }
      // The session lives on: the next turn runs on the same app-server.
      await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'after' })
      await waitTurn('c2')
      expect(agentText()).toContain('echo: after')
    })
  }

  it('a turn that goes quiet is stopped by the watchdog and interrupted at Codex', async () => {
    const { w } = await startSession({ WALNUT_CODEX_STALL_MS: '400' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'HANG' })
    await waitTurn('c1', 5000)
    const err = errorRows().find((e) => e.commandId === 'c1')
    expect(err?.errorKind).toBe('turn_stalled')
    expect(classifyTurnError(`${err?.errorKind}: ${err?.message}`)).toBe('retryable')
    // The next message, sent at once, waits for Codex to end that turn instead of meeting it.
    const next = await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'after the stall' })
    expect(next.ok, JSON.stringify(next)).toBe(true)
    await waitTurn('c2')
    expect(agentText()).toContain('echo: after the stall')
    expect(requests('turn/interrupt')).toHaveLength(1)
  })

  it('a stalled turn Codex does not end after an answered interrupt is ended with its process', async () => {
    const { w } = await startSession({ WALNUT_CODEX_STALL_MS: '400' })
    const pid = ((await op(w, 'getState')).result as WorkerStateSnapshot).adapterPid!
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'HANG_DEAF' })
    await waitTurn('c1', 5000)
    await waitFor(() => requests('turn/interrupt'), (r) => r.length === 1, 'interrupt')
    // Codex still runs that turn and would refuse every next one: the process goes, so the
    // next message starts a fresh app-server instead of meeting "a turn is already running".
    await waitFor(() => gone, (g) => g.length > 0, 'adapter gone', 15_000)
    await waitFor(() => { try { process.kill(pid, 0); return true } catch { return false } }, (a) => !a, 'app-server exit', 3000)
  }, 25_000)

  it('refuses a Codex older than the supported range in words that name the way back', async () => {
    const w = new AcpWorker(journalPath())
    workers.push(w)
    const init = await op(w, 'initialize', { adapterCommand: ['/nonexistent'], cwd: tmpDir, env: directEnv({ MOCK_CODEX_VERSION: '0.120.3' }) })
    expect(init.ok).toBe(false)
    expect(init.error?.kind).toBe('provider_incompatible')
    expect(init.error?.message).toContain('0.120.3')
    expect(init.error?.message).toContain('transport')
  })

  it('a missing Codex binary is provider_missing', async () => {
    const w = new AcpWorker(journalPath())
    workers.push(w)
    const init = await op(w, 'initialize', { adapterCommand: ['/nonexistent'], cwd: tmpDir, env: directEnv({ CODEX_PATH: path.join(tmpDir, 'no-codex') }) })
    expect(init.ok).toBe(false)
    expect(['provider_missing', 'provider_incompatible', 'adapter_spawn_failed']).toContain(init.error?.kind)
  })
})

describe('direct Codex: approvals', () => {
  async function ask(text: string, optionId: string | null) {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'permission-requested'), 'permission request')
    const pending = ((await op(w, 'getState')).result as WorkerStateSnapshot).pendingPermissions[0]
    const resp = await op(w, 'permissionResponse', { commandId: 'p1', providerRequestId: pending.providerRequestId, optionId })
    expect(resp.ok).toBe(true)
    await waitTurn('c1')
    const answer = codexLog().find((e) => e.kind === 'approval-answer')?.answer
    return { pending, answer, w }
  }

  it('a command approval offers the adapter\'s options and approve sends accept', async () => {
    const { pending, answer } = await ask('ASK_CMD', 'allow_once')
    const ids = (pending.options as Array<{ optionId: string }>).map((o) => o.optionId)
    expect(ids).toEqual(['allow_once', 'allow_always', 'reject_once'])
    expect(answer).toEqual({ decision: 'accept' })
    expect(agentText()).toContain('decision: "accept"')
  })

  it('reject sends decline', async () => {
    const { answer } = await ask('ASK_CMD', 'reject_once')
    expect(answer).toEqual({ decision: 'decline' })
  })

  it('allow for the session sends acceptForSession on a file change', async () => {
    const { answer } = await ask('ASK_FILE', 'allow_always')
    expect(answer).toEqual({ decision: 'acceptForSession' })
  })

  it('an MCP tool approval is marked as one and keeps its persist choice', async () => {
    const { pending, answer } = await ask('ASK_MCP', 'allow_session')
    const request = records().find((r) => r.kind === 'acp' && (r.frame as { method?: string }).method === 'session/request_permission')
    expect(JSON.stringify(request)).toContain('is_mcp_tool_approval')
    expect((pending.options as Array<{ optionId: string }>).map((o) => o.optionId)).toEqual(['allow_once', 'allow_session', 'allow_always', 'decline'])
    expect(answer).toEqual({ action: 'accept', content: null, _meta: { persist: 'session' } })
  })

  it('a stop while an approval is open answers it cancelled and ends the turn', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'ASK_CMD' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'permission-requested'), 'permission request')
    const cancel = await op(w, 'cancel', { commandId: 'x1' })
    expect(cancel.ok).toBe(true)
    await waitTurn('c1')
    expect(metas().some((e) => e.type === 'permission-auto-cancelled')).toBe(true)
    await waitFor(codexLog, (l) => l.some((e) => e.kind === 'approval-answer'), 'answer')
    expect(codexLog().find((e) => e.kind === 'approval-answer')?.answer).toEqual({ decision: 'cancel' })
  })
})

describe('direct Codex: resume', () => {
  it('a new worker (a daemon restart) rejoins the thread by id, without its history', async () => {
    const first = await startSession()
    await op(first.w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'remember me' })
    await waitTurn('c1')
    await op(first.w, 'shutdown')

    const w2 = await startWorker()
    const ls = await op(w2, 'loadSession', { providerSessionId: first.threadId, cwd: tmpDir })
    expect(ls.ok, JSON.stringify(ls)).toBe(true)
    expect((ls.result as { sessionId: string }).sessionId).toBe(first.threadId)
    const resume = requests('thread/resume')[0].params!
    expect(resume.threadId).toBe(first.threadId)
    expect(resume.excludeTurns).toBe(true)
    // The resumed thread's own effort is the session's.
    expect((ls.result as { models: { currentModelId: string } }).models.currentModelId).toBe('gpt-mock[high]')
    await op(w2, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'again' })
    await waitTurn('c2')
    expect(requests('turn/start').at(-1)!.params!.threadId).toBe(first.threadId)
  })

  it('the oldest supported Codex is sent excludeTurns too (experimental there; initialize opts in)', async () => {
    const first = await startSession({ MOCK_CODEX_VERSION: '0.144.6' })
    await op(first.w, 'shutdown')
    const w2 = await startWorker({ MOCK_CODEX_VERSION: '0.144.6' })
    expect((await op(w2, 'loadSession', { providerSessionId: first.threadId, cwd: tmpDir })).ok).toBe(true)
    expect(requests('thread/resume')[0].params!.excludeTurns).toBe(true)
    expect(requests('initialize')[0].params!.capabilities).toMatchObject({ experimentalApi: true })
  })

  it('a thread Codex has no copy of fails the load with the reason journaled, and no error row', async () => {
    const w = await startWorker()
    const ls = await op(w, 'loadSession', { providerSessionId: '019a0000-0000-7000-8000-000000000000', cwd: tmpDir })
    expect(ls.ok).toBe(false)
    expect(ls.error?.kind).toBe('load_failed')
    const failed = metas().find((e) => e.type === 'resume-failed')
    expect(failed?.providerSessionId).toBe('019a0000-0000-7000-8000-000000000000')
    expect(String(failed?.reason)).toContain('no saved copy of it on this host (no rollout found')
    expect(errorRows()).toHaveLength(0)
    // The caller's fallback: a fresh thread on the same worker.
    expect((await op(w, 'newSession', { cwd: tmpDir })).ok).toBe(true)
  })

  it('a thread Codex has but cannot read fails the start and keeps its id: no new thread replaces it', async () => {
    const w = await startWorker()
    const ls = await op(w, 'loadSession', { providerSessionId: '019a0000-0000-7000-8000-0000locked', cwd: tmpDir })
    expect(ls.ok).toBe(false)
    expect(ls.error?.kind).not.toBe('load_failed')
    expect(ls.error?.message).toContain('Permission denied')
    expect(ls.error?.message).toContain('The next message tries again; after 2 more failures in a row Walnut starts a new conversation')
    expect(metas().some((e) => e.type === 'resume-failed')).toBe(false)
  })

  it('a resume failure counts only the run of its own reason at the end (B, A, B, B gives up on none)', async () => {
    const id = '019a0000-0000-7000-8000-0000locked'
    const load = async () => {
      const w = await startWorker()
      const kind = (await op(w, 'loadSession', { providerSessionId: id, cwd: tmpDir })).error?.kind
      await op(w, 'shutdown')
      return kind
    }
    const kinds = [await load()]
    // Another reason in between breaks the run.
    fs.appendFileSync(journalPath(), JSON.stringify({ kind: 'meta', ts: Date.now(), event: { type: 'resume-error', providerSessionId: id, reason: 'some other reason' } }) + '\n')
    kinds.push(await load(), await load())
    expect(kinds.every((k) => k !== 'load_failed')).toBe(true)
    expect(metas().some((e) => e.type === 'resume-failed')).toBe(false)
  })

  it('the third failure in a row of a thread Codex cannot read moves on to a new thread, naming the old one', async () => {
    const id = '019a0000-0000-7000-8000-0000locked'
    const kinds: Array<string | undefined> = []
    for (let i = 0; i < 3; i++) {
      const w = await startWorker()
      kinds.push((await op(w, 'loadSession', { providerSessionId: id, cwd: tmpDir })).error?.kind)
      await op(w, 'shutdown')
    }
    expect(kinds.slice(0, 2).every((k) => k !== 'load_failed')).toBe(true)
    expect(kinds[2]).toBe('load_failed')
    const failed = metas().filter((e) => e.type === 'resume-failed')
    expect(failed).toHaveLength(1)
    expect(String(failed[0].reason)).toMatch(/Permission denied.*3 times in a row.*thread 019a0000-0000-7000-8000-0000locked/)
  })
})

describe('direct Codex: plan mode and commands', () => {
  it('plan mode rides each turn, and an approved plan leaves it and is implemented in the same turn', async () => {
    const { w } = await startSession()
    expect((await op(w, 'setConfigOption', { commandId: 'k1', configId: 'collaboration_mode', value: 'plan' })).ok).toBe(true)
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'PLAN' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'permission-requested'), 'plan question')
    const pending = ((await op(w, 'getState')).result as WorkerStateSnapshot).pendingPermissions[0]
    expect((pending.options as Array<{ optionId: string }>).map((o) => o.optionId)).toEqual(['implement_plan', 'revise_plan'])
    expect((await op(w, 'permissionResponse', { commandId: 'p1', providerRequestId: pending.providerRequestId, optionId: 'implement_plan' })).ok).toBe(true)
    await waitTurn('c1')
    const starts = requests('turn/start')
    expect(starts).toHaveLength(2)
    expect((starts[0].params!.collaborationMode as { mode: string }).mode).toBe('plan')
    expect((starts[0].params!.collaborationMode as { settings: { model: string } }).settings.model).toBe('gpt-mock')
    expect((starts[1].params!.input as Array<{ text: string }>)[0].text).toBe('Implement the approved plan.')
    expect((starts[1].params!.collaborationMode as { mode: string }).mode).toBe('default')
    expect(agentText()).toContain('echo: Implement the approved plan.')
    // The worker's snapshot (what a reattaching server reads) left plan mode too.
    expect(((await op(w, 'getState')).result as WorkerStateSnapshot).configOptions?.find((o) => o.id === 'collaboration_mode')?.currentValue).toBe('default')
    expect(errorRows()).toHaveLength(0)
  })

  it('a plan kept in plan mode ends the turn there; a stop withdraws the question', async () => {
    const { w } = await startSession()
    await op(w, 'setConfigOption', { commandId: 'k1', configId: 'collaboration_mode', value: 'plan' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'PLAN' })
    await waitFor(records, (r) => metas(r).some((e) => e.type === 'permission-requested'), 'plan question')
    const stop = await op(w, 'cancel', { commandId: 'x1' })
    expect(stop.ok, JSON.stringify(stop)).toBe(true)
    await waitTurn('c1')
    expect(requests('turn/start')).toHaveLength(1)
    expect(requests('turn/interrupt')).toHaveLength(0)
    const recs = records()
    const closed = recs.findIndex((r) => r.kind === 'acp' && (r.frame as { params?: { update?: Record<string, unknown> } })?.params?.update?.rawOutput === 'Stopped before an answer.')
    const end = recs.findIndex((r) => r.kind === 'meta' && (r.event.type === 'turn-ended' || r.event.type === 'turn-interrupted') && r.event.commandId === 'c1')
    expect(closed).toBeGreaterThan(-1)
    expect(closed).toBeLessThan(end)
    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'next' })
    await waitTurn('c2')
    expect((requests('turn/start')[1].params!.collaborationMode as { mode: string }).mode).toBe('plan')
  })

  it('without plan mode set, a turn names no collaboration mode (Codex keeps its own)', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'hi' })
    await waitTurn('c1')
    expect(requests('turn/start')[0].params!.collaborationMode).toBeUndefined()
  })

  it('/compact runs Codex\'s compaction, not a message to the model', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: '/compact' })
    await waitTurn('c1')
    expect(requests('thread/compact/start')).toHaveLength(1)
    expect(requests('turn/start')).toHaveLength(0)
    expect(updates().some((u) => u.sessionUpdate === 'tool_call' && u.title === 'Compact conversation')).toBe(true)
    expect(errorRows()).toHaveLength(0)
  })

  it('/review runs a review turn, and its child turn\'s events are the turn\'s', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: '/review check the error paths' })
    await waitTurn('c1')
    expect(requests('review/start')[0].params).toMatchObject({ target: { type: 'custom', instructions: 'check the error paths' }, delivery: 'inline' })
    expect(agentText()).toContain('review: check the error paths')
    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: '/review-branch main' })
    await waitTurn('c2')
    expect(requests('review/start')[1].params!.target).toEqual({ type: 'baseBranch', branch: 'main' })
  })

  it('/plan, /mcp, /skills, /status and /goal answer in the chat without a Codex turn', async () => {
    const { w } = await startSession()
    const run = async (n: number, text: string) => { await op(w, 'prompt', { commandId: `c${n}`, walnutMessageId: `m${n}`, text }); await waitTurn(`c${n}`) }
    await run(1, '/plan')
    expect(((await op(w, 'getState')).result as WorkerStateSnapshot).configOptions?.find((o) => o.id === 'collaboration_mode')?.currentValue).toBe('plan')
    expect(updates().some((u) => u.sessionUpdate === 'config_option_update'
      && (u.configOptions as Array<{ id: string; currentValue: string }>).some((o) => o.id === 'collaboration_mode' && o.currentValue === 'plan'))).toBe(true)
    await run(2, '/mcp')
    expect(agentText()).toContain('- own_server: 2 tools, 0 resources')
    await run(3, '/skills')
    expect(agentText()).toContain('- mock-skill: A mock skill')
    await run(4, '/status')
    expect(agentText()).toContain('Collaboration mode: plan')
    await run(5, '/goal ship it')
    expect(agentText()).toContain('engines.codex.transport: acp')
    expect(requests('turn/start')).toHaveLength(0)
    // A $skill or an unknown /word is the model's.
    await run(6, '/unknownthing please')
    expect((requests('turn/start')[0].params!.input as Array<{ text: string }>)[0].text).toBe('/unknownthing please')
    expect(errorRows()).toHaveLength(0)
  })

  it('the host\'s [sandbox_workspace_write] (writable roots, network) stays under the Agent mode', async () => {
    const { w } = await startSession({ MOCK_SANDBOX_WW: JSON.stringify({ writable_roots: ['/srv/shared'], network_access: true, exclude_tmpdir_env_var: false, exclude_slash_tmp: false }) })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'hi' })
    await waitTurn('c1')
    expect(requests('turn/start')[0].params!.sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: ['/srv/shared'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false })
    expect((await op(w, 'setConfigOption', { commandId: 'k1', configId: 'mode', value: 'agent-full-access' })).ok).toBe(true)
    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'again' })
    await waitTurn('c2')
    expect(requests('turn/start')[1].params!.sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  })
})

describe('transport switch', () => {
  it('only a thread Codex has no copy of reads as lost; a rollout it cannot read keeps the conversation', () => {
    for (const lost of ['no rollout found for thread id 019a0000-0000-7000-8000-00000000dead', 'thread not found: 019a0000-0000-7000-8000-00000000dead']) {
      expect(describeResumeFailure(new Error(lost)).kind, lost).toBe('not_found')
    }
    for (const kept of [
      'failed to load rollout: Permission denied (os error 13)',
      'failed to load rollout `/x/rollout.jsonl`: failed to parse line 3',
      'failed to load rollout: No such file or directory (os error 2)',
      'model provider `bp` does not exist',
      'thread not found in index: Permission denied (os error 13)',
    ]) {
      expect(describeResumeFailure(new Error(kept)).kind, kept).toBe('other')
    }
  })

  it('defaults to app-server; config engines.codex.transport acp and the env switch go back', () => {
    expect(resolveCodexTransport({}, {})).toBe('app-server')
    expect(resolveCodexTransport({ engines: { codex: { transport: 'acp' } } }, {})).toBe('acp')
    expect(resolveCodexTransport({}, { [CODEX_TRANSPORT_ENV]: 'acp' })).toBe('acp')
    expect(resolveCodexTransport({ engines: { codex: { transport: 'acp' } } }, { [CODEX_TRANSPORT_ENV]: 'app-server' })).toBe('app-server')
    expect(resolveCodexTransport({ engines: { codex: { transport: 'bogus' } } }, {})).toBe('app-server')
    // A session given its own adapter command runs it, unless the env names the transport.
    expect(resolveCodexTransport({}, {}, { adapterGiven: true })).toBe('acp')
    expect(resolveCodexTransport({}, { [CODEX_TRANSPORT_ENV]: 'app-server' }, { adapterGiven: true })).toBe('app-server')
  })

  it('without the env the worker runs the adapter command, as every other engine does', async () => {
    const w = new AcpWorker(journalPath())
    workers.push(w)
    const init = await op(w, 'initialize', { adapterCommand: [process.execPath, MOCK_ACP], cwd: tmpDir, env: { CODEX_PATH: MOCK_CODEX, MOCK_CODEX_LOG: logPath() } })
    expect(init.ok).toBe(true)
    expect(codexLog()).toHaveLength(0)
    expect(((init.result as { _meta?: { walnut?: unknown } })._meta?.walnut)).toBeUndefined()
  })
})

describe('direct Codex: a command the turn leaves running (background terminals)', () => {
  type Bg = { type: string; running: Array<{ processId: string; command: string }>; finished: Array<{ processId: string; command: string; exitCode: number | null; output: string }> }
  const bgRecords = () => metas().filter((e) => e.type === 'background-work') as unknown as Bg[]

  it('is journaled ahead of the turn\'s end, and its end comes with its exit code and output', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'BG 300' })
    await waitTurn('c1')
    const all = metas()
    const left = all.findIndex((e) => e.type === 'background-work')
    const end = all.findIndex((e) => e.type === 'turn-ended' && e.commandId === 'c1')
    // Ahead of the turn's end: the server never reads the task as done while the build runs.
    expect(left).toBeGreaterThanOrEqual(0)
    expect(left).toBeLessThan(end)
    expect(bgRecords()[0]).toMatchObject({ running: [{ processId: '4242', command: 'make build' }], finished: [] })
    expect(((await op(w, 'getState')).result as WorkerStateSnapshot).backgroundWork).toEqual([{ processId: '4242', command: 'make build' }])

    // It ends after the turn: Codex's late item/completed carries how.
    const ended = await waitFor(bgRecords, (r) => r.some((b) => b.finished.length > 0), 'the end of the background command')
    expect(ended.at(-1)).toMatchObject({ running: [], finished: [{ processId: '4242', command: 'make build', exitCode: 0 }] })
    expect(ended.at(-1)!.finished[0].output).toContain('BUILD OK')
    expect(((await op(w, 'getState')).result as WorkerStateSnapshot).backgroundWork).toEqual([])
    expect(errorRows()).toHaveLength(0)
  })

  it('an end Codex never tells is read from the list', async () => {
    const { w } = await startSession({ MOCK_BG_SILENT: '1', WALNUT_CODEX_BG_POLL_MS: '100' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'BG 200' })
    await waitTurn('c1')
    const ended = await waitFor(bgRecords, (r) => r.some((b) => b.finished.length > 0), 'the polled end')
    expect(ended.at(-1)).toMatchObject({ running: [], finished: [{ processId: '4242', exitCode: null, output: '' }] })
  })

  it('a stop ends what the turn left running, and its end is no news', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'BG_HOLD' })
    await waitTurn('c1')
    expect(bgRecords().at(-1)!.running).toHaveLength(1)
    // No turn runs: the stop still reaches the command.
    expect((await op(w, 'cancel', { commandId: 'x1' })).ok).toBe(true)
    expect(requests('thread/backgroundTerminals/terminate').map((r) => r.params!.processId)).toEqual(['4242'])
    // Its end (exit 143) came before the terminate's answer: dropped, nothing wakes the session.
    expect(bgRecords().at(-1)).toMatchObject({ running: [], finished: [] })
    expect(bgRecords().some((b) => b.finished.length > 0)).toBe(false)
  })

  it('an end during a later turn is told at that turn\'s end, unless that turn read the command after it ended', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'BG 300' })
    await waitTurn('c1')
    // The build ends while another turn runs: nothing is told mid-turn, it is told at its end.
    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'SLOW 1500' })
    await waitTurn('c2')
    const all = metas()
    const told = all.findIndex((e) => e.type === 'background-work' && (e as unknown as Bg).finished.length > 0)
    expect(told).toBeGreaterThan(all.findIndex((e) => e.type === 'turn-started' && e.commandId === 'c2'))
    expect(told).toBeLessThan(all.findIndex((e) => e.type === 'turn-ended' && e.commandId === 'c2'))

    // A turn that polls the command and sees it end: the model knows, so it is not news.
    await op(w, 'prompt', { commandId: 'c3', walnutMessageId: 'm3', text: 'BG_HOLD' })
    await waitTurn('c3')
    const pid = bgRecords().at(-1)!.running[0].processId
    await op(w, 'prompt', { commandId: 'c4', walnutMessageId: 'm4', text: `BG_READ ${pid}` })
    await waitTurn('c4')
    const last = bgRecords().at(-1)!
    expect(last).toMatchObject({ running: [], finished: [] })

    // A read while it still ran proves nothing: its later failure is told.
    await op(w, 'prompt', { commandId: 'c5', walnutMessageId: 'm5', text: 'BG_HOLD' })
    await waitTurn('c5')
    const peeked = bgRecords().at(-1)!.running[0].processId
    await op(w, 'prompt', { commandId: 'c6', walnutMessageId: 'm6', text: `BG_PEEK ${peeked}` })
    await waitTurn('c6')
    expect(bgRecords().at(-1)).toMatchObject({ running: [], finished: [{ processId: peeked, exitCode: 1 }] })
    expect(bgRecords().at(-1)!.finished[0].output).toContain('BUILD FAILED')
  })

  it('an end Codex never tells, during a later turn, is told at that turn\'s end', async () => {
    const { w } = await startSession({ MOCK_BG_SILENT: '1' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'BG 300' })
    await waitTurn('c1')
    // It leaves the list while the next turn runs (the poll is off during a turn).
    await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'SLOW 1200' })
    await waitTurn('c2')
    expect(bgRecords().at(-1)).toMatchObject({ running: [], finished: [{ processId: '4242', exitCode: null }] })
  })

  it('a turn that leaves nothing running journals nothing about it', async () => {
    const { w } = await startSession()
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'CMD' })
    await waitTurn('c1')
    expect(bgRecords()).toHaveLength(0)
    expect(requests('thread/backgroundTerminals/list')).toHaveLength(1)
  })
})

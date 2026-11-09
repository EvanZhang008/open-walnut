/**
 * A message that meets the end of a live ACP turn goes into the next turn, once, and is no error
 * (2026-11-09: a Codex task's mid-turn message met its turn's end twice in a day; the worker
 * journaled the steer's failure as a turn error, so the task read an error row and Needs you, and
 * codex-acp ran the text as a new turn of its own while Walnut sent it again as the next prompt).
 *
 * The class: an op whose failure the caller handles itself is never journaled as a turn error.
 * Every op the worker answers is listed here with its choice, so a new op fails until it is decided.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { AcpWorker, CALLER_OWNS_FAILURE } from '../../src/providers/acp-worker/worker.js'
import { readJournal } from '../../src/providers/acp-worker/journal.js'
import type { JournalRecord } from '../../src/providers/acp-worker/protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const MOCK_AGENT = path.join(__dirname, 'mock-acp-agent.mjs')

/** Every op the worker answers: does its failure read as a failed turn (an error row)? */
const OP_FAILURE_IS_TURN_ERROR: Record<string, { turnError: boolean; why: string }> = {
  initialize: { turnError: true, why: 'the adapter did not start: the session cannot run' },
  newSession: { turnError: true, why: 'no provider session: the session cannot run' },
  loadSession: { turnError: true, why: 'a resume that failed (load_failed alone is a recoverable setup step)' },
  prompt: { turnError: true, why: 'the turn itself failed' },
  steer: { turnError: false, why: 'a steer that missed goes back to the queue and into the next turn' },
  cancel: { turnError: true, why: 'a Stop that did not stop the turn' },
  permissionResponse: { turnError: true, why: 'the answer to a prompt in the turn was lost' },
  setConfigOption: { turnError: true, why: 'a model or mode change the user asked for failed' },
  getState: { turnError: true, why: 'the worker could not report itself' },
  shutdown: { turnError: true, why: 'the worker could not end cleanly' },
}

describe('which op failures are turn errors', () => {
  it('every op the worker answers is decided, and the caller-owned ones are exactly CALLER_OWNS_FAILURE', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/providers/acp-worker/worker.ts'), 'utf8')
    const handle = src.slice(src.indexOf('async handle(req: WorkerRequest)'), src.indexOf('default:', src.indexOf('async handle(req: WorkerRequest)')))
    const ops = [...handle.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1])
    expect(ops.length).toBeGreaterThan(5)
    expect(ops.filter((o) => !(o in OP_FAILURE_IS_TURN_ERROR)), 'decide whether its failure is a turn error').toEqual([])
    const owned = Object.entries(OP_FAILURE_IS_TURN_ERROR).filter(([, v]) => !v.turnError).map(([k]) => k).sort()
    expect([...CALLER_OWNS_FAILURE].sort()).toEqual(owned)
  })

  it('the session side re-queues every steer failure (it never throws one)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/providers/acp-session.ts'), 'utf8')
    const steer = src.slice(src.indexOf('async steer(message: string'), src.indexOf('private async publishSessionResponse'))
    expect(steer).toMatch(/if \(resp\.ok\) return true/)
    expect(steer).toMatch(/return false\s*\}\s*$/)
  })

  it("Walnut's codex-acp patch honours injection only", () => {
    const dist = fs.readFileSync(createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp/dist/index.js'), 'utf8')
    expect(dist).toContain('injectOnly: params["injectOnly"] === true')
    expect(dist).toMatch(/if \(params\.injectOnly\) \{[\s\S]{0,200}return \{ outcome: "noActiveTurn" \}/)
    // ...and says so at initialize, the only adapter Walnut steers (protocol.ts snapshotAcpCapabilities).
    expect(dist).toMatch(/steering: \{\s*supported: true,\s*injectOnly: true\s*\}/)
  })

  // 2026-11-09: the model catalog Walnut's patch hands Codex's app-server lived in the OS temp dir; a
  // sweep removed it hours into the session, and every turn after failed with "failed to load
  // configuration: No such file or directory" (shown as "ACP provider protocol operation failed").
  it("Walnut's codex-acp patch keeps the files Codex rereads out of temp dirs, and puts a lost one back", () => {
    const patch = fs.readFileSync(path.join(ROOT, 'patches', '@agentclientprotocol%2Fcodex-acp@1.4.0.patch'), 'utf8')
    const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    expect(added.filter((l) => /tmpdir\(|\/tmp\//.test(l) && /model_catalog|walnut-codex-models|const file/.test(l))).toEqual([])
    const dist = fs.readFileSync(createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp/dist/index.js'), 'utf8')
    expect(dist).toContain('path.join(walnutCatalogDir(os2), `walnut-codex-models-')
    // Every entry point that can make Codex read its config again heals the file first.
    for (const head of ['async prompt(params, signal, onTurnStarted) {', 'async performSteeringRequest(params) {', '  async loadSession(params) {', '  async resumeSession(params) {', '  async newSession(params) {']) {
      const at = dist.indexOf(head)
      expect(at, head).toBeGreaterThan(0)
      expect(dist.slice(at, at + head.length + 40), head).toContain('walnutEnsureCatalog();')
    }
  })
})

let tmpDir: string
let worker: AcpWorker | null
let reqId = 0
const journalPath = () => path.join(tmpDir, 'session.acp.jsonl')
const op = (w: AcpWorker, name: string, params?: Record<string, unknown>) => w.handle({ id: ++reqId, op: name as never, params })
const records = (): JournalRecord[] => readJournal(journalPath()).records.map((r) => r.record)
const metas = (recs: JournalRecord[]) =>
  recs.filter((r): r is Extract<JournalRecord, { kind: 'meta' }> => r.kind === 'meta').map((r) => r.event)
async function waitFor(pred: (recs: JournalRecord[]) => boolean, ms = 8000): Promise<JournalRecord[]> {
  const end = Date.now() + ms
  for (;;) {
    const recs = records()
    if (pred(recs)) return recs
    if (Date.now() > end) throw new Error(`journal predicate not met: ${JSON.stringify(metas(recs).map((e) => e.type))}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
async function initWorker(env?: Record<string, string>): Promise<AcpWorker> {
  const w = new AcpWorker(journalPath())
  expect((await op(w, 'initialize', { adapterCommand: [process.execPath, MOCK_AGENT], cwd: tmpDir, env })).ok).toBe(true)
  await op(w, 'newSession', { cwd: tmpDir })
  return w
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-op-failures-')); worker = null })
afterEach(async () => {
  if (worker) await op(worker, 'shutdown').catch(() => {})
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('a steer that meets the end of the live turn', () => {
  it('is no error and no turn of its own: the text runs once, as the next prompt', async () => {
    worker = await initWorker()
    await op(worker, 'prompt', { commandId: 'acp-prompt:qm-race', walnutMessageId: 'qm-race', text: 'steer-race' })
    await waitFor((recs) => JSON.stringify(recs).includes('race turn open'))
    const steer = await op(worker, 'steer', { commandId: 'acp-steer:qm-late', walnutMessageId: 'qm-late', text: 'late words' })
    expect(steer.ok).toBe(false)
    expect(steer.error?.kind).toBe('steer_race')
    await waitFor((recs) => metas(recs).some((e) => e.type === 'turn-ended'))
    // What the caller does with it (claude-code-session.ts steerAcpQueued): the next prompt.
    expect((await op(worker, 'prompt', { commandId: 'acp-prompt:qm-late', walnutMessageId: 'qm-late', text: 'late words' })).ok).toBe(true)
    const recs = await waitFor((r) => metas(r).filter((e) => e.type === 'turn-ended').length === 2)
    expect(metas(recs).filter((e) => e.type === 'error')).toEqual([])
    expect(JSON.stringify(recs)).not.toContain('steer-started-turn')
    expect(metas(recs).filter((e) => e.type === 'turn-started')).toHaveLength(2)
    expect(metas(recs).filter((e) => e.type === 'steer-accepted')).toEqual([])
  })

  it('an adapter that may start a turn of its own is never steered: the text waits for the next turn, once', async () => {
    worker = await initWorker({ MOCK_ACP_STEER_NO_INJECT_ONLY: '1' })
    const state = await op(worker, 'getState')
    expect((state.result as { capabilities: { steering: boolean } }).capabilities.steering).toBe(false)
    await op(worker, 'prompt', { commandId: 'acp-prompt:qm-race2', walnutMessageId: 'qm-race2', text: 'steer-race' })
    await waitFor((recs) => JSON.stringify(recs).includes('race turn open'))
    expect((await op(worker, 'steer', { commandId: 'acp-steer:qm-late2', walnutMessageId: 'qm-late2', text: 'late words' })).error?.kind).toBe('steer_unsupported')
    await waitFor((recs) => metas(recs).some((e) => e.type === 'turn-ended'))
    expect((await op(worker, 'prompt', { commandId: 'acp-prompt:qm-late2', walnutMessageId: 'qm-late2', text: 'late words' })).ok).toBe(true)
    const recs = await waitFor((r) => metas(r).filter((e) => e.type === 'turn-ended').length === 2)
    expect(metas(recs).filter((e) => e.type === 'error')).toEqual([])
    expect(JSON.stringify(recs)).not.toContain('steer-started-turn')
    expect(metas(recs).filter((e) => e.type === 'turn-started')).toHaveLength(2)
  })

  it('no live turn and an adapter without steering: no error row either', async () => {
    worker = await initWorker()
    expect((await op(worker, 'steer', { commandId: 'acp-steer:qm-idle', walnutMessageId: 'qm-idle', text: 'x' })).error?.kind).toBe('no_turn')
    await op(worker, 'shutdown'); worker = null
    fs.rmSync(journalPath(), { force: true })
    worker = await initWorker({ MOCK_ACP_NO_STEERING: '1' })
    await op(worker, 'prompt', { commandId: 'acp-prompt:qm-old', walnutMessageId: 'qm-old', text: 'steer-window' })
    expect((await op(worker, 'steer', { commandId: 'acp-steer:qm-uns', walnutMessageId: 'qm-uns', text: 'x' })).error?.kind).toBe('steer_unsupported')
    await op(worker, 'cancel', { commandId: 'cancel-old' })
    expect(metas(records()).filter((e) => e.type === 'error')).toEqual([])
  })
})

/**
 * LIVE Codex verification (Phase 5, gated) — the real chain end to end:
 *
 *   real daemon binary → real acp-worker bundle → REAL @agentclientprotocol/codex-acp
 *   → real codex app-server (system `codex` binary, must be authenticated).
 *
 * Run manually:
 *   WALNUT_LIVE_CODEX=1 npx vitest run --config vitest.live.config.ts tests/e2e/acp-codex.live.test.ts
 *
 * Covers: initialize/model discovery, one prompt turn (real tokens — kept
 * trivial), warm follow-up on the same worker, interrupt, daemon kill →
 * restart → journal repair → lazy resume of the SAME provider thread.
 * Records adapter/CLI versions in the test output for diagnostics.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveSystemCodexPath } from '../../src/providers/acp-session.js'

const LIVE = process.env.WALNUT_LIVE_CODEX === '1'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const DAEMON_BIN = path.join(REPO_ROOT, 'dist/daemon-binaries/daemon-darwin-arm64')
const WORKER_BUNDLE = path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js')
const ADAPTER_JS = path.join(REPO_ROOT, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')

const SYSTEM_CODEX = LIVE ? resolveSystemCodexPath() : undefined
const RUNNABLE = LIVE && SYSTEM_CODEX !== undefined
  && fs.existsSync(DAEMON_BIN) && fs.existsSync(WORKER_BUNDLE) && fs.existsSync(ADAPTER_JS)
  && process.platform === 'darwin' && process.arch === 'arm64'

/** Test-diagnostic line (avoids the log API to keep vitest output ordering). */
const diag = (msg: string): void => { process.stdout.write(`[live-codex] ${msg}\n`) }

let daemonDir: string
let streamsDir: string
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 0
const pushed: Array<Record<string, unknown>> = []

async function spawnDaemon(): Promise<number> {
  const p = spawn(DAEMON_BIN, ['--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc = p
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
    p.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
}

async function connect(port: number): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws!.once('open', () => resolve())
    ws!.once('error', reject)
  })
  ws!.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.ev) pushed.push(msg)
  })
}

function rpc(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const id = ++rpcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), timeoutMs)
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === id) {
        clearTimeout(timer)
        ws!.off('message', onMsg)
        resolve(msg)
      }
    }
    ws!.on('message', onMsg)
    ws!.send(JSON.stringify({ cmd, id, ...params }))
  })
}

interface LiveJournalRecord {
  kind: string
  source?: string
  event?: { type?: string; stopReason?: string }
  frame?: Record<string, unknown>
}

function journalRecords(): LiveJournalRecord[] {
  return pushed
    .filter((f) => f.ev === 'jsonl' && typeof f.line === 'string')
    .map((f) => JSON.parse(f.line as string))
}

function streamedText(records = journalRecords()): string {
  return records
    .filter((r) => r.kind === 'acp')
    .map((r) => {
      const frame = r.frame as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } } | undefined
      const u = frame?.method === 'session/update' ? frame.params?.update : undefined
      return u?.sessionUpdate === 'agent_message_chunk' ? (u.content?.text ?? '') : ''
    }).join('')
}

async function sendLivePrompt(messageId: string, text: string): Promise<void> {
  const response = await rpc('acpSend', {
    sid: 'live-codex-1',
    commandId: `acp-prompt:${messageId}`,
    walnutMessageId: messageId,
    text,
  })
  expect(response, `acpSend failed: ${JSON.stringify(response)}`).toMatchObject({ ok: true })
}

async function waitFor(pred: () => boolean, timeoutMs = 120_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout: ' + what)
    await new Promise((r) => setTimeout(r, 100))
  }
}

function descendantCommands(rootPid: number): string[] {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf-8' })
  const children = new Map<number, Array<{ pid: number; command: string }>>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const siblings = children.get(ppid) ?? []
    siblings.push({ pid, command: match[3] })
    children.set(ppid, siblings)
  }

  const commands: string[] = []
  const pending = [rootPid]
  for (let index = 0; index < pending.length; index++) {
    for (const child of children.get(pending[index]) ?? []) {
      pending.push(child.pid)
      commands.push(child.command)
    }
  }
  return commands
}

const startParams = (extra: Record<string, unknown> = {}) => ({
  sid: 'live-codex-1',
  cwd: os.tmpdir(),
  workerCmd: [process.execPath, WORKER_BUNDLE],
  adapterCmd: [process.execPath, ADAPTER_JS],
  env: { CODEX_PATH: SYSTEM_CODEX! },
  ...extra,
})

describe.runIf(RUNNABLE)('LIVE Codex via ACP (real adapter + real codex)', () => {
  beforeAll(async () => {
    // Diagnostics: record the versions this run verified.
    const adapterVersion = (JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'node_modules/@agentclientprotocol/codex-acp/package.json'), 'utf-8')) as { version: string }).version
    let codexVersion = 'unknown'
    try { codexVersion = execFileSync(SYSTEM_CODEX!, ['--version'], { encoding: 'utf-8' }).trim() } catch {}
    diag(`codex-acp@${adapterVersion} · codex ${codexVersion}`)

    daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-live-codex-'))
    streamsDir = daemonDir + '-streams'
    const port = await spawnDaemon()
    await connect(port)
  }, 60_000)

  afterAll(async () => {
    ws?.close()
    if (proc && proc.exitCode === null) proc.kill('SIGKILL')
    fs.rmSync(daemonDir, { recursive: true, force: true })
    fs.rmSync(streamsDir, { recursive: true, force: true })
  })

  let providerSessionId: string

  it('acpStart discovers real models and creates a real session', async () => {
    const start = await rpc('acpStart', startParams())
    expect(start.ok).toBe(true)
    const session = (start as { session?: { sessionId?: string; models?: { availableModels?: unknown[] } } }).session
    expect(session?.sessionId).toBeTruthy()
    providerSessionId = session!.sessionId!
    const expectedCommand = `${SYSTEM_CODEX} app-server`
    let appServerCommands: string[] = []
    await waitFor(() => {
      appServerCommands = descendantCommands(proc!.pid!).filter((command) => command.includes('app-server'))
      return appServerCommands.length > 0
    }, 10_000, 'system Codex app-server process')
    expect(appServerCommands.some((command) =>
      command === expectedCommand || command.startsWith(`${expectedCommand} `))).toBe(true)
    expect(appServerCommands.some((command) =>
      /(^|[\\/])node_modules([\\/]|$)/i.test(command))).toBe(false)
    diag(`spawned ${expectedCommand}`)
    // Model discovery — the whole reason there is no hard-coded codex catalog.
    const models = session?.models?.availableModels ?? []
    expect(models.length).toBeGreaterThan(0)
    diag(`session ${providerSessionId} · ${models.length} models discovered`)
  }, 120_000)

  it('one real prompt turn streams and ends', async () => {
    await sendLivePrompt('qm-live-codex-1', 'Reply with exactly the word: pong')
    await waitFor(() => journalRecords().some((r) => r.event?.type === 'turn-ended'), 120_000, 'first live turn end')
    expect(streamedText().toLowerCase()).toContain('pong')
  }, 150_000)

  it('warm follow-up reuses the same worker', async () => {
    const before = journalRecords().filter((r) => r.event?.type === 'turn-ended').length
    await sendLivePrompt('qm-live-codex-2', 'Reply with exactly the word: warm')
    await waitFor(() => journalRecords().filter((r) => r.event?.type === 'turn-ended').length > before, 120_000, 'follow-up turn end')
    expect(streamedText().toLowerCase()).toContain('warm')
    // No session-loaded meta — this was the same live worker, not a cold resume.
    expect(journalRecords().some((r) => r.event?.type === 'session-loaded')).toBe(false)
  }, 150_000)

  it('interrupt cancels a running turn', async () => {
    await sendLivePrompt('qm-live-codex-3', 'Count from 1 to 500 slowly, one number per line.')
    // Cancel only once the model is actually STREAMING this turn — cancelling
    // right at turn-started raced the app-server's own turn registration and
    // the turn sometimes closed as end_turn before the cancel took effect.
    const textBefore = streamedText().length
    await waitFor(() => journalRecords().filter((x) => x.event?.type === 'turn-started').length >= 3
      && streamedText().length > textBefore, 90_000, 'third turn streaming')
    const cancel = await rpc('acpCancel', { sid: 'live-codex-1', commandId: 'lc-4' })
    expect(cancel.ok).toBe(true)
    await waitFor(() => {
      const ends = journalRecords().filter((r) => r.event?.type === 'turn-ended')
      return ends.length >= 3 && ends[ends.length - 1].event?.stopReason === 'cancelled'
    }, 60_000, 'cancelled turn end')
  }, 120_000)

  it('daemon kill → restart → lazy resume of the SAME provider thread', async () => {
    ws?.close(); ws = null
    proc!.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 1000)) // worker+adapter+app-server die with daemon

    pushed.length = 0
    const port = await spawnDaemon()
    await connect(port)

    const start = await rpc('acpStart', startParams({ providerSessionId, fromOffset: 0 }))
    expect(start, `lazy resume failed: ${JSON.stringify(start)}`).toMatchObject({ ok: true })
    await waitFor(() => journalRecords().some((r) => r.event?.type === 'session-loaded'), 120_000, 'session/load resume')

    // The resumed thread remembers the conversation (thread continuity, not a fresh session).
    const before = journalRecords().filter((r) => r.event?.type === 'turn-ended').length
    await sendLivePrompt(
      'qm-live-codex-5',
      'What single word did I ask you to reply with in my first message? Reply with just that word.',
    )
    await waitFor(
      () => journalRecords().filter((r) => r.event?.type === 'turn-ended').length > before,
      120_000,
      'post-resume turn end',
    )
    expect(streamedText().toLowerCase()).toContain('pong')
  }, 300_000)
})

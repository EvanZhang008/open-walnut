/**
 * A host other than the primary runs ACP engines itself (acp-host-artifacts.ts).
 * Spawns the REAL source twin from a directory laid out the way a remote deploy
 * lays it out (daemon.cjs, acp-daemon-core.cjs and the ACP_HOST_FILES), with an
 * engine CLI on its PATH, and drives it over a real WebSocket the way AcpSession
 * does for a session on another host: it says `acp-host-v1`, reports which engines
 * it can run, and starts a session from the adapter's description alone (no path
 * of the primary's install), which then takes a turn.
 *
 * The engine CLI here is a script under a name no machine has, which runs the
 * scripted mock ACP agent; the daemon's PATH comes from the login shell, so a real
 * engine name could find the machine's own install first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { ACP_HOST_FILES } from '../../src/providers/acp-host-artifacts.js'
import { hostAdapterSpec } from '../../src/core/agents/host-adapter-spec.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { guardedPath } from '../setup/exec-guard.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
/** Built by scripts/build-daemon.sh; WALNUT_TEST_DAEMON_BINARIES names another build of them. */
const BINARIES = process.env.WALNUT_TEST_DAEMON_BINARIES || path.join(REPO_ROOT, 'dist/daemon-binaries')
const MOCK_AGENT = path.join(REPO_ROOT, 'tests/providers/mock-acp-agent.mjs')
const NEEDED = ['acp-daemon-core.cjs', ...Object.values(ACP_HOST_FILES)]
const HAVE = NEEDED.every((f) => fs.existsSync(path.join(BINARIES, f)))

const CLI = 'walnut-test-acp-cli'
/** opencode's description under the test CLI's name, and one for a CLI nobody has. */
const present = () => ({ ...hostAdapterSpec('opencode')!, binary: CLI, args: [], overrideEnv: 'WALNUT_TEST_NO_OVERRIDE' })
const missing = () => ({ ...hostAdapterSpec('goose')!, binary: 'walnut-test-no-such-cli', overrideEnv: 'WALNUT_TEST_NO_OVERRIDE' })
const missingBundled = () => ({ ...hostAdapterSpec('codex')!, binary: 'walnut-test-no-codex', overrideEnv: 'WALNUT_TEST_NO_OVERRIDE' })

let root: string
let daemonDir: string
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 0
const pushed: Array<Record<string, unknown>> = []

function rpc(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = ++rpcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), timeoutMs)
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMsg); resolve(msg) }
    }
    ws!.on('message', onMsg)
    ws!.send(JSON.stringify({ cmd, id, ...params }))
  })
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 40))
  }
}

describe.runIf(HAVE)('ACP on a host other than the primary (source twin, deployed ACP files)', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-host-e2e-'))
    // The deploy dir: daemon.cjs and its sidecars, ACP files under their host names.
    const deploy = path.join(root, 'deploy')
    fs.mkdirSync(deploy)
    fs.writeFileSync(path.join(deploy, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
    fs.copyFileSync(path.join(BINARIES, 'acp-daemon-core.cjs'), path.join(deploy, 'acp-daemon-core.cjs'))
    for (const [hostName, distName] of Object.entries(ACP_HOST_FILES)) fs.copyFileSync(path.join(BINARIES, distName), path.join(deploy, hostName))
    // The host's own engine CLI, on its PATH (nothing of the primary's install).
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, CLI), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode 9.9.9"; exit 0; fi\nexec "${process.execPath}" "${MOCK_AGENT}"\n`, { mode: 0o755 })
    daemonDir = path.join(root, 'daemon')
    const p = spawn(SOURCE_TWIN.file, [path.join(deploy, 'daemon.cjs'), '--start'], {
      // HOME inside the temp dir: the daemon's per-user install dirs hold nothing real.
      env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir, HOME: path.join(root, 'home'), PATH: guardedPath([bin], '/usr/bin:/bin') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc = p
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 20_000)
      p.stdout!.on('data', (chunk: Buffer) => {
        const m = chunk.toString().match(/^\d+$/m)
        if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
      })
      p.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
    })
    ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => { ws!.once('open', () => resolve()); ws!.once('error', reject) })
    ws.on('message', (raw) => { const msg = JSON.parse(raw.toString()); if (msg.ev) pushed.push(msg) })
  }, 40_000)

  afterAll(async () => {
    ws?.close()
    if (proc && proc.exitCode === null) { proc.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 200)) }
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(daemonDir + '-streams', { recursive: true, force: true })
  })

  it('says it runs ACP engines itself', async () => {
    const hello = await rpc('hello')
    expect(hello.capabilities as string[]).toContain('acp-host-v1')
  })

  it('reports the engines this host can run, and why not', async () => {
    const specs = [present(), missing(), missingBundled()]
    const resp = await rpc('acpHostEngines', { specs })
    expect(resp.ok).toBe(true)
    // The daemon spreads its answer into the reply, as host-engines.ts reads it.
    const engines = (resp as { engines?: Record<string, { installed: boolean; version: string | null; reason: string | null }> }).engines
    expect(engines?.opencode).toMatchObject({ installed: true, version: 'opencode 9.9.9' })
    expect(engines?.goose).toMatchObject({ installed: false, reason: 'walnut-test-no-such-cli is not installed' })
    expect(engines?.codex).toMatchObject({ installed: false, reason: 'walnut-test-no-codex is not installed' })
  })

  it('starts a session from the adapter description alone, and it takes a turn', async () => {
    const start = await rpc('acpStart', { sid: 'host-1', cwd: os.tmpdir(), hostAdapter: present() }, 60_000)
    expect(start.ok, JSON.stringify(start)).toBe(true)
    const send = await rpc('acpSend', { sid: 'host-1', commandId: 'c1', walnutMessageId: 'qm-host-1', text: 'hello from the primary' })
    expect(send.ok).toBe(true)
    await waitFor(() => pushed.some((f) => f.ev === 'jsonl' && typeof f.line === 'string' && (f.line as string).includes('turn-ended')))
    await rpc('acpStop', { sid: 'host-1' })
  }, 90_000)

  it('refuses an engine the host does not have, saying so', async () => {
    const start = await rpc('acpStart', { sid: 'host-2', cwd: os.tmpdir(), hostAdapter: missing() })
    expect(start).toMatchObject({ ok: false, errorKind: 'provider_missing' })
    expect(String(start.error)).toContain('walnut-test-no-such-cli is not installed')
  })
})

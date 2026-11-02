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
 *
 * The same suite runs the compiled walnut file as the daemon (a compiled Mac's remote
 * daemon slot and every host's boot service run that file): it reads the ACP files from
 * its own runtime tree under their dist names, with nothing deployed beside it
 * (2026-11-02: once hosts ran the boot service, no remote Linux host could start pi or
 * Codex). Set WALNUT_TEST_WALNUT_FILE, or build dist-bin/walnut-<target> first; without
 * one that suite is skipped.
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
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
/** Built by scripts/build-daemon.sh; WALNUT_TEST_DAEMON_BINARIES names another build of them. */
const BINARIES = process.env.WALNUT_TEST_DAEMON_BINARIES || path.join(REPO_ROOT, 'dist/daemon-binaries')
const MOCK_AGENT = path.join(REPO_ROOT, 'tests/providers/mock-acp-agent.mjs')
const NEEDED = ['acp-daemon-core.cjs', ...Object.values(ACP_HOST_FILES)]
const HAVE = NEEDED.every((f) => fs.existsSync(path.join(BINARIES, f)))

const target = `${process.platform}-${process.arch}`
const WALNUT_FILE = process.env.WALNUT_TEST_WALNUT_FILE || path.join(REPO_ROOT, 'dist-bin', `walnut-${target}`)
const HAVE_FILE = fs.existsSync(WALNUT_FILE)

const CLI = 'walnut-test-acp-cli'
/** opencode's description under the test CLI's name, and one for a CLI nobody has. */
const present = () => ({ ...hostAdapterSpec('opencode')!, binary: CLI, args: [], overrideEnv: 'WALNUT_TEST_NO_OVERRIDE' })
const missing = () => ({ ...hostAdapterSpec('goose')!, binary: 'walnut-test-no-such-cli', overrideEnv: 'WALNUT_TEST_NO_OVERRIDE' })
const missingBundled = () => ({ ...hostAdapterSpec('codex')!, binary: 'walnut-test-no-codex', overrideEnv: 'WALNUT_TEST_NO_OVERRIDE' })

interface Rig { root: string; daemonDir: string; proc: ChildProcess | null; ws: WebSocket | null; rpcId: number; pushed: Array<Record<string, unknown>> }

function rpc(rig: Rig, cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = ++rig.rpcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), timeoutMs)
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === id) { clearTimeout(timer); rig.ws!.off('message', onMsg); resolve(msg) }
    }
    rig.ws!.on('message', onMsg)
    rig.ws!.send(JSON.stringify({ cmd, id, ...params }))
  })
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 40))
  }
}

/** How a suite starts its daemon: the command, and env beyond the shared one. */
type Launch = (root: string) => { command: string; args: string[]; env?: Record<string, string> }

function hostSuite(title: string, have: boolean, launch: Launch) {
  describe.runIf(have)(title, () => {
    const rig: Rig = { root: '', daemonDir: '', proc: null, ws: null, rpcId: 0, pushed: [] }

    beforeAll(async () => {
      rig.root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-host-e2e-'))
      // The host's own engine CLI, on its PATH (nothing of the primary's install).
      const bin = path.join(rig.root, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, CLI), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode 9.9.9"; exit 0; fi\nexec "${process.execPath}" "${MOCK_AGENT}"\n`, { mode: 0o755 })
      rig.daemonDir = path.join(rig.root, 'daemon')
      const how = launch(rig.root)
      const p = spawn(how.command, how.args, {
        // HOME inside the temp dir: the daemon's per-user install dirs hold nothing real.
        env: { ...process.env, ...how.env, WALNUT_DAEMON_DIR: rig.daemonDir, HOME: path.join(rig.root, 'home'), PATH: guardedPath([bin], '/usr/bin:/bin') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      rig.proc = p
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
        p.stdout!.on('data', (chunk: Buffer) => {
          const m = chunk.toString().match(/^\d+$/m)
          if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
        })
        onDaemonEarlyExit(p, { daemonDir: rig.daemonDir }, (err) => { clearTimeout(timer); reject(err) })
      })
      rig.ws = new WebSocket(`ws://127.0.0.1:${port}`)
      await new Promise<void>((resolve, reject) => { rig.ws!.once('open', () => resolve()); rig.ws!.once('error', reject) })
      rig.ws.on('message', (raw) => { const msg = JSON.parse(raw.toString()); if (msg.ev) rig.pushed.push(msg) })
    }, 90_000)

    afterAll(async () => {
      rig.ws?.close()
      if (rig.proc && rig.proc.exitCode === null) { rig.proc.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 200)) }
      fs.rmSync(rig.root, { recursive: true, force: true })
      fs.rmSync(rig.daemonDir + '-streams', { recursive: true, force: true })
    })

    it('says it runs ACP engines itself', async () => {
      const hello = await rpc(rig, 'hello')
      expect(hello.capabilities as string[]).toContain('acp-host-v1')
    })

    it('reports the engines this host can run, and why not', async () => {
      const specs = [present(), missing(), missingBundled()]
      const resp = await rpc(rig, 'acpHostEngines', { specs })
      expect(resp.ok).toBe(true)
      // The daemon spreads its answer into the reply, as host-engines.ts reads it.
      const engines = (resp as { engines?: Record<string, { installed: boolean; version: string | null; reason: string | null }> }).engines
      expect(engines?.opencode).toMatchObject({ installed: true, version: 'opencode 9.9.9' })
      expect(engines?.goose).toMatchObject({ installed: false, reason: 'walnut-test-no-such-cli is not installed' })
      expect(engines?.codex).toMatchObject({ installed: false, reason: 'walnut-test-no-codex is not installed' })
    })

    it('starts a session from the adapter description alone, and it takes a turn', async () => {
      const start = await rpc(rig, 'acpStart', { sid: 'host-1', cwd: os.tmpdir(), hostAdapter: present() }, 60_000)
      expect(start.ok, JSON.stringify(start)).toBe(true)
      const send = await rpc(rig, 'acpSend', { sid: 'host-1', commandId: 'c1', walnutMessageId: 'qm-host-1', text: 'hello from the primary' })
      expect(send.ok).toBe(true)
      await waitFor(() => rig.pushed.some((f) => f.ev === 'jsonl' && typeof f.line === 'string' && (f.line as string).includes('turn-ended')), 30_000)
      await rpc(rig, 'acpStop', { sid: 'host-1' })
    }, 120_000)

    it('refuses an engine the host does not have, saying so', async () => {
      const start = await rpc(rig, 'acpStart', { sid: 'host-2', cwd: os.tmpdir(), hostAdapter: missing() })
      expect(start).toMatchObject({ ok: false, errorKind: 'provider_missing' })
      expect(String(start.error)).toContain('walnut-test-no-such-cli is not installed')
    })
  })
}

hostSuite('ACP on a host other than the primary (source twin, deployed ACP files)', HAVE, (root) => {
  // The deploy dir: daemon.cjs and its sidecars, ACP files under their host names.
  const deploy = path.join(root, 'deploy')
  fs.mkdirSync(deploy)
  fs.writeFileSync(path.join(deploy, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
  fs.copyFileSync(path.join(BINARIES, 'acp-daemon-core.cjs'), path.join(deploy, 'acp-daemon-core.cjs'))
  for (const [hostName, distName] of Object.entries(ACP_HOST_FILES)) fs.copyFileSync(path.join(BINARIES, distName), path.join(deploy, hostName))
  return { command: SOURCE_TWIN.file, args: [path.join(deploy, 'daemon.cjs'), '--start'] }
})

hostSuite('ACP on a host other than the primary (the compiled walnut file as the daemon, its own runtime tree)', HAVE_FILE, (root) => ({
  // Nothing beside it: the file unpacks its runtime tree under WALNUT_RUNTIME_DIR.
  command: WALNUT_FILE,
  args: ['__daemon', '--start'],
  env: { WALNUT_RUNTIME_DIR: path.join(root, 'runtime'), OPEN_WALNUT_HOME: path.join(root, 'home', '.open-walnut') },
}))

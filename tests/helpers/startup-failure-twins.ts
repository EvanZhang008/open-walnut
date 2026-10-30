/**
 * A resumed CLI that fails at startup, run by both daemon twins booted for real.
 *
 * Claude Code 2.1.314 (2026-10-30) exits 1 and prints the error whenever startup
 * fails. A `--resume` appends to the previous process's stream and stderr; the daemon
 * read their whole tails, so the previous turn's `result` made the failure a clean
 * exit 0 and the previous process's stderr was quoted as the cause. The daemon must
 * report exit 1 with only this process's message.
 *
 * Shared by tests/providers/daemon-startup-failure-twins-e2e.test.ts (a /bin/sh
 * stand-in that prints the same message and exits 1) and
 * tests/providers/daemon-startup-failure-twins.live.test.ts (a real Claude Code).
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, and the
 * daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from './bun-runtime.js'
import { SOURCE_TWIN } from './source-twin.js'

let scriptPath = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let root = ''
let rpcId = 1
const events: Record<string, unknown>[] = []
const L = (o: unknown) => JSON.stringify(o) + '\n'

async function boot(twin: Twin): Promise<{ streams: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-startup-fail-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const streams = path.join(root, 'streams')
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_STREAMS_DIR: streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'), WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => { const m = chunk.toString().trim().match(/^\d+$/m); if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) } })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => { const s = new WebSocket(`ws://127.0.0.1:${port}`); s.on('open', () => resolve(s)); s.on('error', reject) })
  ws.on('message', (data: Buffer) => { try { events.push(JSON.parse(data.toString())) } catch { /* not json */ } })
  return { streams }
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor<T>(check: () => T | undefined, ms = 60_000): Promise<T | undefined> {
  const until = Date.now() + ms
  while (Date.now() < until) { const v = check(); if (v !== undefined) return v; await new Promise((r) => setTimeout(r, 100)) }
  return check()
}

function hooks(): void {
  beforeAll(() => {
    scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-startup-fail-src-')), 'daemon.cjs')
    fs.writeFileSync(scriptPath, getDaemonSource())
  })

  afterEach(async () => {
    try { ws?.close() } catch { /* closed */ }
    ws = null
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
      proc.kill('SIGKILL')
      await exited
    }
    proc = null
    events.length = 0
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })
}

/** The CLI command for a resumed start of `sid` that fails at startup on `badMcp`. */
export type StartupFailureCli = { label: string; args: (sid: string, badMcp: string) => string[] }

/** The stand-in: prints what Claude Code prints for a broken --mcp-config and exits 1. */
export const STAND_IN_CLI: StartupFailureCli = {
  label: 'stand-in CLI',
  args: (sid) => ['/bin/sh', '-c', 'echo "Error: Invalid MCP configuration:" >&2; echo "MCP config is not a valid JSON" >&2; exit 1', 'sh', '--resume', sid],
}

/** A real Claude Code binary: it fails on the broken --mcp-config before any network call. */
export function realCli(bin: string): StartupFailureCli {
  return {
    label: 'real Claude Code',
    args: (sid, badMcp) => [bin, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--resume', sid, '--mcp-config', badMcp, '--strict-mcp-config'],
  }
}

export function startupFailureTwinsSuite(cli: StartupFailureCli): void {
  hooks()
  describe.each(TWINS)('a resumed CLI that fails at startup ($name)', (twin) => {
    it(`reports exit 1 with its own message, not the previous turn's clean end (${cli.label})`, async () => {
      const { streams } = await boot(twin)
      fs.mkdirSync(streams, { recursive: true })
      const sid = 'startup-fail-1'
      const jsonl = path.join(streams, `${sid}.jsonl`)
      // What the previous process left: a finished turn, and an advisory on stderr.
      fs.writeFileSync(jsonl, L({ type: 'system', subtype: 'init', session_id: sid })
        + L({ type: 'result', subtype: 'success', stop_reason: 'end_turn', is_error: false, session_id: sid }))
      fs.writeFileSync(jsonl + '.err', 'an advisory the previous process printed\n')
      const badMcp = path.join(root, 'bad-mcp.json')
      fs.writeFileSync(badMcp, '{bad')

      const started = await rpc({ cmd: 'start', sid, cwd: root, message: '', mode: 'default', resume: true, args: cli.args(sid, badMcp) })
      expect(started.ok, JSON.stringify(started)).toBe(true)

      const dead = await waitFor(() => events.find((e) => e.ev === 'session_state' && e.sid === sid && e.state === 'dead'))
      expect(dead, JSON.stringify(events.slice(-5))).toBeDefined()
      expect(dead!.exitCode).toBe(1)
      expect(String(dead!.reason)).not.toContain('turn-complete')
      expect(String(dead!.stderr)).toContain('MCP config is not a valid JSON')
      expect(String(dead!.stderr)).not.toContain('previous process')
    }, 120_000)
  })
}

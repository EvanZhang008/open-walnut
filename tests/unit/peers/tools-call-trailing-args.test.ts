/**
 * `walnut tools call <op> <args> <anything else>` refuses the extra word on every CLI face.
 *
 * Each face read the one argument and dropped the rest, so `tools call task_send '{...}' --dry-run`
 * sent a real message from a sender who believed it was a preview (2026-10-31). The faces:
 * src/providers/wn-cli.ts (the in-session CLI in the daemon binary), src/commands/tools.ts (the
 * hub CLI), the template CLI inlined in src/providers/daemon-source.ts, and the `walnut mcp ...
 * tools call` parser. The ratchet at the bottom fails when a new place reads a call's arguments.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parseWalnutCliArgs, runWalnutCli } from '../../../src/providers/wn-cli.js'
import { parseMcpCliArgs } from '../../../src/providers/mcp-cli-args.js'
import { trailingArgsMessage } from '../../../src/providers/tool-args-source.js'
import { runTools } from '../../../src/commands/tools.js'
import { getDaemonSource } from '../../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../../helpers/source-twin.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const PAYLOAD = '{"to":"acme-task","text":"hi"}'
const EXTRAS: string[][] = [['--dry-run'], ['--yes'], ['{"b":2}'], ['--json', '--force']]

/** A stand-in for the daemon's agent gateway: records every byte, answers nothing. */
async function recordingGateway(dir: string): Promise<{ sock: string; received: () => string; close: () => void }> {
  const sock = path.join(dir, 'gw.sock')
  let received = ''
  const server = net.createServer((c) => { c.on('data', (d) => { received += d.toString('utf-8') }) })
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  fs.chmodSync(sock, 0o600)
  return { sock, received: () => received, close: () => server.close() }
}

let dir = ''
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tca-'))
  for (const k of ['WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID']) savedEnv[k] = process.env[k]
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  process.exitCode = 0
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the rule', () => {
  it('names the first extra word, and lets a stray --json through', () => {
    expect(trailingArgsMessage([])).toBeNull()
    expect(trailingArgsMessage(['--json'])).toBeNull()
    expect(trailingArgsMessage(['--json', '--dry-run'])).toMatch(/^nothing was run: .* so --dry-run would have been ignored$/)
  })
})

describe('the in-session CLI (wn-cli.ts)', () => {
  it('parses an extra word as a usage error, and keeps --help and a stray --json', () => {
    for (const extra of EXTRAS) {
      const p = parseWalnutCliArgs(['tools', 'call', 'task_send', PAYLOAD, ...extra])
      expect(p).toMatchObject({ kind: 'usage-error', message: expect.stringMatching(/^nothing was run/) })
    }
    expect(parseWalnutCliArgs(['tools', 'call', 'task_list', '{}', '--json'])).toEqual({ kind: 'tools.call', name: 'task_list', rawJson: '{}' })
    expect(parseWalnutCliArgs(['tools', 'call', 'task_send', PAYLOAD, '--help'])).toEqual({ kind: 'tools.help', name: 'task_send' })
  })

  it('sends nothing to the gateway and exits 2', async () => {
    const gw = await recordingGateway(dir)
    process.env.WALNUT_AGENT_SOCKET = gw.sock
    process.env.WALNUT_SESSION_ID = 'probe-sid'
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await runWalnutCli(['tools', 'call', 'task_send', PAYLOAD, '--dry-run'])).toBe(2)
      expect(String(err.mock.calls[0]?.[0])).toMatch(/^walnut: nothing was run/)
    } finally {
      err.mockRestore()
    }
    await new Promise((r) => setTimeout(r, 100))
    expect(gw.received()).toBe('')
    gw.close()
  })
})

describe('the template CLI (daemon-source.ts)', () => {
  it('sends nothing to the gateway and exits 2', async () => {
    const twin = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(twin, getDaemonSource())
    const gw = await recordingGateway(dir)
    const run = (extra: string[]) => new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(SOURCE_TWIN.file, [twin, 'wn', 'tools', 'call', 'task_send', PAYLOAD, ...extra], {
        env: { ...process.env, WALNUT_DAEMON_DIR: dir, WALNUT_AGENT_SOCKET: gw.sock, WALNUT_SESSION_ID: 'probe-sid' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (d) => { err += d })
      child.on('close', (code) => resolve({ code, err }))
    })
    for (const extra of EXTRAS) {
      const r = await run(extra)
      expect(r.code).toBe(2)
      expect(r.err).toMatch(/^walnut: nothing was run: tools call reads <op> and one argument/)
      expect(r.err).toContain(`so ${extra.find((a) => a !== '--json')} would have been ignored`)
    }
    expect(gw.received()).toBe('')
    gw.close()
  }, 60_000)
})

describe('the hub CLI (commands/tools.ts)', () => {
  it('runs nothing, prints the refusal and exits 1', async () => {
    const errors: string[] = []
    const logs: string[] = []
    const e = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })
    const l = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })
    try {
      await runTools(['call', 'task_get', '{"id":"acme-none"}', '--dry-run'], {} as never)
    } finally {
      e.mockRestore()
      l.mockRestore()
    }
    expect(process.exitCode).toBe(1)
    expect(errors).toEqual([expect.stringMatching(/^nothing was run: .* so --dry-run would have been ignored$/)])
    expect(logs).toEqual([])
  })
})

describe('the MCP tool call (mcp-cli-args.ts)', () => {
  it('already takes one argument only', () => {
    expect(parseMcpCliArgs(['acme', 'tools', 'call', 'search', '{"q":"x"}', '--dry-run'])).toMatchObject({ kind: 'mcp.usage' })
  })
})

describe('ratchet: every place that reads a tools call argument refuses an extra word', () => {
  // file -> what in it refuses (each one is also run above).
  const READERS: Record<string, RegExp> = {
    'src/providers/wn-cli.ts': /trailingArgsMessage\(rest\.slice\(2\)\)/,
    'src/commands/tools.ts': /trailingArgsMessage\(rest\.slice\(1\)\)/,
    'src/providers/daemon-source.ts': /var wnExtra = rest\.slice\(2\)/,
    'src/commands/mcp-client.ts': /parseMcpCliArgs\(/,
  }

  function walk(d: string, out: string[]): string[] {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
    return out
  }

  it('finds exactly the known readers, each with its refusal', () => {
    const found = walk(path.join(ROOT, 'src'), [])
      .filter((f) => !f.endsWith('src/providers/tool-args-source.ts'))
      .filter((f) => /\bclassifyArgsSource\(|\bwnArgsSource\((?!raw\))/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
      .sort()
    // A new reader: make it refuse a word after the argument (trailingArgsMessage), then add it here.
    expect(found).toEqual(Object.keys(READERS).sort())
    for (const [file, refusal] of Object.entries(READERS)) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(refusal)
    }
  })
})

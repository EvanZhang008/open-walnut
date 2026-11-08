/** Every CLI face fails a `walnut tools call` as one JSON object with its old exit code (2026-11-06: `2>&1 | json.load` failed). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../../src/providers/daemon-source.js'
import { runTools } from '../../../src/commands/tools.js'
import { SOURCE_TWIN } from '../../helpers/source-twin.js'
import { spyCliStreams } from '../../helpers/cli-streams.js'

const REPO = path.resolve(__dirname, '../../..')
const REPRO = '{"q":"controller","types":["task","session"]}'
const REPRO_REFUSAL = {
  ok: false,
  error: {
    code: 'internal',
    message: 'Invalid arguments for search: types: Invalid input: expected string, received array; '
      + 'types takes one comma-separated string, e.g. "task,session", not a list',
  },
}

interface Run { code: number | null; out: string; err: string; received: string }
interface Failure { ok: false; error: { code: string; message: string; detail?: unknown } }

type Face = 'wn-cli' | 'twin'
let root = ''
let twinFile = ''
let runnerFile = ''

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcj-'))
  twinFile = path.join(root, 'daemon.cjs')
  fs.writeFileSync(twinFile, getDaemonSource())
  runnerFile = path.join(root, 'runner.ts')
  fs.writeFileSync(runnerFile, `import { runWalnutCli } from ${JSON.stringify(path.join(REPO, 'src/providers/wn-cli.ts'))}\n`
    + 'process.exit(await runWalnutCli(process.argv.slice(2)))\n')
})
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

function faceCommand(face: Face): string[] {
  return face === 'twin' ? [SOURCE_TWIN.file, twinFile, 'wn'] : [process.execPath, runnerFile]
}

/** A stand-in agent gateway in its own dir: records the request line, answers with `answer` (or nothing). */
async function gateway(answer: unknown | null): Promise<{ dir: string; sock: string; received: () => string; close: () => void }> {
  const dir = fs.mkdtempSync(path.join(root, 'g'))
  const sock = path.join(dir, 'gw.sock')
  let received = ''
  const server = net.createServer((c) => {
    c.on('data', (d) => {
      received += d.toString('utf-8')
      if (answer !== null && received.includes('\n')) c.write(JSON.stringify(answer) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  fs.chmodSync(sock, 0o600)
  return { dir, sock, received: () => received, close: () => server.close() }
}

/** One CLI run. `shell2to1`: through `sh -c '... 2>&1'`, exactly as the 2026-11-06 caller ran it. */
async function runFace(
  face: Face,
  argv: string[],
  answer: unknown | null,
  opts: { shell2to1?: boolean; env?: NodeJS.ProcessEnv; noSocket?: 'missing' | 'none' } = {},
): Promise<Run> {
  const gw = await gateway(answer)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: gw.dir,
    WALNUT_AGENT_SOCKET: opts.noSocket === 'missing' ? path.join(gw.dir, 'missing.sock') : gw.sock,
    WALNUT_SESSION_ID: 'probe-sid',
    WALNUT_CLI_WAIT_MS: '5000',
    ...opts.env,
  }
  // No injected socket and nothing at the well-known path: no daemon on this host.
  if (opts.noSocket === 'none') { delete env.WALNUT_AGENT_SOCKET; env.WALNUT_DAEMON_DIR = fs.mkdtempSync(path.join(root, 'e')) }
  const [cmd, ...pre] = faceCommand(face)
  const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`
  const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = opts.shell2to1
      ? spawn('/bin/sh', ['-c', `${[cmd, ...pre, ...argv].map(quote).join(' ')} 2>&1`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(cmd, [...pre, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, out, err }))
  })
  gw.close()
  return { ...r, received: gw.received() }
}

function failureIn(text: string): Failure {
  expect(text.trim().split('\n'), text).toHaveLength(1)
  const parsed = JSON.parse(text) as Failure
  expect(parsed.ok).toBe(false)
  expect(typeof parsed.error.code).toBe('string')
  expect(typeof parsed.error.message).toBe('string')
  return parsed
}

describe.each(['wn-cli', 'twin'] as const)('the %s face', (face) => {
  it('the 2026-11-06 call: one JSON object on stderr with the real reason, and `2>&1` parses', async () => {
    const r = await runFace(face, ['tools', 'call', 'search', REPRO], REPRO_REFUSAL)
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    const f = failureIn(r.err)
    expect(f.error.code).toBe('invalid_arguments')
    expect(f.error.message).toContain('types takes one comma-separated string, e.g. "task,session"')

    const both = await runFace(face, ['tools', 'call', 'search', REPRO], REPRO_REFUSAL, { shell2to1: true })
    expect(both.code).toBe(1)
    expect(both.err).toBe('')
    expect(JSON.parse(both.out)).toEqual(f)
  }, 60_000)

  it('--json before call, before the op, or after the JSON: the object on stdout, stderr empty', async () => {
    for (const argv of [
      ['tools', '--json', 'call', 'search', REPRO],
      ['tools', 'call', '--json', 'search', REPRO],
      ['tools', 'call', 'search', REPRO, '--json'],
    ]) {
      const r = await runFace(face, argv, REPRO_REFUSAL)
      expect(r.code, argv.join(' ')).toBe(1)
      expect(r.err, argv.join(' ')).toBe('')
      // The twin keeps its old envelope for a --json before call or the op.
      const legacy = face === 'twin' && argv.indexOf('--json') < argv.indexOf('search')
      if (legacy) expect(JSON.parse(r.out)).toEqual(REPRO_REFUSAL)
      else expect(failureIn(r.out).error.code).toBe('invalid_arguments')
      // The payload went out as written.
      expect(JSON.parse(r.received.trim()).args).toMatchObject({ name: 'search', args: { q: 'controller', types: ['task', 'session'] } })
    }
  }, 90_000)

  it('a success is the bare result, --json or not', async () => {
    const answer = { ok: true, result: { results: [{ type: 'task', title: 'Controller' }] } }
    for (const extra of [[], ['--json']]) {
      const r = await runFace(face, ['tools', 'call', 'search', '{"q":"controller"}', ...extra], answer)
      expect(r.code).toBe(0)
      expect(r.err).toBe('')
      expect(JSON.parse(r.out)).toEqual(answer.result)
    }
  }, 60_000)

  it('the twin keeps its old --json envelope before call or the op: success wrapped, error as the gateway sent it', async () => {
    if (face !== 'twin') return
    const ok = { ok: true, result: { a: 1 } }
    const throttled = { ok: false, error: { code: 'throttled', message: 'too many', retryAfterMs: 3000, detail: { outcome: 'Refused' } } }
    for (const pre of [['tools', '--json', 'call'], ['tools', 'call', '--json']]) {
      const s = await runFace(face, [...pre, 'task_list', '{}'], ok)
      expect(s.code).toBe(0)
      expect(JSON.parse(s.out)).toEqual(ok)
      const f = await runFace(face, [...pre, 'task_send', '{"to":"acme","text":"hi"}'], throttled)
      expect(f.code).toBe(4)
      expect(f.err).toBe('')
      expect(JSON.parse(f.out)).toEqual(throttled)
    }
    // A local failure is still the new object.
    const bad = await runFace(face, ['tools', '--json', 'call', 'search', '{"q":'], null)
    expect(bad.code).toBe(2)
    expect(failureIn(bad.out).error.code).toBe('invalid_json')
  }, 60_000)

  it('a --json word inside the JSON is text, never the flag', async () => {
    const r = await runFace(face, ['tools', 'call', 'task_send', '{"to":"acme","text":"--json"}'], { ok: true, result: { sent: true } })
    expect(r.code).toBe(0)
    // The call is the first line the gateway got; a carded op (task_send) sends its chat-card record after it.
    expect(JSON.parse(r.received.split('\n')[0]).args.args).toEqual({ to: 'acme', text: '--json' })
  }, 30_000)

  it('an op\'s detail stays on stdout by default and rides in the error with --json', async () => {
    const answer = { ok: false, error: { code: 'throttled', message: 'too many gateway writes', retryAfterMs: 3000, detail: { outcome: 'Refused, nothing changed' } } }
    const plain = await runFace(face, ['tools', 'call', 'task_send', '{"to":"acme","text":"hi"}'], answer)
    expect(plain.code).toBe(4)
    expect(JSON.parse(plain.out)).toEqual({ outcome: 'Refused, nothing changed' })
    expect(failureIn(plain.err)).toEqual({
      ok: false, error: { code: 'throttled', message: 'too many gateway writes\nretry after 3s — do not retry in a loop' },
    })
    const json = await runFace(face, ['tools', 'call', 'task_send', '{"to":"acme","text":"hi"}', '--json'], answer)
    expect(json.code).toBe(4)
    expect(json.err).toBe('')
    expect(failureIn(json.out).error.detail).toEqual({ outcome: 'Refused, nothing changed' })
  }, 60_000)

  it('an unknown op is unknown_op', async () => {
    const r = await runFace(face, ['tools', 'call', 'no_such_op', '{}'], { ok: false, error: { code: 'bad_request', message: 'unknown op: no_such_op — run `walnut tools list`' } })
    expect(r.code).toBe(1)
    expect(failureIn(r.err).error.code).toBe('unknown_op')
  }, 30_000)
})

/** Every local and transport failure, on both faces: same code, exit and streams; nothing sent where nothing may be. */
describe('the in-session CLI and its template twin agree on every failure', () => {
  const CASES: Array<{ name: string; argv: string[]; answer: unknown | null; code: string; exit: number; sends: boolean; opts?: Parameters<typeof runFace>[3] }> = [
    { name: 'malformed JSON', argv: ['tools', 'call', 'search', '{"q":'], answer: null, code: 'invalid_json', exit: 2, sends: false },
    { name: 'a JSON array', argv: ['tools', 'call', 'search', '["q"]'], answer: null, code: 'invalid_json', exit: 2, sends: false },
    { name: 'a word after the JSON', argv: ['tools', 'call', 'search', '{"q":"x"}', '--dry-run'], answer: null, code: 'usage_error', exit: 2, sends: false },
    { name: 'no op', argv: ['tools', 'call'], answer: null, code: 'usage_error', exit: 2, sends: false },
    { name: 'a bare @', argv: ['tools', 'call', 'search', '@'], answer: null, code: 'usage_error', exit: 2, sends: false },
    { name: 'a missing @file', argv: ['tools', 'call', 'search', '@/nope/acme-args.json'], answer: null, code: 'args_file', exit: 2, sends: false },
    { name: 'a "$" amount the shell cut', argv: ['tools', 'call', 'task_send', '{"to":"acme","text":"tea .99"}'], answer: null, code: 'shell_cut_text', exit: 2, sends: false, opts: { env: { WALNUT_TEXT_CHECK: '' } } },
    { name: 'a daemon socket that is gone', argv: ['tools', 'call', 'search', '{"q":"x"}'], answer: null, code: 'daemon_unreachable', exit: 6, sends: false, opts: { noSocket: 'missing' } },
    { name: 'no daemon on this host', argv: ['tools', 'call', 'search', '{"q":"x"}'], answer: null, code: 'no_daemon', exit: 6, sends: false, opts: { noSocket: 'none' } },
    { name: 'the server out of reach', argv: ['tools', 'call', 'search', '{"q":"x"}'], answer: { ok: false, error: { code: 'hub_unreachable', message: 'search needs the Walnut server' } }, code: 'hub_unreachable', exit: 5, sends: true },
    { name: 'the server timed out', argv: ['tools', 'call', 'search', '{"q":"x"}'], answer: { ok: false, error: { code: 'hub_timeout', message: 'primary server timed out' } }, code: 'hub_timeout', exit: 5, sends: true },
    { name: 'a server error code', argv: ['tools', 'call', 'search', '{"q":"x"}'], answer: { ok: false, error: { code: 'internal', message: 'Walnut API error (task_in_use): busy' } }, code: 'task_in_use', exit: 1, sends: true },
    { name: 'an unknown target', argv: ['tools', 'call', 'task_send', '{"to":"acme","text":"hi"}'], answer: { ok: false, error: { code: 'unknown_peer', message: 'no task acme' } }, code: 'unknown_peer', exit: 3, sends: true },
  ]

  it.each(CASES)('$name', async (c) => {
    const seen: Record<string, unknown> = {}
    for (const face of ['wn-cli', 'twin'] as const) {
      for (const json of [false, true]) {
        const r = await runFace(face, json ? [...c.argv, '--json'] : c.argv, c.answer, c.opts)
        const label = `${face}${json ? ' --json' : ''}`
        expect(r.code, label).toBe(c.exit)
        const f = failureIn(json ? r.out : r.err)
        expect(f.error.code, label).toBe(c.code)
        expect(json ? r.err : r.out, label).toBe('')
        expect(r.received !== '', label).toBe(c.sends)
        seen[label] = { code: r.code, error: f.error.code }
      }
    }
    expect(seen['twin']).toEqual(seen['wn-cli'])
    expect(seen['twin --json']).toEqual(seen['wn-cli --json'])
  }, 120_000)

  it('a malformed answer line: each face fails with one JSON object, as before with its own exit', async () => {
    for (const face of ['wn-cli', 'twin'] as const) {
      const dir = fs.mkdtempSync(path.join(root, 'm'))
      const sock = path.join(dir, 'gw.sock')
      const server = net.createServer((c) => { c.on('data', () => { c.write('not json\n') }) })
      await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
      fs.chmodSync(sock, 0o600)
      const [cmd, ...pre] = faceCommand(face)
      const r = await new Promise<{ code: number | null; err: string; out: string }>((resolve) => {
        const child = spawn(cmd, [...pre, 'tools', 'call', 'search', '{"q":"x"}'], {
          env: { ...process.env, WALNUT_DAEMON_DIR: dir, WALNUT_AGENT_SOCKET: sock, WALNUT_SESSION_ID: 'probe-sid' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (d) => { out += d })
        child.stderr.on('data', (d) => { err += d })
        child.on('close', (code) => resolve({ code, err, out }))
      })
      server.close()
      expect(r.code, face).not.toBe(0)
      expect(r.out, face).toBe('')
      failureIn(r.err)
    }
  }, 60_000)
})

describe('the hub CLI (src/commands/tools.ts)', () => {
  let server: http.Server
  let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, res) => res.end('{}')
  const hits: string[] = []
  const savedEnv: Record<string, string | undefined> = {}
  let logs: string[] = []
  let errors: string[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); reply(req, res) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  })
  afterAll(() => { server.close() })
  beforeEach(() => {
    for (const k of ['OPEN_WALNUT_API_URL', 'WALNUT_AGENT_SOCKET', 'WALNUT_SESSION_ID', 'WALNUT_TEXT_CHECK']) savedEnv[k] = process.env[k]
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    delete process.env.WALNUT_AGENT_SOCKET
    delete process.env.WALNUT_SESSION_ID
    delete process.env.WALNUT_TEXT_CHECK
    hits.length = 0
    logs = []
    errors = []
    process.exitCode = 0
    // A failure is written to the process streams, a success through console.log: both are caught.
    spyCliStreams({ out: (s) => logs.push(s), err: (s) => errors.push(s) })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    process.exitCode = 0
  })

  it('the 2026-11-06 call is refused before any request, as one JSON object on stderr', async () => {
    await runTools(['call', 'search', REPRO], {})
    expect(process.exitCode).toBe(1)
    expect(hits).toEqual([])
    expect(logs).toEqual([])
    expect(errors).toHaveLength(1)
    const f = failureIn(errors[0])
    expect(f.error.code).toBe('invalid_arguments')
    expect(f.error.message).toBe(REPRO_REFUSAL.error.message)
  })

  it('--json in each place: the object on stdout, nothing on stderr', async () => {
    for (const [argv, globals] of [
      [['--json', 'call', 'search', REPRO], {}],
      [['call', '--json', 'search', REPRO], {}],
      [['call', 'search', REPRO, '--json'], {}],
      // The entry strips a --json anywhere and passes it as the global flag.
      [['call', 'search', REPRO], { json: true }],
    ] as const) {
      logs = []
      errors = []
      process.exitCode = 0
      await runTools([...argv], { ...globals })
      expect(process.exitCode, argv.join(' ')).toBe(1)
      expect(errors, argv.join(' ')).toEqual([])
      expect(logs).toHaveLength(1)
      expect(failureIn(logs[0]).error.code).toBe('invalid_arguments')
    }
  })

  it('a success is the bare result, --json or not; the flag form takes --json where a flag stands', async () => {
    reply = (_q, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ results: [] })) }
    for (const argv of [['call', 'search', '{"q":"x"}', '--json'], ['call', 'search', '--q', 'x', '--json']]) {
      logs = []
      await runTools(argv, {})
      expect(process.exitCode ?? 0).toBe(0)
      expect(errors).toEqual([])
      expect(JSON.parse(logs.join('\n'))).toEqual({ results: [] })
    }
    // A flag's value is the value, even when it reads --json.
    logs = []
    hits.length = 0
    await runTools(['call', 'search', '--q', '--json'], {})
    expect(hits[0]).toContain('q=--json')
  })

  it('a server refusal keeps its code; an empty 200 is empty_response', async () => {
    reply = (_q, res) => { res.statusCode = 409; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { code: 'task_in_use', message: 'busy' } })) }
    await runTools(['call', 'search', '{"q":"x"}'], {})
    expect(process.exitCode).toBe(1)
    expect(failureIn(errors[0]).error).toEqual({ code: 'task_in_use', message: 'Walnut API error (task_in_use): busy' })

    errors = []
    process.exitCode = 0
    reply = (_q, res) => { res.statusCode = 200; res.end('') }
    await runTools(['call', 'search', '{"q":"x"}', '--json'], {})
    expect(process.exitCode).toBe(1)
    expect(errors).toEqual([])
    expect(failureIn(logs[logs.length - 1]).error.code).toBe('empty_response')
  })

  it('every local refusal is one JSON object, with the exit code it had', async () => {
    const cases: Array<[string[], string, number]> = [
      [['call'], 'usage_error', 1],
      [['call', 'search', '{"q":'], 'invalid_json', 1],
      [['call', 'search', '{"q":"x"}', '--dry-run'], 'usage_error', 1],
      [['call', 'search', '@/nope/acme-args.json'], 'args_file', 1],
      [['call', 'search', '--nope', 'x'], 'usage_error', 1],
      [['call', 'no_such_op', '{}'], 'unknown_op', 1],
      [['call', 'no_such_op', '--q', 'x'], 'unknown_op', 1],
      [['call', 'task_create', '{"title":"tea .99"}'], 'shell_cut_text', 2],
    ]
    for (const [argv, code, exit] of cases) {
      for (const json of [false, true]) {
        logs = []
        errors = []
        process.exitCode = 0
        await runTools(json ? ['--json', ...argv] : argv, {})
        const label = `${argv.join(' ')}${json ? ' --json' : ''}`
        expect(process.exitCode, label).toBe(exit)
        expect(json ? errors : logs, label).toEqual([])
        expect(json ? logs : errors, label).toHaveLength(1)
        expect(failureIn((json ? logs : errors)[0]).error.code, label).toBe(code)
      }
    }
    expect(hits).toEqual([])
  })
})

/** Ratchet: no call failure path prints plain text again (each face counted from its source). */
describe('ratchet: a call fails only through the one JSON object', () => {
  const read = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8')

  it('the hub CLI: its call branch writes stderr in one place, the failure renderer', () => {
    const src = read('src/commands/tools.ts')
    const branch = src.slice(src.indexOf("if (sub === 'call') {"), src.indexOf('\n  console.error(`unknown tools'))
    // Raw stream writes only: bun's console.error paints red under FORCE_COLOR, even into a pipe.
    expect(branch.match(/process\.stderr\.write\(/g)).toHaveLength(1)
    expect(branch).not.toMatch(/console\.error\(/)
  })

  it('the in-session CLI: the call argument block writes no stderr of its own', () => {
    const src = read('src/providers/wn-cli.ts')
    const start = src.indexOf("if (parsed.kind === 'tools.call') {\n    const source = classifyArgsSource")
    expect(start).toBeGreaterThan(0)
    const block = src.slice(start, src.indexOf("if (parsed.kind === 'wait') {", start))
    expect(block).not.toMatch(/process\.stderr\.write\(/)
  })

  it('the template twin: the call branch fails through wnFail only', () => {
    const src = read('src/providers/daemon-source.ts')
    const start = src.indexOf('var wnExtra = rest.slice(2)')
    const block = src.slice(start, src.indexOf("op = 'tools.call';", start))
    expect(block).not.toMatch(/errOut\(/)
    expect(block.match(/wnFail\(/g)).toHaveLength(5)
  })
})

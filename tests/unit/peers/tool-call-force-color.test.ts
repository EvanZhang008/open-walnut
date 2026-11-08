// Why: under FORCE_COLOR=1 bun's console.error colored the hub's failure JSON even into a pipe (2026-11-07).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../../src/providers/daemon-source.js'
import { helpText, parseWalnutCliArgs } from '../../../src/providers/wn-cli.js'
import { SOURCE_TWIN } from '../../helpers/source-twin.js'
import { guardedPath } from '../../setup/exec-guard.js'

const REPO = path.resolve(__dirname, '../../..')
const REPRO = '{"q":"controller","types":["task","session"]}'
const REFUSAL = {
  ok: false,
  error: {
    code: 'internal',
    message: 'Invalid arguments for search: types: Invalid input: expected string, received array; '
      + 'types takes one comma-separated string, e.g. "task,session", not a list',
  },
}
const RESULT = { results: [{ type: 'task', title: 'Controller' }] }
const ESC = '\u001b'
const RUN_DEADLINE_MS = 20_000

type Entry = 'hub' | 'full' | 'minimal'
interface Run { code: number | null; out: string; err: string }

let root = ''
let hubRunner = ''
let fullRunner = ''
let twinFile = ''
let api: http.Server
let apiUrl = ''
// Every request the hub entry's API saw, and every line a fake gateway was sent: a local answer sends none.
const apiHits: string[] = []

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcfc-'))
  hubRunner = path.join(root, 'hub.ts')
  fs.writeFileSync(hubRunner, `import { runTools } from ${JSON.stringify(path.join(REPO, 'src/commands/tools.ts'))}\n`
    + 'await runTools(process.argv.slice(2), {})\n')
  fullRunner = path.join(root, 'full.ts')
  fs.writeFileSync(fullRunner, `import { runWalnutCli } from ${JSON.stringify(path.join(REPO, 'src/providers/wn-cli.ts'))}\n`
    + 'process.exit(await runWalnutCli(process.argv.slice(2)))\n')
  twinFile = path.join(root, 'daemon.cjs')
  fs.writeFileSync(twinFile, getDaemonSource())
  api = http.createServer((req, res) => { apiHits.push(`${req.method} ${req.url}`); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(RESULT)) })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', () => resolve()))
  apiUrl = `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()))
  fs.rmSync(root, { recursive: true, force: true })
})

async function gateway(answer: unknown): Promise<{ dir: string; sock: string; requests: unknown[]; close: () => void }> {
  const dir = fs.mkdtempSync(path.join(root, 'g'))
  const sock = path.join(dir, 'gw.sock')
  const requests: unknown[] = []
  const server = net.createServer((c) => {
    let got = ''
    let answered = false
    c.on('data', (d) => {
      got += d.toString('utf-8')
      if (answered || !got.includes('\n')) return
      answered = true
      const line = got.slice(0, got.indexOf('\n'))
      try { requests.push(JSON.parse(line)) } catch { requests.push(line) }
      c.write(JSON.stringify(answer) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  fs.chmodSync(sock, 0o600)
  return { dir, sock, requests, close: () => server.close() }
}

function command(entry: Entry): string[] {
  if (entry === 'hub') return [process.execPath, hubRunner]
  if (entry === 'full') return [process.execPath, fullRunner, 'tools']
  return [SOURCE_TWIN.file, twinFile, 'wn', 'tools']
}

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`

async function entryEnv(entry: Entry, answer: unknown): Promise<{ env: NodeJS.ProcessEnv; requests: () => unknown[]; close: () => void }> {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '1' }
  delete env.NO_COLOR
  if (entry === 'hub') {
    delete env.WALNUT_AGENT_SOCKET
    delete env.WALNUT_SESSION_ID
    env.OPEN_WALNUT_API_URL = apiUrl
    env.OPEN_WALNUT_HOME = fs.mkdtempSync(path.join(root, 'h'))
    const from = apiHits.length
    return { env, requests: () => apiHits.slice(from), close: () => {} }
  }
  const gw = await gateway(answer)
  Object.assign(env, { WALNUT_DAEMON_DIR: gw.dir, WALNUT_AGENT_SOCKET: gw.sock, WALNUT_SESSION_ID: 'probe-sid', WALNUT_CLI_WAIT_MS: '5000' })
  return { env, requests: () => gw.requests.slice(), close: gw.close }
}

// Own process group, so a timeout reaps this probe's shell and its children only.
function collect(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise<Run>((resolve) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
      resolve({ code: null, out, err: `${err}\n[test] no exit within ${RUN_DEADLINE_MS} ms` })
    }, RUN_DEADLINE_MS)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: `${err}\n[test] spawn failed: ${e.message}` }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

async function run(entry: Entry, argv: string[], answer: unknown, merged = false): Promise<Run> {
  const { env, close } = await entryEnv(entry, answer)
  const full = [...command(entry), ...argv]
  const r = merged
    ? await collect('/bin/sh', ['-c', `exec ${full.map(quote).join(' ')} 2>&1`], env)
    : await collect(full[0], full.slice(1), env)
  close()
  return r
}

interface Parsed { ok?: boolean; error: { code: string; message: string }; [key: string]: unknown }

function plainJson(text: string, label: string): Parsed {
  expect(text.includes(ESC), `${label}: ANSI in ${JSON.stringify(text)}`).toBe(false)
  return JSON.parse(text) as Parsed
}

describe.each(['hub', 'full', 'minimal'] as const)('the %s entry with FORCE_COLOR=1 and piped output', (entry) => {
  const usageExit = entry === 'hub' ? 1 : 2

  it('a local refusal is one plain JSON object: stderr by default, stdout with --json', async () => {
    const plain = await run(entry, ['call', 'search', '{"q":'], null)
    expect(plain.code).toBe(usageExit)
    expect(plain.out).toBe('')
    expect(plainJson(plain.err, 'stderr').error.code).toBe('invalid_json')

    const json = await run(entry, ['call', 'search', '{"q":', '--json'], null)
    expect(json.code).toBe(usageExit)
    expect(json.err).toBe('')
    expect(plainJson(json.out, 'stdout').error.code).toBe('invalid_json')
  }, 60_000)

  it('a refused call keeps its code and exit, and `2>&1` still parses', async () => {
    const r = await run(entry, ['call', 'search', REPRO], REFUSAL)
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    const f = plainJson(r.err, 'stderr')
    expect(f).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    expect(f.error.message).toContain('types takes one comma-separated string')

    const both = await run(entry, ['call', 'search', REPRO], REFUSAL, true)
    expect(both.code).toBe(1)
    expect(plainJson(both.out, 'merged')).toEqual(f)
  }, 60_000)

  it('a success is the bare result, plain', async () => {
    for (const extra of [[], ['--json']]) {
      const r = await run(entry, ['call', 'search', '{"q":"controller"}', ...extra], { ok: true, result: RESULT })
      expect(r.code, extra.join(' ')).toBe(0)
      expect(r.err, extra.join(' ')).toBe('')
      expect(plainJson(r.out, 'stdout')).toEqual(RESULT)
    }
  }, 60_000)
})

// The capture recipe the skill and `walnut tools help` give scripts, run as written against a fake `walnut`.
const SKILL = fs.readFileSync(path.join(REPO, 'src/data/skills/walnut/SKILL.md'), 'utf-8')
const CONSUME = "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write('CONSUMED '+JSON.stringify(d.results)+'\\n')"
const CONSUMER = `printf '%s\\n' "$out" | "$PROBE_BUN" -e "$PROBE_CONSUME"`
const CAPTURE_LINE = /^\s*out=\$\(walnut tools call search ('[^']*') --json\) \|\| \{$/

interface Recipe { capture: string; payload: string }

function captureOf(text: string, label: string): Recipe {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => CAPTURE_LINE.test(l))
  expect(start, `${label}: no capture line`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((l, i) => i > start && l.trim() === '}')
  expect(end, `${label}: capture block not closed`).toBeGreaterThan(start)
  const capture = lines.slice(start, end + 1).join('\n')
  for (const part of ['rc=$?', `printf '%s\\n' "$out" >&2`, 'exit "$rc"']) expect(capture, label).toContain(part)
  expect(capture, label).not.toContain('2>&1')
  return { capture, payload: CAPTURE_LINE.exec(lines[start])![1] }
}

function skillRecipe(): Recipe {
  const at = SKILL.indexOf('## Calling it')
  expect(at).toBeGreaterThanOrEqual(0)
  const section = SKILL.slice(at, SKILL.indexOf('\n## ', at + 1))
  const block = /```bash\n(out=\$\([\s\S]*?)```/.exec(section)
  expect(block, 'no capture block under Calling it').not.toBeNull()
  const recipe = captureOf(block![1], 'SKILL.md')
  const rest = block![1].slice(block![1].indexOf(recipe.capture) + recipe.capture.length).trim()
  expect(rest, 'the parse runs only after the capture').toMatch(/^printf '%s\\n' "\$out" \| /)
  return recipe
}

const RECIPES: Record<string, () => Recipe> = { skill: skillRecipe, help: () => captureOf(helpText('tools'), 'tools help') }

async function runRecipe(entry: Entry, recipe: Recipe, payload: string | null, answer: unknown): Promise<Run> {
  const { env, close } = await entryEnv(entry, answer)
  const bin = fs.mkdtempSync(path.join(root, 'b'))
  const [file, ...pre] = entry === 'hub' ? [process.execPath, hubRunner] : entry === 'full' ? [process.execPath, fullRunner] : [SOURCE_TWIN.file, twinFile, 'wn']
  const shift = entry === 'hub' ? '[ "$1" = tools ] && shift\n' : ''
  fs.writeFileSync(path.join(bin, 'walnut'), `#!/bin/sh\n${shift}exec ${[file, ...pre].map(quote).join(' ')} "$@"\n`, { mode: 0o755 })
  const capture = payload === null ? recipe.capture : recipe.capture.replace(recipe.payload, '"$PROBE_PAYLOAD"')
  Object.assign(env, { PATH: guardedPath([bin], env.PATH ?? ''), PROBE_BUN: process.execPath, PROBE_CONSUME: CONSUME, PROBE_PAYLOAD: payload ?? '' })
  const r = await collect('/bin/sh', ['-c', `${capture}\n${CONSUMER}\n`], env)
  close()
  return r
}

describe.each(['hub', 'full', 'minimal'] as const)('the capture recipe through the %s entry with FORCE_COLOR=1', (entry) => {
  it.each(Object.keys(RECIPES))('%s: a refusal keeps exit 1 and its hint on stderr, and the parser never runs', async (name) => {
    const r = await runRecipe(entry, RECIPES[name](), REPRO, REFUSAL)
    expect(r.code, r.err).toBe(1)
    expect(r.out).toBe('')
    const f = plainJson(r.err, 'stderr')
    expect(f).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    expect(f.error.message).toContain('types takes one comma-separated string')
  }, 60_000)

  it.each(Object.keys(RECIPES))('%s: a success is parsed for its results', async (name) => {
    const r = await runRecipe(entry, RECIPES[name](), null, { ok: true, result: RESULT })
    expect(r.code, r.err).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toBe(`CONSUMED ${JSON.stringify(RESULT.results)}\n`)
  }, 60_000)
})

// Why: `tools call --help` took --help for the op name and read an open, non-tty stdin to its end, so it never returned (2026-11-07).
// These runs hold the child's stdin open until it exits; an answer that waits on stdin fails on the deadline, never on a closed pipe.
const HELD_DEADLINE_MS = 8_000
const MINIMAL_USAGE = 'walnut tools call <op> [json|@file|-|--help]'
const CATALOG = {
  ok: true,
  result: { ops: [{ name: 'search', title: 'Search', readonly: true, description: 'Probe catalog row', params: [{ name: 'q', type: 'string', required: true, description: 'probe query' }] }] },
}

interface HeldRun extends Run { requests: unknown[] }

// Own process group; only that group is killed, and only when it misses the deadline.
function collectHeld(file: string, args: string[], env: NodeJS.ProcessEnv, stdinText: string | null): Promise<Run> {
  return new Promise<Run>((resolve) => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let out = ''
    let err = ''
    let late = ''
    child.stdin.on('error', () => {})
    if (stdinText !== null) child.stdin.end(stdinText)
    const timer = setTimeout(() => {
      late = `\n[test] no exit within ${HELD_DEADLINE_MS} ms with stdin held open`
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, HELD_DEADLINE_MS)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); child.stdin.destroy(); resolve({ code: null, out, err: `${err}\n[test] spawn failed: ${e.message}` }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      child.stdin.destroy()
      resolve(late ? { code: null, out, err: err + late } : { code, out, err })
    })
  })
}

async function runHeld(entry: Entry, argv: string[], answer: unknown, stdinText: string | null = null): Promise<HeldRun> {
  const { env, requests, close } = await entryEnv(entry, answer)
  const full = [...command(entry), ...argv]
  const r = await collectHeld(full[0], full.slice(1), env, stdinText)
  const seen = requests()
  close()
  return { ...r, requests: seen }
}

const HELP_FORMS = [
  ['call', '--help'], ['call', '-h'],
  ['--json', 'call', '--help'], ['call', '--json', '-h'],
  ['call', '--help', '--json'], ['call', '-h', '--json'],
].map((argv) => ({ argv, label: argv.join(' ') }))

const USAGE_FORMS = [
  { argv: ['call', '--bogus'], json: false },
  { argv: ['call', '--bogus', '--json'], json: true },
  { argv: ['--json', 'call', '--bogus'], json: true },
  { argv: ['call', '--json', '--bogus'], json: true },
  { argv: ['call'], json: false },
  { argv: ['call', '--json'], json: true },
  { argv: ['--json', 'call'], json: true },
].map((f) => ({ ...f, label: f.argv.join(' ') }))

const NAMED_HELP = [['call', 'search', '--help'], ['call', 'search', '-', '--help']].map((argv) => ({ argv, label: argv.join(' ') }))

describe.each(['hub', 'full', 'minimal'] as const)('a tools call with no op name through the %s entry, stdin held open', (entry) => {
  const usageExit = entry === 'hub' ? 1 : 2

  it.each(HELP_FORMS)('`$label` prints the tools help at once, plain, and asks no one', async ({ argv }) => {
    const r = await runHeld(entry, argv, { ok: true, result: RESULT })
    expect(r.code, r.err).toBe(0)
    expect(r.err).toBe('')
    expect(r.out.includes(ESC), `ANSI in ${JSON.stringify(r.out)}`).toBe(false)
    if (entry === 'minimal') {
      expect(r.out).toContain(MINIMAL_USAGE)
      expect(r.out).toContain('skill_read')
    } else {
      expect(r.out.trim()).toBe(helpText('tools').trim())
    }
    expect(r.requests).toEqual([])
  }, 30_000)

  it.each(USAGE_FORMS)('`$label` is one usage_error JSON object, and nothing is sent', async ({ argv, json }) => {
    const r = await runHeld(entry, argv, { ok: true, result: RESULT })
    expect(r.code, r.err).toBe(usageExit)
    const [body, other] = json ? [r.out, r.err] : [r.err, r.out]
    expect(other).toBe('')
    const f = plainJson(body, json ? 'stdout' : 'stderr')
    expect(f).toMatchObject({ ok: false, error: { code: 'usage_error' } })
    expect(Object.keys(f).sort()).toEqual(['error', 'ok'])
    expect(f.error.message).toContain('tools call')
    expect(r.requests).toEqual([])
  }, 30_000)

  it.each(NAMED_HELP)('`$label` still shows that op\'s schema without reading stdin', async ({ argv }) => {
    const r = await runHeld(entry, argv, CATALOG)
    expect(r.code, r.err).toBe(0)
    expect(r.out.includes(ESC)).toBe(false)
    expect(r.out.split('\n')[0]).toBe('search')
    expect(r.out).toContain('  q (string')
    if (entry === 'hub') expect(r.requests).toEqual([])
    else {
      expect(r.requests).toHaveLength(1)
      expect(r.requests[0]).toMatchObject({ op: 'tools.list', args: { name: 'search' } })
    }
  }, 30_000)

  it('a named op still reads its JSON from a piped stdin', async () => {
    const r = await runHeld(entry, ['call', 'search'], { ok: true, result: RESULT }, '{"q":"controller"}\n')
    expect(r.code, r.err).toBe(0)
    expect(r.err).toBe('')
    expect(plainJson(r.out, 'stdout')).toEqual(RESULT)
    if (entry === 'hub') expect(r.requests.length).toBeGreaterThan(0)
    else {
      expect(r.requests).toHaveLength(1)
      expect(r.requests[0]).toMatchObject({ op: 'tools.call', args: { name: 'search', args: { q: 'controller' } } })
    }
  }, 30_000)
})

describe('parseWalnutCliArgs: a tools call with no op name never reaches the endpoint', () => {
  it.each(HELP_FORMS)('`tools $label` is the tools help', ({ argv }) => {
    expect(parseWalnutCliArgs(['tools', ...argv])).toEqual({ kind: 'help', topic: 'tools' })
  })

  it.each(USAGE_FORMS)('`tools $label` is a tools call usage error', ({ argv, json }) => {
    expect(parseWalnutCliArgs(['tools', ...argv])).toEqual({ kind: 'usage-error', message: 'tools call requires <op>', toolsCall: { json } })
  })

  it.each(NAMED_HELP)('`tools $label` asks for that op\'s help', ({ argv }) => {
    expect(parseWalnutCliArgs(['tools', ...argv])).toEqual({ kind: 'tools.help', name: 'search' })
  })

  it('a named op with no argument is a call that reads stdin', () => {
    expect(parseWalnutCliArgs(['tools', 'call', 'search'])).toEqual({ kind: 'tools.call', name: 'search', rawJson: undefined })
  })
})

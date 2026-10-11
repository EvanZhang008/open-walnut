/**
 * Native Codex model probe (codex app-server JSON-RPC). Every probe test
 * spawns a REAL stub `codex` process from an isolated temp dir: the stub logs
 * its argv, cwd, env keys and every message it receives, and answers from a
 * per-test plan. Only the codex binary is stubbed, never the protocol.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'

import {
  probeCodexModels,
  codexConfigModelOverlay,
  codexProjectTrustArg,
  resolveCodexCurrentModelId,
  normalizeCodexModelDisplayName,
  type CodexModelRow,
} from '../../src/providers/codex-model-probe.js'

/** A fake credential: it must never reach argv or an error message. */
const SECRET = 'sk-test-SECRET-4242'

interface StubPlan {
  config?: Record<string, unknown>
  pages?: Record<string, unknown>
  errorOn?: string
  errorMessage?: string
  invalidJsonOn?: string
  silentOn?: string
  exitOn?: string
  exitCode?: number
  stderr?: string
  ignoreStdinEnd?: boolean
  splitBytes?: boolean
  holdConfigUntilList?: boolean
  spawnHolder?: boolean
}

type LogEntry =
  | { type: 'start'; argv: string[]; cwd: string; envKeys: string[] }
  | { type: 'msg'; msg: Record<string, unknown> }
  | { type: 'stdin-end' }
  | { type: 'signal'; sig: string }
  | { type: 'exit' }
  | { type: 'holder-start' }
  | { type: 'holder-signal'; sig: string }
  | { type: 'holder-exit' }

// A descendant that keeps the stub's stdout/stderr open after the stub exits.
// It dies on SIGTERM, and on its own after 10s so a failed test leaks nothing.
const HOLDER_SOURCE = `
const fs = require('node:fs')
const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
log({ type: 'holder-start' })
process.on('SIGTERM', () => { log({ type: 'holder-signal', sig: 'SIGTERM' }); process.exit(0) })
process.on('exit', () => log({ type: 'holder-exit' }))
setTimeout(() => process.exit(0), 10000)
`

// CommonJS stub (no package.json in the temp dir). Split writes cut UTF-8
// sequences in the middle on purpose, so the probe must decode across chunks.
const STUB_SOURCE = `
const fs = require('node:fs')
const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
const plan = JSON.parse(fs.readFileSync(process.env.STUB_PLAN, 'utf8'))
log({ type: 'start', argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env).sort() })
process.on('SIGTERM', () => { log({ type: 'signal', sig: 'SIGTERM' }); process.exit(143) })
process.on('exit', () => log({ type: 'exit' }))
if (plan.spawnHolder) {
  require('node:child_process').spawn(process.execPath, ['-e', process.env.HOLDER_SOURCE], { stdio: ['ignore', 'inherit', 'inherit'] })
}
const out = (obj) => {
  const buf = Buffer.from(JSON.stringify(obj) + '\\n', 'utf8')
  if (!plan.splitBytes) { process.stdout.write(buf); return }
  const cuts = []
  for (let i = 0; i < buf.length; i++) if (buf[i] >= 0xc0) cuts.push(i + 1)
  let at = 0
  const pieces = []
  for (const cut of cuts) { pieces.push(buf.subarray(at, cut)); at = cut }
  pieces.push(buf.subarray(at))
  const step = () => { const piece = pieces.shift(); if (!piece) return; process.stdout.write(piece); setTimeout(step, 5) }
  step()
}
let heldConfig = null
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('close', () => {
  log({ type: 'stdin-end' })
  if (plan.ignoreStdinEnd) setInterval(() => {}, 1000)
  else process.exit(0)
})
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  log({ type: 'msg', msg })
  if (typeof msg.method !== 'string' || msg.id === undefined) return
  const m = msg.method
  if (plan.exitOn === m) { fs.writeSync(2, plan.stderr || ''); process.exit(plan.exitCode || 3) }
  if (plan.silentOn === m) return
  if (plan.invalidJsonOn === m) { process.stdout.write('{not json ' + process.env.STUB_SECRET + '\\n'); return }
  if (plan.errorOn === m) { out({ id: msg.id, error: { code: -32600, message: plan.errorMessage } }); return }
  if (m === 'initialize') {
    out({ method: 'configWarning', params: { summary: 'one setting ignored' } })
    out({ id: 'srv-1', method: 'item/tool/requestUserInput', params: {} })
    out({ id: msg.id, result: { userAgent: 'stub/1', codexHome: process.env.HOME } })
  } else if (m === 'config/read') {
    const reply = { id: msg.id, result: { config: plan.config || {}, origins: {}, layers: null } }
    if (plan.holdConfigUntilList) heldConfig = reply
    else out(reply)
  } else if (m === 'model/list') {
    out({ id: msg.id, result: plan.pages[msg.params.cursor === null ? '' : msg.params.cursor] })
    if (heldConfig) { out(heldConfig); heldConfig = null }
  } else {
    out({ id: msg.id, error: { code: -32601, message: 'unexpected ' + m } })
  }
})
`

let dir: string
let workDir: string
let logPath: string
let planPath: string
let binary: string
let baseEnv: NodeJS.ProcessEnv

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-probe-'))
  workDir = path.join(dir, 'work')
  fs.mkdirSync(workDir)
  fs.mkdirSync(path.join(dir, 'home'))
  logPath = path.join(dir, 'stub.log')
  planPath = path.join(dir, 'plan.json')
  binary = path.join(dir, 'codex')
  fs.writeFileSync(binary, `#!${process.execPath}\n${STUB_SOURCE}`, { mode: 0o755 })
  // A minimal env built from scratch: nothing of this machine's codex,
  // provider or cloud credentials can reach the stub.
  baseEnv = {
    PATH: guardedPath([], ['/usr/bin', '/bin'].join(path.delimiter)),
    HOME: path.join(dir, 'home'),
    STUB_LOG: logPath,
    STUB_PLAN: planPath,
    STUB_SECRET: SECRET,
    HOLDER_SOURCE,
  }
})

afterEach(async () => {
  // Every process a test started must be gone before its dir is: each one
  // still appends to the log on exit.
  const entries = readLog()
  if (entries.some((e) => e.type === 'start')) await waitForLog(exited)
  if (entries.some((e) => e.type === 'holder-start')) await waitForLog((es) => es.some((e) => e.type === 'holder-exit'), 12_000)
  fs.rmSync(dir, { recursive: true, force: true })
})

function writePlan(plan: StubPlan): void {
  fs.writeFileSync(planPath, JSON.stringify(plan))
}

function readLog(): LogEntry[] {
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry)
}

async function waitForLog(pred: (entries: LogEntry[]) => boolean, ms = 6_000): Promise<LogEntry[]> {
  const until = Date.now() + ms
  for (;;) {
    const entries = readLog()
    if (pred(entries)) return entries
    if (Date.now() > until) throw new Error(`stub log never matched: ${JSON.stringify(entries)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const exited = (entries: LogEntry[]) => entries.some((e) => e.type === 'exit')
const startOf = (entries: LogEntry[]) => entries.find((e) => e.type === 'start') as Extract<LogEntry, { type: 'start' }>
const trustArg = (cwd: string) => `projects={ ${JSON.stringify(cwd)} = { trust_level = "trusted" } }`

function row(over: Partial<CodexModelRow> & { id: string }): CodexModelRow {
  return {
    displayName: over.id,
    description: `${over.id} description.`,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast.' },
      { reasoningEffort: 'high', description: 'Deep.' },
    ],
    defaultReasoningEffort: 'low',
    isDefault: false,
    ...over,
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(() => undefined, (e: unknown) => e)
  expect(err).toBeInstanceOf(Error)
  return err as Error
}

describe('probeCodexModels', () => {
  it('speaks only initialize, initialized, config/read and paginated model/list, then exits gracefully', async () => {
    writePlan({
      config: { model: 'gpt-5-codex', model_reasoning_effort: 'high' },
      pages: {
        '': { data: [row({ id: 'gpt-5-codex', isDefault: true })], nextCursor: 'page-2' },
        'page-2': {
          data: [row({
            id: 'gpt-5-codex-mini',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced.' }],
            defaultReasoningEffort: 'medium',
          })],
          nextCursor: null,
        },
      },
    })
    const result = await probeCodexModels(binary, { cwd: workDir, env: baseEnv })

    expect(result).toEqual({
      currentModelId: 'gpt-5-codex[high]',
      models: [
        { modelId: 'gpt-5-codex[low]', name: 'GPT-5-Codex (low)', description: 'gpt-5-codex description. Fast.' },
        { modelId: 'gpt-5-codex[high]', name: 'GPT-5-Codex (high)', description: 'gpt-5-codex description. Deep.' },
        { modelId: 'gpt-5-codex-mini[medium]', name: 'GPT-5-Codex-Mini (medium)', description: 'gpt-5-codex-mini description. Balanced.' },
      ],
    })

    const entries = await waitForLog(exited)
    const start = startOf(entries)
    expect(start).toMatchObject({ argv: ['app-server', '-c', trustArg(workDir)], cwd: fs.realpathSync(workDir) })
    // Only the env the caller passed (macOS may add its CF encoding var).
    const allowed = new Set(Object.keys(baseEnv))
    expect(start.envKeys.filter((k) => !allowed.has(k) && !k.startsWith('__CF'))).toEqual([])

    const received = entries.flatMap((e) => (e.type === 'msg' ? [e.msg] : []))
    // The server request is answered with an error, never granted.
    expect(received.filter((m) => m.id === 'srv-1')).toEqual([
      { jsonrpc: '2.0', id: 'srv-1', error: { code: -32601, message: 'not supported by the model probe' } },
    ])
    expect(received.filter((m) => m.id !== 'srv-1')).toEqual([
      {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          clientInfo: { name: 'walnut-model-probe', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      },
      { jsonrpc: '2.0', method: 'initialized' },
      { jsonrpc: '2.0', id: 2, method: 'config/read', params: { includeLayers: false, cwd: workDir } },
      { jsonrpc: '2.0', id: 3, method: 'model/list', params: { cursor: null, limit: null } },
      { jsonrpc: '2.0', id: 4, method: 'model/list', params: { cursor: 'page-2', limit: null } },
    ])
    // stdin EOF was enough: no signal reached the process.
    expect(entries.some((e) => e.type === 'stdin-end')).toBe(true)
    expect(entries.some((e) => e.type === 'signal')).toBe(false)
  })

  it('sends config/read and model/list together', async () => {
    // The stub answers config/read only after model/list arrives; a sequential
    // probe would wait out its deadline.
    writePlan({
      holdConfigUntilList: true,
      config: { model: 'm' },
      pages: { '': { data: [row({ id: 'm' })], nextCursor: null } },
    })
    const result = await probeCodexModels(binary, { cwd: workDir, env: baseEnv, timeoutMs: 3_000 })
    expect(result.currentModelId).toBe('m[low]')
  })

  it('applies the CODEX_CONFIG model and effort over config/read, keeping argv and catalog native', async () => {
    writePlan({
      config: { model: 'a', model_reasoning_effort: 'low' },
      pages: { '': { data: [row({ id: 'a', isDefault: true }), row({ id: 'b' })], nextCursor: null } },
    })
    const env = {
      ...baseEnv,
      CODEX_CONFIG: JSON.stringify({
        model: 'b',
        model_reasoning_effort: 'high',
        model_providers: { p: { experimental_bearer_token: SECRET } },
      }),
      MODEL_PROVIDER: 'p',
    }
    const result = await probeCodexModels(binary, { cwd: workDir, env })
    expect(result.currentModelId).toBe('b[high]')
    expect(result.models.map((m) => m.modelId)).toEqual(['a[low]', 'a[high]', 'b[low]', 'b[high]'])
    const start = startOf(await waitForLog(exited))
    expect(start.argv).toEqual(['app-server', '-c', trustArg(workDir)])
    expect(JSON.stringify(start.argv)).not.toContain(SECRET)
  })

  it('keeps an unknown configured model, with medium when no effort is set', async () => {
    writePlan({
      config: { model: 'custom-model', model_reasoning_effort: null },
      pages: { '': { data: [row({ id: 'gpt-5-codex', isDefault: true })], nextCursor: null } },
    })
    const result = await probeCodexModels(binary, { cwd: workDir, env: baseEnv })
    expect(result.currentModelId).toBe('custom-model[medium]')
  })

  it('decodes UTF-8 split across stdout chunks', async () => {
    // Test data: CJK and astral characters, written as escapes.
    const displayName = '\u6a21\u578b-\u{1F600}-mini'
    writePlan({
      splitBytes: true,
      config: { model: null },
      pages: {
        '': {
          data: [row({
            id: 'uni',
            displayName,
            description: '\u4e2d\u6587',
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '\u5feb \u{1F680}' }],
            isDefault: true,
          })],
          nextCursor: null,
        },
      },
    })
    const result = await probeCodexModels(binary, { cwd: workDir, env: baseEnv })
    expect(result).toEqual({
      currentModelId: 'uni[low]',
      models: [{ modelId: 'uni[low]', name: '\u6a21\u578b-\u{1F600}-Mini (low)', description: '\u4e2d\u6587 \u5feb \u{1F680}' }],
    })
  })

  it('surfaces an RPC error with its code', async () => {
    writePlan({ errorOn: 'model/list', errorMessage: 'catalog unavailable', config: {} })
    await expect(probeCodexModels(binary, { cwd: workDir, env: baseEnv }))
      .rejects.toThrow('codex app-server model/list failed: catalog unavailable (code -32600) (stderr bytes=0)')
  })

  it('rejects invalid JSON without quoting the line', async () => {
    writePlan({ invalidJsonOn: 'initialize' })
    const err = await rejection(probeCodexModels(binary, { cwd: workDir, env: baseEnv }))
    expect(err.message).toMatch(/^codex app-server wrote invalid JSON \(\d+ chars\) while waiting for initialize/)
    expect(err.message).not.toContain(SECRET)
  })

  it('rejects a model row that lacks a field the menu reads', async () => {
    const bad = { ...row({ id: 'gpt-5-codex' }), isDefault: undefined }
    writePlan({ config: {}, pages: { '': { data: [bad], nextCursor: null } } })
    await expect(probeCodexModels(binary, { cwd: workDir, env: baseEnv }))
      .rejects.toThrow(/model\/list returned an unexpected shape: page 0 data\[0\]\.isDefault/)
  })

  it('rejects a repeating cursor instead of paging forever', async () => {
    writePlan({
      config: {},
      pages: {
        '': { data: [row({ id: 'a' })], nextCursor: 'c1' },
        c1: { data: [row({ id: 'b' })], nextCursor: 'c1' },
      },
    })
    await expect(probeCodexModels(binary, { cwd: workDir, env: baseEnv })).rejects.toThrow(/nextCursor repeats/)
  })

  it('times out, then SIGTERMs a process that ignores stdin EOF', async () => {
    writePlan({ silentOn: 'config/read', ignoreStdinEnd: true, pages: { '': { data: [row({ id: 'a' })], nextCursor: null } } })
    await expect(probeCodexModels(binary, { cwd: workDir, env: baseEnv, timeoutMs: 300 }))
      .rejects.toThrow(/did not answer config\/read within/)
    const entries = await waitForLog(exited)
    expect(entries.filter((e) => e.type === 'signal')).toEqual([{ type: 'signal', sig: 'SIGTERM' }])
  })

  it.skipIf(process.platform === 'win32')('ends a descendant that keeps the pipes open after app-server exits', async () => {
    writePlan({ spawnHolder: true, config: {}, pages: { '': { data: [row({ id: 'a', isDefault: true })], nextCursor: null } } })
    expect((await probeCodexModels(binary, { cwd: workDir, env: baseEnv })).currentModelId).toBe('a[low]')
    // app-server exits on EOF; the descendant (same process group) only goes on the group SIGTERM.
    const entries = await waitForLog((es) => es.some((e) => e.type === 'holder-exit'), 8_000)
    expect(entries.some((e) => e.type === 'exit')).toBe(true)
    expect(entries.filter((e) => e.type === 'holder-signal')).toEqual([{ type: 'holder-signal', sig: 'SIGTERM' }])
  })

  it('reports an early exit by stderr size, never its text', async () => {
    const stderr = `${'x'.repeat(100_000)} token=${SECRET}`
    writePlan({ exitOn: 'initialize', exitCode: 3, stderr })
    const err = await rejection(probeCodexModels(binary, { cwd: workDir, env: baseEnv }))
    expect(err.message).toBe(
      `codex app-server exited (code 3) before answering initialize (stderr bytes=${Buffer.byteLength(stderr)})`,
    )
  })

  it('rejects when the binary cannot spawn', async () => {
    await expect(probeCodexModels(path.join(dir, 'missing-codex'), { cwd: workDir, env: baseEnv }))
      .rejects.toThrow(/spawn failed/)
  })

  it('refuses an invalid CODEX_CONFIG before spawning, without echoing it', async () => {
    writePlan({})
    const err = await rejection(probeCodexModels(binary, { cwd: workDir, env: { ...baseEnv, CODEX_CONFIG: `{"token":"${SECRET}",` } }))
    expect(err.message).toBe('CODEX_CONFIG is not valid JSON')
    expect(fs.existsSync(logPath)).toBe(false)
  })
})

describe('codexConfigModelOverlay', () => {
  it('reads only model and model_reasoning_effort, treating null as unset', () => {
    expect(codexConfigModelOverlay({})).toEqual({})
    expect(codexConfigModelOverlay({ CODEX_CONFIG: '' })).toEqual({})
    expect(codexConfigModelOverlay({ CODEX_CONFIG: '{"model":"m","model_reasoning_effort":"high","x":1}' }))
      .toEqual({ model: 'm', effort: 'high' })
    expect(codexConfigModelOverlay({ CODEX_CONFIG: '{"model":null}' })).toEqual({ model: undefined, effort: undefined })
  })

  it('refuses malformed input without echoing it', () => {
    for (const [raw, message] of [
      [`{"k":"${SECRET}"`, 'CODEX_CONFIG is not valid JSON'],
      [`["${SECRET}"]`, 'CODEX_CONFIG must be a JSON object'],
      ['{"model":42}', 'CODEX_CONFIG.model is not a string'],
    ]) {
      expect(() => codexConfigModelOverlay({ CODEX_CONFIG: raw })).toThrow(new Error(message))
    }
  })
})

describe('codexProjectTrustArg', () => {
  it('quotes the cwd as a TOML key', () => {
    expect(codexProjectTrustArg('/work/my.repo')).toBe('projects={ "/work/my.repo" = { trust_level = "trusted" } }')
    expect(codexProjectTrustArg('C:\\a "b"\t\u007f'))
      .toBe('projects={ "C:\\\\a \\"b\\"\\u0009\\u007F" = { trust_level = "trusted" } }')
  })
})

describe('codex-acp mapping parity', () => {
  const rows = [
    row({ id: 'gpt-5-codex', defaultReasoningEffort: 'high', isDefault: true }),
    row({ id: 'other' }),
  ]

  it('resolves the current model like createModelId', () => {
    expect(resolveCodexCurrentModelId(rows, 'other', 'high')).toBe('other[high]')
    expect(resolveCodexCurrentModelId(rows, 'other', null)).toBe('other[low]')
    expect(resolveCodexCurrentModelId(rows, 'custom', undefined)).toBe('custom[medium]')
    expect(resolveCodexCurrentModelId(rows, 'custom', 'xhigh')).toBe('custom[xhigh]')
    expect(resolveCodexCurrentModelId(rows, null, null)).toBe('gpt-5-codex[high]')
    expect(resolveCodexCurrentModelId(rows, null, 'low')).toBe('gpt-5-codex[low]')
    expect(resolveCodexCurrentModelId([row({ id: 'other' })], null, null)).toBeUndefined()
  })

  it('normalizes display name tokens like normalizeModelDisplayName', () => {
    expect(normalizeCodexModelDisplayName('gpt-5.1-codex-MINI')).toBe('GPT-5.1-Codex-Mini')
    expect(normalizeCodexModelDisplayName('GPT-6.1 Sol')).toBe('GPT-6.1 Sol')
    expect(normalizeCodexModelDisplayName('constructor-x')).toBe('constructor-x')
  })
})

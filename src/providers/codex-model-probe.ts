/**
 * Codex model menu over the native app-server protocol, without the ACP
 * session/new that scans skills and starts a thread. Rows map exactly like
 * codex-acp's createModelState / createModelId.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { AcpModelInfo } from './acp-worker/protocol.js'

export interface CodexModelProbeOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
export interface CodexModelProbeResult { models: AcpModelInfo[]; currentModelId?: string }

export interface CodexModelRow {
  id: string
  displayName: string
  description: string
  defaultReasoningEffort: string
  isDefault: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
}

const PROBE_TIMEOUT_MS = 15_000
const TERM_AFTER_MS = 1_500
const KILL_AFTER_TERM_MS = 3_000
const MAX_LINE_CHARS = 4 * 1024 * 1024
const MAX_MODEL_PAGES = 50
const MODEL_NAME_TOKEN_OVERRIDES: Record<string, string> = { gpt: 'GPT', mini: 'Mini', codex: 'Codex' }
const IS_WINDOWS = process.platform === 'win32'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The model and effort CODEX_CONFIG sets for a codex-acp thread. Only these
 * two keys matter here: the catalog must come from the same base config the
 * runtime app-server lists from. Errors never echo the value (it may hold
 * credentials).
 */
export function codexConfigModelOverlay(env: NodeJS.ProcessEnv): { model?: string; effort?: string } {
  if (!env.CODEX_CONFIG) return {}
  let parsed: unknown
  try { parsed = JSON.parse(env.CODEX_CONFIG) } catch { throw new Error('CODEX_CONFIG is not valid JSON') }
  if (!isRecord(parsed)) throw new Error('CODEX_CONFIG must be a JSON object')
  const pick = (key: string): string | undefined => {
    const value = parsed[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new Error(`CODEX_CONFIG.${key} is not a string`)
    return value
  }
  return { model: pick('model'), effort: pick('model_reasoning_effort') }
}

/** codex-acp trusts the session cwd in thread/start; the same project layers apply here. */
export function codexProjectTrustArg(cwd: string): string {
  let key = '"'
  for (const ch of cwd) {
    const cp = ch.codePointAt(0)!
    if (ch === '"' || ch === '\\') key += `\\${ch}`
    else if (cp < 0x20 || cp === 0x7f) key += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`
    else if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('cwd contains a lone surrogate')
    else key += ch
  }
  return `projects={ ${key}" = { trust_level = "trusted" } }`
}

export function normalizeCodexModelDisplayName(displayName: string): string {
  const fix = (token: string) => (Object.hasOwn(MODEL_NAME_TOKEN_OVERRIDES, token.toLowerCase())
    ? MODEL_NAME_TOKEN_OVERRIDES[token.toLowerCase()] : token)
  return displayName.split('-').map(fix).join('-')
}

export function mapCodexModels(rows: CodexModelRow[]): AcpModelInfo[] {
  return rows.flatMap((model) =>
    model.supportedReasoningEfforts.map((effort) => ({
      modelId: `${model.id}[${effort.reasoningEffort}]`,
      name: `${normalizeCodexModelDisplayName(model.displayName)} (${effort.reasoningEffort})`,
      description: `${model.description} ${effort.description}`,
    })),
  )
}

/**
 * createModelId. Undefined where codex-acp throws (no model, no default): at
 * runtime thread/start resolves a model itself.
 */
export function resolveCodexCurrentModelId(
  rows: CodexModelRow[],
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
): string | undefined {
  const selected = rows.find((m) => m.id === model)
  if (selected) return `${selected.id}[${reasoningEffort ?? selected.defaultReasoningEffort}]`
  if (model) return `${model}[${reasoningEffort ?? 'medium'}]`
  const fallback = rows.find((m) => m.isDefault)
  return fallback ? `${fallback.id}[${reasoningEffort ?? fallback.defaultReasoningEffort}]` : undefined
}

function parseModelRow(row: unknown, where: string): CodexModelRow {
  const need = (ok: boolean, what: string) => { if (!ok) throw new Error(`${where}${what}`) }
  need(isRecord(row), ' is not an object')
  const r = row as Record<string, unknown>
  for (const key of ['id', 'displayName', 'description', 'defaultReasoningEffort']) {
    need(typeof r[key] === 'string', `.${key} is not a string`)
  }
  need(typeof r.isDefault === 'boolean', '.isDefault is not a boolean')
  need(Array.isArray(r.supportedReasoningEfforts), '.supportedReasoningEfforts is not an array')
  const supportedReasoningEfforts = (r.supportedReasoningEfforts as unknown[]).map((e, i) => {
    need(isRecord(e) && typeof e.reasoningEffort === 'string' && typeof e.description === 'string',
      `.supportedReasoningEfforts[${i}] needs a string reasoningEffort and description`)
    const { reasoningEffort, description } = e as { reasoningEffort: string; description: string }
    return { reasoningEffort, description }
  })
  const { id, displayName, description, defaultReasoningEffort, isDefault } = r as unknown as CodexModelRow
  return { id, displayName, description, defaultReasoningEffort, isDefault, supportedReasoningEfforts }
}

function optionalString(value: unknown, where: string): string | null | undefined {
  if (value == null || typeof value === 'string') return value as string | null | undefined
  throw new Error(`${where} is not a string`)
}

function describeRpcError(error: unknown): string {
  if (!isRecord(error)) return 'unknown rpc error'
  const message = typeof error.message === 'string' && error.message ? error.message : 'unknown rpc error'
  return error.code !== undefined ? `${message} (code ${String(error.code)})` : message
}

class LineReader {
  private decoder = new StringDecoder('utf8')
  private pending = ''

  constructor(private onLine: (line: string) => void, private onOverflow: () => void) {}

  push(chunk: Buffer): void { this.take(this.decoder.write(chunk)) }

  end(): void {
    this.take(this.decoder.end())
    const last = this.pending
    this.pending = ''
    if (last) this.onLine(last)
  }

  private take(text: string): void {
    let start = 0
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      const line = this.pending + text.slice(start, nl)
      this.pending = ''
      start = nl + 1
      if (line.length > MAX_LINE_CHARS) return this.onOverflow()
      this.onLine(line)
    }
    this.pending += text.slice(start)
    if (this.pending.length > MAX_LINE_CHARS) {
      this.pending = ''
      this.onOverflow()
    }
  }
}

export function probeCodexModels(binary: string, options: CodexModelProbeOptions = {}): Promise<CodexModelProbeResult> {
  if (!binary) return Promise.reject(new Error('codex binary path is empty'))
  const cwd = options.cwd ?? os.homedir()
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  let overlay: { model?: string; effort?: string }
  let trustArg: string
  try {
    overlay = codexConfigModelOverlay(env)
    trustArg = codexProjectTrustArg(cwd)
  } catch (err) {
    return Promise.reject(err)
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      // Its own process group on Unix, so a descendant holding the pipes can be ended too.
      child = spawn(binary, ['app-server', '-c', trustArg], {
        cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WINDOWS,
      })
    } catch (err) {
      return reject(new Error(`codex app-server spawn failed: ${(err as Error).message}`))
    }

    let settled = false
    let closed = false
    let stderrBytes = 0
    let termTimer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    const handlers = new Map<number, { method: string; onResult: (result: unknown) => void }>()
    const waitingOn = () => [...handlers.values()].map((h) => h.method).join(', ') || 'a response'

    // Only this child's own group; stops at 'close', after which the ids may be reused.
    const signal = (sig: NodeJS.Signals) => {
      const pid = child.pid
      if (closed || pid === undefined) return
      try {
        if (IS_WINDOWS) child.kill(sig)
        else if (pid > 1) process.kill(-pid, sig)
      } catch { /* group already gone */ }
    }
    const markClosed = () => { closed = true; clearTimeout(termTimer); clearTimeout(killTimer) }
    const finish = (err: Error | null, result?: CodexModelProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      // app-server exits on stdin EOF; signals only chase one that does not.
      try { child.stdin.end() } catch { /* closed */ }
      if (!closed) {
        termTimer = setTimeout(() => {
          signal('SIGTERM')
          killTimer = setTimeout(() => signal('SIGKILL'), KILL_AFTER_TERM_MS)
          killTimer.unref()
        }, TERM_AFTER_MS)
        termTimer.unref()
      }
      // stderr is counted, never quoted: it can carry config and credentials.
      if (err) reject(new Error(`${err.message} (stderr bytes=${stderrBytes})`))
      else resolve(result!)
    }

    const deadline = setTimeout(() => finish(new Error(
      `codex app-server did not answer ${waitingOn()} within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
    deadline.unref()

    child.once('error', (err) => {
      if (child.pid === undefined) markClosed()
      finish(new Error(`codex app-server spawn failed: ${err.message}`))
    })
    child.once('close', (code, sig) => {
      markClosed()
      finish(new Error(`codex app-server exited (${sig ? `signal ${sig}` : `code ${code}`}) before answering ${waitingOn()}`))
    })
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length })

    const send = (msg: Record<string, unknown>) => {
      if (!settled) try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`) } catch { /* close reports */ }
    }
    let nextId = 1
    const request = (method: string, params: unknown, onResult: (result: unknown) => void) => {
      const id = nextId++
      handlers.set(id, {
        method,
        onResult: (result) => {
          try { onResult(result) } catch (err) {
            finish(new Error(`codex app-server ${method} returned an unexpected shape: ${(err as Error).message}`))
          }
        },
      })
      send({ id, method, params })
    }

    let config: { model: string | null | undefined; effort: string | null | undefined } | undefined
    let rows: CodexModelRow[] | undefined
    const maybeFinish = () => {
      if (!config || !rows) return
      // CODEX_CONFIG reaches the runtime thread as an override on top of this config.
      const model = overlay.model ?? config.model
      const effort = overlay.effort ?? config.effort
      finish(null, { models: mapCodexModels(rows), currentModelId: resolveCodexCurrentModelId(rows, model, effort) })
    }

    const listed: CodexModelRow[] = []
    const seenCursors = new Set<string>()
    let pages = 0
    const listModels = (cursor: string | null) => {
      request('model/list', { cursor, limit: null }, (result) => {
        if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('result.data is not an array')
        const page = pages++
        result.data.forEach((r, i) => listed.push(parseModelRow(r, `page ${page} data[${i}]`)))
        const next = optionalString(result.nextCursor, 'result.nextCursor')
        if (next) {
          if (seenCursors.has(next)) throw new Error('nextCursor repeats')
          if (pages >= MAX_MODEL_PAGES) throw new Error(`more than ${MAX_MODEL_PAGES} pages`)
          seenCursors.add(next)
          return listModels(next)
        }
        // codex-acp newSession fails on an empty catalog too.
        if (listed.length === 0) throw new Error('no models')
        rows = listed
        maybeFinish()
      })
    }

    const onLine = (line: string) => {
      if (settled || !line.trim()) return
      let msg: unknown
      try { msg = JSON.parse(line) } catch {
        return finish(new Error(`codex app-server wrote invalid JSON (${line.length} chars) while waiting for ${waitingOn()}`))
      }
      if (!isRecord(msg)) return finish(new Error(`codex app-server wrote a non-object message while waiting for ${waitingOn()}`))
      if (typeof msg.method === 'string') {
        // A server request still needs an answer, or the peer waits on it.
        if (msg.id !== undefined && msg.id !== null) {
          send({ id: msg.id, error: { code: -32601, message: 'not supported by the model probe' } })
        }
        return
      }
      const handler = typeof msg.id === 'number' ? handlers.get(msg.id) : undefined
      if (!handler) return
      handlers.delete(msg.id as number)
      if (msg.error !== undefined && msg.error !== null) {
        return finish(new Error(`codex app-server ${handler.method} failed: ${describeRpcError(msg.error)}`))
      }
      handler.onResult(msg.result)
    }
    const reader = new LineReader(onLine, () => finish(new Error(
      `codex app-server wrote a line over ${MAX_LINE_CHARS} characters while waiting for ${waitingOn()}`)))
    child.stdout.on('data', (chunk: Buffer) => { if (!settled) reader.push(chunk) })
    child.stdout.once('end', () => { if (!settled) reader.end() })

    request(
      'initialize',
      { clientInfo: { name: 'walnut-model-probe', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } },
      (result) => {
        if (!isRecord(result)) throw new Error('result is not an object')
        send({ method: 'initialized' })
        request('config/read', { includeLayers: false, cwd }, (configResult) => {
          if (!isRecord(configResult) || !isRecord(configResult.config)) throw new Error('result.config is not an object')
          config = {
            model: optionalString(configResult.config.model, 'config.model'),
            effort: optionalString(configResult.config.model_reasoning_effort, 'config.model_reasoning_effort'),
          }
          maybeFinish()
        })
        listModels(null)
      },
    )
  })
}

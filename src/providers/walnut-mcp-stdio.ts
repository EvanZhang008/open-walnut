/**
 * `walnut mcp-server` — Walnut's ops as an MCP stdio server, on any host.
 *
 * The hub's `open-walnut mcp` (src/mcp/server.ts) runs the op registry itself and
 * calls the server's HTTP API on 127.0.0.1:3456, so it only works on the Mac that
 * runs Walnut. A session on another host (and every session's own `walnut` CLI)
 * reaches Walnut through its host daemon's gateway socket instead. This server
 * speaks MCP on stdio and answers each request with one gateway request, the
 * same one `walnut tools list` / `walnut tools call` send: the same op catalog,
 * the same caller (`WALNUT_SESSION_ID`), the same per-host refusals and write
 * budget. Only the transport differs: typed arguments, no shell quoting, and one
 * long-lived process instead of a CLI start per call.
 *
 * Hand-rolled JSON-RPC (newline-delimited, the MCP stdio transport) instead of
 * the SDK: the daemon builds carry this file, and four methods are all a client
 * needs. Tools carry no `anthropic/alwaysLoad`, so Claude Code lists them by name
 * and loads a schema only when the model asks for it (ToolSearch): the whole
 * catalog costs about 2K tokens at session start, against about 76K for every
 * schema up front (measured 2026-11-01).
 *
 * STDOUT PURITY: stdout carries JSON-RPC frames and nothing else.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { GatewayError, GatewayOp, GatewayResponse } from './gateway-core.js'
import { GATEWAY_WAIT_NOTICE_MS, MCP_CALL_WAIT_MS, waitNoticeText } from './gateway-request.js'
import { GATEWAY_INLINE_ARGS_MAX_BYTES } from './tool-args-source.js'
import { walnutMcpInstructions } from '../mcp/instructions.js'
import { fitToolAnswer } from '../lib/tool-answer-fit.js'
import { awayLines, callerRunId, dropRunId, lostRunLines, neverSent, refusedRunId } from './host-exec-run-id.js'
import { CALL_ID_ARG, callIdFor, lostCallLines, newCallId } from '../lib/op-call-id.js'
import { withToolUseId } from '../lib/tool-use-id.js'
import { NoAnswerLog } from '../lib/no-answer-report.js'

/** MCP protocol versions this server speaks; the first is offered when the client's is unknown. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

/** How long `tools/list` waits on the hub's catalog (the client waits on it to connect). */
export const MCP_LIST_TIMEOUT_MS = 15_000

/** How long the word that this session was given a short list (tellShort) may take; nobody waits on it. */
export const MCP_SHORT_REPORT_MS = 5_000

/** How often a list that came back short (no hub, an older hub) is asked for again. */
export const MCP_LIST_RETRY_MS = 60_000

/**
 * How soon a list the hub marked `partial` (its plugins still loading) is asked for again: a boot's
 * walk takes about 20 s, and the hub itself waits a little for it, so this never spins.
 */
export const MCP_PARTIAL_RETRY_MS = 10_000

/**
 * The longest a first `tools/list` waits for the hub before it answers what there is (the list
 * kept from an earlier process of this session, else none) and completes it later. A ride over a
 * daemon restart can take 75 s, and Claude Code neither retries a tools/list that timed out nor
 * takes its late answer: the session would have no Walnut tools until the list changed.
 */
export const MCP_LIST_ANSWER_MS = 20_000

/**
 * The early answer's wait in this process: MCP_LIST_ANSWER_MS, or 2 s under the client's own
 * MCP_TIMEOUT (Claude Code's, in ms) when that is shorter.
 */
export function mcpListAnswerMs(env: Record<string, string | undefined> = process.env): number {
  const client = Number(env.MCP_TIMEOUT)
  return Number.isFinite(client) && client > 0 ? Math.max(1_000, Math.min(MCP_LIST_ANSWER_MS, client - 2_000)) : MCP_LIST_ANSWER_MS
}

/** `signal`: the client cancelled the call; the request's socket closes, so a daemon still holding it for a server drops it unsent. */
export type GatewayRequestFn = (op: GatewayOp, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<GatewayResponse>

export interface WalnutMcpDeps {
  /**
   * One gateway request on this host's daemon socket (wn-cli.ts mcpGatewayRequest, built by
   * gateway-request.ts). Its third argument: a list's answer time, or the time a call must be
   * answered within (by default it waits for a server as long as the MCP call wait, mcpWaitMs).
   */
  request: GatewayRequestFn
  /** Error lines the CLI prints for a gateway error (wn-cli formatErrorLines). */
  formatError: (error: GatewayError) => string[]
  /** Tell the client about a call it gave a progressToken (notifications/progress params). */
  progress?: (params: Record<string, unknown>) => void
  /** How long a call waits for a server (what the request fn gives it), for the waiting notice. */
  callWaitMs?: number
  /** Overrides GATEWAY_WAIT_NOTICE_MS (tests). */
  waitNoticeMs?: number
  /** Where a payload too big to inline is staged for the hub to pull. */
  tmpDir?: string
  /** Send a notification to the client (tools/list_changed after a short list is completed). */
  notify?: (method: string) => void
  /** Overrides MCP_LIST_RETRY_MS (tests). */
  listRetryMs?: number
  /** Overrides MCP_PARTIAL_RETRY_MS (tests). */
  partialRetryMs?: number
  /** Where an answer too big for one tool result is written (tests); default tool-answer-fit's. */
  answerDir?: string
  /** Overrides MCP_LOST_FOLLOW_MS (tests). */
  lostFollowMs?: number
  /** The last whole list this session was given, kept across its processes (fileToolListCache). */
  listCache?: ToolListCache
  /** Overrides mcpListAnswerMs() (tests). */
  listAnswerMs?: number
}

type McpTool = Record<string, unknown>

/** Why a session was given fewer tools than its whole list (tellShort). */
export type ShortWhy = 'away' | 'slow' | 'partial' | 'short'

/** Where a session's last whole tool list is kept, so a process started while the hub is away still lists it. */
export interface ToolListCache {
  read(): McpTool[] | null
  write(tools: McpTool[]): void
}

/** How long a session's kept list is kept after its last write. */
const LIST_CACHE_KEEP_MS = 14 * 24 * 3600_000

/** Files of the cache older than this are an unfinished write (`.tmp`) or a list no ref names any more. */
const LIST_CACHE_STALE_MS = 3600_000

const hash16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * A ToolListCache in `dir` (owner-only), for session `sid`: `<hash of sid>.ref` names the list by
 * its content's hash, `<hash>.json` holds it, so the sessions of one role share one file. Every
 * failure reads as no list and writes nothing: the cache only ever adds tools to an answer.
 */
export function fileToolListCache(dir: string, sid: string): ToolListCache {
  // The id is hashed: a file name never carries a caller's id as it is.
  const ref = path.join(dir, `${hash16(`session\n${sid}`)}.ref`)
  // Tool descriptions are what the model is told: only a directory of this user's own, closed to others.
  const ownDir = (): boolean => {
    const st = fs.lstatSync(dir)
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    return st.isDirectory() && (uid < 0 || st.uid === uid) && (st.mode & 0o077) === 0
  }
  return {
    read() {
      try {
        if (!ownDir()) return null
        const hash = fs.readFileSync(ref, 'utf-8').trim()
        if (!/^[0-9a-f]{16}$/.test(hash)) return null
        const tools = JSON.parse(fs.readFileSync(path.join(dir, `${hash}.json`), 'utf-8')) as unknown
        return Array.isArray(tools) && tools.length > 0 && tools.every((t) => !!t && typeof t === 'object' && typeof (t as McpTool).name === 'string')
          ? tools as McpTool[]
          : null
      } catch { return null }
    },
    write(tools) {
      try {
        const body = JSON.stringify(tools)
        const hash = hash16(body)
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        if (!ownDir()) return
        const list = path.join(dir, `${hash}.json`)
        const put = (file: string, text: string) => {
          const tmp = `${file}.${process.pid}.tmp`
          fs.writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600 })
          fs.renameSync(tmp, file)
        }
        // A list already there is touched, so no sweep takes it as one no ref names.
        if (fs.existsSync(list)) { const now = new Date(); fs.utimesSync(list, now, now) } else put(list, body)
        put(ref, hash)
        sweepToolListCache(dir, Date.now())
      } catch { /* a list not kept costs only the next cold start */ }
    },
  }
}

/**
 * Refs unwritten for LIST_CACHE_KEEP_MS go, then every list no ref names and every unfinished write,
 * each once an hour old (so one being written stays).
 */
export function sweepToolListCache(dir: string, nowMs: number): void {
  const names = fs.readdirSync(dir)
  const named = new Set<string>()
  for (const name of names) {
    if (!name.endsWith('.ref')) continue
    const file = path.join(dir, name)
    try {
      if (nowMs - fs.statSync(file).mtimeMs > LIST_CACHE_KEEP_MS) fs.unlinkSync(file)
      else named.add(fs.readFileSync(file, 'utf-8').trim())
    } catch { /* gone meanwhile */ }
  }
  for (const name of names) {
    const stale = name.endsWith('.tmp') || (name.endsWith('.json') && !named.has(name.slice(0, -5)))
    if (!stale) continue
    const file = path.join(dir, name)
    try { if (nowMs - fs.statSync(file).mtimeMs > LIST_CACHE_STALE_MS) fs.unlinkSync(file) } catch { /* gone meanwhile */ }
  }
}

/**
 * How long a call whose answer did not come back (`hub_timeout`) is followed through op_result
 * before it reads as lost. 2026-11-20: brief_write took 9 to 18 s on a busy Mac, past the gateway's
 * 10 s, and came back as a failure although the write went through; read on, it answers what the
 * call really did.
 */
export const MCP_LOST_FOLLOW_MS = 30_000
const MCP_LOST_POLL_MS = 1_000

type LostFollow = { ok: true; result: unknown } | { ok: false; message: string } | null

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown }
type JsonRpcReply = Record<string, unknown>

interface HubOpRow {
  name: string
  title?: string
  description?: string
  readonly?: boolean
  destructive?: boolean
  inputSchema?: Record<string, unknown>
  signature?: string
}

/** What a tool's text content says for an op result: compact JSON, since a model reads it
 *  (pretty-printing cost up to a fifth more characters on a task list, measured 2026-11-10). */
function text(payload: unknown): string {
  return JSON.stringify(payload)
}

/** One MCP tool row from a hub catalog row. An older hub sends no schema: accept any object. */
export function mcpToolOf(row: HubOpRow): Record<string, unknown> {
  const description = row.inputSchema || !row.signature
    ? (row.description ?? '')
    : `${row.description ?? ''}\n\nArguments: ${row.signature}`
  return {
    name: row.name,
    ...(row.title ? { title: row.title } : {}),
    description,
    inputSchema: row.inputSchema ?? { type: 'object', additionalProperties: true },
    annotations: {
      ...(row.readonly ? { readOnlyHint: true } : {}),
      ...(row.destructive !== undefined ? { destructiveHint: row.destructive } : {}),
    },
  }
}

/** The protocol version to answer an initialize with. */
export function negotiateProtocol(requested: unknown): string {
  return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSIONS[0]
}

/**
 * Build the request handler. Returns the reply for a request, or null for a
 * notification (no id) or a method that needs no answer.
 */
export function createWalnutMcpHandler(deps: WalnutMcpDeps): (msg: JsonRpcRequest) => Promise<JsonRpcReply | null> {
  const replyOk = (id: JsonRpcRequest['id'], result: unknown): JsonRpcReply => ({ jsonrpc: '2.0', id: id ?? null, result })
  const replyErr = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcReply =>
    ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const toolError = (message: string, detail?: unknown) => ({
    isError: true,
    content: [{ type: 'text', text: detail === undefined ? message : `${text(detail)}\n${message}` }],
  })

  // The catalog is fetched once and kept. One that came back short (the Mac away,
  // so a host serves its small offline set; an older hub, so no schemas; a hub still
  // loading its plugins) is asked for again until a full one arrives, and the client
  // is told the list changed: Claude Code reads a list once and refreshes it only then.
  // 2026-11-22: sessions started while the Mac was away or Walnut restarted got an empty
  // or short list and ran turns without their Walnut tools until it came.
  let fullList: Record<string, unknown>[] | null = null
  const listAnswerMs = deps.listAnswerMs ?? mcpListAnswerMs()
  let retry: ReturnType<typeof setTimeout> | null = null
  let spillSeq = 0
  const fetchList = async (): Promise<{ tools: McpTool[]; full: boolean; partial: boolean; offline: boolean } | { error: string; away: boolean }> => {
    let resp: GatewayResponse
    try {
      // `listing: 'role'`: this server's instructions say how to reach a tool it does not list, so
      // the hub may list only the session's role's tools (experiment mcp_tools_by_role). An older
      // hub ignores it and lists everything; every tool still runs by name (callTool below).
      resp = await deps.request('tools.list', { schemas: true, listing: 'role' }, MCP_LIST_TIMEOUT_MS)
    } catch (err) {
      return { error: `Walnut's tool list did not arrive: ${err instanceof Error ? err.message : String(err)}`, away: false }
    }
    if (!resp.ok) return { error: deps.formatError(resp.error).join('\n'), away: resp.error.code === 'hub_unreachable' }
    const rows = Array.isArray(resp.result.ops) ? resp.result.ops as HubOpRow[] : []
    // `partial`: read while the hub's plugins load (capability-router.ts), so their tools are missing.
    const partial = resp.result.partial === true
    return { tools: rows.map(mcpToolOf), full: rows.length > 0 && rows.every((r) => r.inputSchema) && !partial, partial, offline: resp.result.offline === true }
  }
  // The client was given fewer tools than its whole list (none, or a list without the plugins'
  // tools, and nothing kept to fill it): the session runs without them until the list changes.
  // Once the whole list is here the hub is told (tellShort), and the real-use monitor counts it
  // (usage_watch errors, usage-watch/gateway-record.ts) with why: `away` (the hub said it is
  // away, or a host's offline set answered), `slow` (no answer within the early wait), `partial`
  // (its plugins still loading), `short` (anything else). 2026-11-23: a daily count read every
  // list change Claude Code records (a role's shorter list, a retired tool) as lost tools; on that
  // day none of its 71 changes left a session without them. Only this side knows it at the source.
  // A process that ends before the whole list comes tells nothing: such a gap is not counted.
  let short: { at: number; given: number; why: ShortWhy } | null = null
  const answerShort = (id: JsonRpcRequest['id'], tools: McpTool[], why: ShortWhy) => {
    short ??= { at: Date.now(), given: tools.length, why }
    return replyOk(id, { tools })
  }
  const tellShort = (full: number) => {
    const s = short
    short = null
    if (!s || s.given >= full) return
    // A word for the monitor, never waited on: an older hub ignores `report` and answers its catalog.
    void deps.request('tools.list', { report: { short_list: { given: s.given, full, ms: Date.now() - s.at, why: s.why } } }, MCP_SHORT_REPORT_MS).catch(() => {})
  }
  /** A whole list arrived: it is the list from now on, and kept for this session's next process. */
  const gotFull = (tools: McpTool[]) => {
    fullList = tools
    // Whatever whole list this host's hub gave (a follower's may be smaller than the leader's) is kept.
    deps.listCache?.write(tools)
    tellShort(tools.length)
  }
  /** Ask again later: soon for a hub still loading its plugins, else at the slow pace. */
  const scheduleRetry = (partial = false) => {
    if (retry || !deps.notify) return
    retry = setTimeout(async () => {
      retry = null
      if (fullList) return
      settle(await fetchList())
    }, partial ? deps.partialRetryMs ?? MCP_PARTIAL_RETRY_MS : deps.listRetryMs ?? MCP_LIST_RETRY_MS)
    retry.unref?.()
  }
  /** A list that came after the client was answered: a whole one replaces it (and the client is told), else ask again. */
  const settle = (got: Awaited<ReturnType<typeof fetchList>>) => {
    if (fullList) return
    if ('tools' in got && got.full) {
      gotFull(got.tools)
      deps.notify?.('notifications/tools/list_changed')
    } else scheduleRetry('tools' in got && got.partial)
  }

  /** What a call whose answer was lost did, read with op_result until it ended (within
   *  MCP_LOST_FOLLOW_MS); null while still running, lost, unknown, or no answer to the read. */
  const followLost = async (callId: string): Promise<LostFollow> => {
    const until = Date.now() + (deps.lostFollowMs ?? MCP_LOST_FOLLOW_MS)
    for (;;) {
      let read: GatewayResponse | null = null
      // A read ends within what is left of the follow, and waits for a server only inside it.
      try { read = await deps.request('tools.call', { name: 'op_result', args: { call_id: callId }, callId: newCallId(), client: 'mcp' }, Math.max(1, until - Date.now())) } catch { /* the daemon away: read as lost */ }
      if (!read) return null
      if (read.ok) {
        const b = (read.result ?? {}) as { state?: unknown; ok?: unknown; result?: unknown; message?: unknown; answer_withheld?: unknown }
        // Its answer is not ours to read: only where it stands.
        if (b.answer_withheld) return null
        if (b.state === 'done' && b.ok === true) return { ok: true, result: b.result !== undefined ? b.result : read.result }
        if (b.state === 'done' && b.ok === false) return { ok: false, message: typeof b.message === 'string' && b.message ? b.message : 'the call ran and failed' }
        if (b.state !== 'running') return null
      } else if (read.error.code !== 'hub_timeout') return null
      if (Date.now() + MCP_LOST_POLL_MS > until) return null
      await new Promise((r) => setTimeout(r, MCP_LOST_POLL_MS))
    }
  }

  /** One progress notification after GATEWAY_WAIT_NOTICE_MS, only for a call whose client gave a progressToken. */
  const waitingNotice = (meta: unknown): ReturnType<typeof setTimeout> | undefined => {
    const token = (meta as { progressToken?: unknown } | null | undefined)?.progressToken
    if (!deps.progress || (typeof token !== 'string' && typeof token !== 'number')) return undefined
    const timer = setTimeout(() => {
      deps.progress?.({ progressToken: token, progress: 0, message: `Walnut: ${waitNoticeText(deps.callWaitMs ?? MCP_CALL_WAIT_MS)}` })
    }, deps.waitNoticeMs ?? GATEWAY_WAIT_NOTICE_MS)
    timer.unref?.()
    return timer
  }

  // The calls no Walnut answered (this host's daemon or the server away: a restart), told to the hub
  // with the next call that gets through (lib/no-answer-report.ts): the session hook counts a failed
  // call only while the server reads the session live, and these fail exactly while it does not.
  const noAnswers = new NoAnswerLog()
  const noAnswer = (op: string, code: string) => noAnswers.note(op, code, 'mcp')
  const tellNoAnswers = () => {
    if (!noAnswers.size) return
    const { report, putBack } = noAnswers.take()
    if (!report.length) return
    // A word for the monitor, never waited on: an older hub ignores `report` and answers its catalog.
    void deps.request('tools.list', { report: { no_answer: report } }, MCP_SHORT_REPORT_MS)
      .then((r) => { if (!r.ok) putBack() }, () => putBack())
  }

  // Calls still running, by the client's request id: `notifications/cancelled` aborts one.
  const running = new Map<string, AbortController>()
  const requestKey = (id: unknown): string | null => (typeof id === 'string' || typeof id === 'number' ? `${typeof id}:${id}` : null)

  const callTool = async (params: Record<string, unknown>, signal?: AbortSignal) => {
    const name = typeof params.name === 'string' ? params.name : ''
    if (!name) return toolError('tools/call needs a tool name')
    const given = params.arguments ?? {}
    if (typeof given !== 'object' || given === null || Array.isArray(given)) return toolError('arguments must be an object')
    // A run's id chosen here (host_exec), so an answer lost on the way back still leaves one to read.
    // The chat's tool call it runs for, from Claude Code's _meta (src/lib/tool-use-id.ts).
    const args = withToolUseId(name, { ...given } as Record<string, unknown>, params._meta)
    // Every call's id (src/lib/op-call-id.ts): a resend runs it at most once, and op_result reads
    // what it did when its answer is lost. A model re-running a lost call passes "_call_id".
    // A re-run under an earlier call's id is never followed: op_result may still hold that earlier
    // run's answer while this one waits to start.
    const rerun = Object.prototype.hasOwnProperty.call(args, CALL_ID_ARG)
    const chosen = callIdFor(args)
    if (chosen.bad) return toolError(chosen.bad)
    let callId = chosen.callId
    let runId = callerRunId(name, args)
    const lost = (lines: string) => [lines, ...(runId ? lostRunLines(name, args, runId) : []), ...lostCallLines(name, args, callId)].join('\n')
    // A payload the gateway line cannot carry goes as a file the hub pulls, as the CLI's does.
    const raw = JSON.stringify(args)
    let spilled: string | undefined
    if (Buffer.byteLength(raw, 'utf-8') > GATEWAY_INLINE_ARGS_MAX_BYTES) {
      // Calls run concurrently, so the name carries a counter as well as the time.
      spilled = path.join(deps.tmpDir ?? os.tmpdir(), `walnut-mcp-args-${process.pid}-${Date.now().toString(36)}-${++spillSeq}.json`)
      fs.writeFileSync(spilled, raw, { encoding: 'utf-8', mode: 0o600 })
    }
    // While the daemon holds the call for a server (a restart), a client that asked for progress
    // hears it is waiting. Out of band only: the model's answer never carries a notice.
    const notice = waitingNotice(params._meta)
    try {
      // `client` lets the hub measure the answer as this server prints it (lib/tool-answer-size.ts).
      let resp = await deps.request('tools.call', spilled ? { name, argsFile: spilled, callId, client: 'mcp' } : { name, args, callId, client: 'mcp' }, undefined, signal)
      // A server older than the run id refused it before anything ran: the same call without it.
      if (!resp.ok && runId && !spilled && refusedRunId(name, resp.error.message)) {
        dropRunId(name, args)
        runId = null
        // Other arguments, so another call: nothing of the first ran.
        callId = newCallId()
        if (signal?.aborted) return toolError('walnut: the call was cancelled before it was sent again')
        resp = await deps.request('tools.call', { name, args, callId, client: 'mcp' }, undefined, signal)
      }
      // Never more than an agent's tool result takes, whatever the op (tool-answer-fit.ts).
      if (resp.ok) { tellNoAnswers(); return { content: [{ type: 'text', text: fitToolAnswer(resp.result, { op: name, dir: deps.answerDir }) }] } }
      const message = deps.formatError(resp.error).join('\n')
      if (resp.error.code === 'hub_timeout') {
        // The call may have run: what it did is the answer, a success included.
        const followed = rerun ? null : await followLost(callId)
        if (followed?.ok) return { content: [{ type: 'text', text: fitToolAnswer(followed.result, { op: name, dir: deps.answerDir }) }] }
        if (followed) return toolError(followed.message)
        noAnswer(name, 'hub_timeout')
        return toolError(lost(message), resp.error.detail)
      }
      if (resp.error.code === 'hub_unreachable') noAnswer(name, 'hub_unreachable')
      const away = resp.error.code === 'hub_unreachable' ? awayLines(name, args) : []
      return toolError([message, ...away].join('\n'), resp.error.detail)
    } catch (err) {
      const message = `walnut: no answer from the Walnut daemon: ${err instanceof Error ? err.message : String(err)}`
      noAnswer(name, 'no_daemon')
      // Refused before a byte left: nothing ran. A socket that broke after the request went: it may have.
      if (neverSent(err)) return toolError([message, ...awayLines(name, args, "this host's Walnut daemon")].join('\n'))
      return toolError(lost(message))
    } finally {
      clearTimeout(notice)
      if (spilled) { try { fs.unlinkSync(spilled) } catch { /* already gone */ } }
    }
  }

  return async (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
    const method = typeof msg.method === 'string' ? msg.method : ''
    const isRequest = msg.id !== undefined && msg.id !== null
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>
    if (!isRequest) {
      // A call the client gave up on (the user pressed Esc during a server restart): its socket
      // closes, and a daemon still holding it for a server drops it, so it never runs late.
      if (method === 'notifications/cancelled') {
        const key = requestKey(params.requestId)
        if (key) running.get(key)?.abort()
      }
      return null // notifications/initialized, ...
    }
    switch (method) {
      case 'initialize':
        return replyOk(msg.id, {
          protocolVersion: negotiateProtocol(params.protocolVersion),
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'walnut', version: '1' },
          instructions: walnutMcpInstructions(),
        })
      case 'ping':
        return replyOk(msg.id, {})
      case 'tools/list': {
        if (fullList) return replyOk(msg.id, { tools: fullList })
        const fetching = fetchList()
        // No answer within the client's patience: answer now, and take the late list when it lands.
        const got = await Promise.race([
          fetching,
          new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), listAnswerMs); t.unref?.() }),
        ])
        if (got && 'tools' in got && got.full) {
          gotFull(got.tools)
          return replyOk(msg.id, { tools: got.tools })
        }
        if (got) scheduleRetry('tools' in got && got.partial)
        else void fetching.then(settle).catch(() => scheduleRetry())
        // Answer with what there is (an error would leave the session with no server at all),
        // and complete it later: the list this session was last given (its tools still run, and a
        // call while the hub is away says so), else the short one, else none.
        const kept = deps.listCache?.read()
        // A partial list is current for what it has; the kept one adds the plugins' tools it still lacks.
        if (kept && got && 'tools' in got && got.partial) {
          const fresh = new Set(got.tools.map((t) => t.name))
          return replyOk(msg.id, { tools: [...got.tools, ...kept.filter((t) => !fresh.has(t.name))] })
        }
        if (kept && (!got || !('tools' in got) || kept.length >= got.tools.length)) return replyOk(msg.id, { tools: kept })
        if (got && 'tools' in got) return answerShort(msg.id, got.tools, got.offline ? 'away' : got.partial ? 'partial' : 'short')
        if (!deps.notify && got) return replyErr(msg.id, -32603, got.error)
        return answerShort(msg.id, [], !got ? 'slow' : got.away ? 'away' : 'short')
      }
      case 'tools/call': {
        const key = requestKey(msg.id)
        const ctl = new AbortController()
        if (key) running.set(key, ctl)
        try {
          const answer = await callTool(params, ctl.signal)
          // A cancelled request gets no answer (MCP: the receiver should not send one).
          return ctl.signal.aborted ? null : replyOk(msg.id, answer)
        } finally {
          if (key && running.get(key) === ctl) running.delete(key)
        }
      }
      case 'resources/list':
        return replyOk(msg.id, { resources: [] })
      case 'prompts/list':
        return replyOk(msg.id, { prompts: [] })
      default:
        return replyErr(msg.id, -32601, `Method not found: ${method}`)
    }
  }
}

/** Serve MCP on this process's stdin/stdout until stdin closes. */
export function runWalnutMcpStdio(deps: WalnutMcpDeps): Promise<number> {
  const write = (reply: JsonRpcReply) => { process.stdout.write(JSON.stringify(reply) + '\n') }
  const handle = createWalnutMcpHandler({
    ...deps,
    notify: (method) => write({ jsonrpc: '2.0', method }),
    progress: (params) => write({ jsonrpc: '2.0', method: 'notifications/progress', params }),
  })
  return new Promise<number>((resolve) => {
    let buf = ''
    let pending = 0
    let ended = false
    const maybeExit = () => { if (ended && pending === 0) resolve(0) }
    const onLine = (line: string) => {
      if (!line.trim()) return
      let msg: JsonRpcRequest
      try {
        msg = JSON.parse(line) as JsonRpcRequest
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      const id = msg && typeof msg === 'object' ? msg.id : undefined
      pending++
      handle(msg)
        .then((reply) => { if (reply) write(reply) })
        .catch((err) => {
          if (id !== undefined && id !== null) {
            write({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
          }
        })
        .finally(() => { pending--; maybeExit() })
    }
    process.stdin.setEncoding('utf-8')
    // setEncoding decodes UTF-8 across chunk edges; the newline search starts where
    // the last one stopped, so a multi-megabyte line is one pass, not one per chunk.
    let scanFrom = 0
    process.stdin.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n', scanFrom)) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        scanFrom = 0
        onLine(line)
      }
      scanFrom = buf.length
    })
    process.stdin.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; ended = true; maybeExit() })
  })
}

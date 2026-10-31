/**
 * The host side of `host_mcp` (src/core/hosts/host-mcp.ts): call an MCP server
 * configured on THIS host for a task on another host (the user, 2026-10-31: a task
 * routes the work "to the host that has it", an MCP server included), so its
 * sign-in, its files and its config values never leave this machine.
 *
 * Which servers there are comes from the files Claude Code itself reads: the
 * user's `mcpServers` in ~/.claude.json (and the project's, for a `cwd`), a
 * `.mcp.json` in that `cwd`, and the enabled plugins' `.mcp.json` /
 * plugin.json (named `plugin:<plugin>:<server>`, as Claude Code names them),
 * and first of all the servers the user offers ONLY to other hosts, in
 * `~/.open-walnut/local/host-mcp.json` (same shape, plus an optional one-word
 * `capability` and a `description`; `local/` is never synced, so its env and
 * headers stay on this machine): this host's own sessions never load those.
 * `${VAR}`, `${VAR:-default}` and `${CLAUDE_PLUGIN_ROOT}` expand as there.
 * A stdio server runs under the user's login shell (its PATH), in its own
 * process group; an http server is called from here with its configured
 * headers. An sse server is not supported.
 *
 * The server decides WHETHER a task may (the user's grant); this file only runs
 * the calls, bounded: one live server per task, server and folder, stopped after
 * 10 idle minutes, at most 8 live on this host; a call ends by its deadline (10
 * min at most) and its answer is kept 10 minutes, so a caller whose own wait
 * ran out reads it later (`mcp.result`). Only text, image sizes and a bounded
 * structured result come back.
 *
 * Bundled into the binary daemon and shipped as the host-reach-core.cjs sidecar
 * for the source twin; 'host-mcp-v1' is advertised only where it loads. It never
 * signals a process itself: the twin hands in `killGroup`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { shellQuote } from './host-exec-core.js'

export const CALL_DEFAULT_MS = 60_000
export const CALL_MAX_MS = 10 * 60_000
const INIT_MS = 60_000
const IDLE_MS = 10 * 60_000
const MAX_LIVE = 8
const KEEP_RESULT_MS = 10 * 60_000
const MAX_CALLS = 500
const TEXT_MAX = 512 * 1024
const STRUCTURED_MAX = 256 * 1024
/** Images come back up to this much base64 in all (one link frame stays well under 5 MB); past it only their size. */
const IMAGES_MAX = 3 * 1024 * 1024
const STDERR_KEEP = 8 * 1024
const LINE_MAX = 16 * 1024 * 1024
const KILL_GRACE_MS = 3_000
const CALL_ID_RE = /^mc-[A-Za-z0-9_-]{4,64}$/
const PROTOCOL_VERSION = '2025-06-18'

export interface HostMcpDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  killGroup: (pid: number, signal: NodeJS.Signals) => void
  shell: string
  home: string
  env: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => number
}

export interface ServerDef {
  name: string
  plugin?: string
  scope: 'walnut' | 'user' | 'project' | 'plugin'
  type: 'stdio' | 'http' | 'sse'
  /** What it offers in a word, from host-mcp.json. */
  capability?: string
  description?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  root?: string
}

export type McpError = { ok: false; code: 'bad_request' | 'cwd_missing' | 'unknown_server' | 'unsupported_transport' | 'server_failed' | 'busy' | 'unknown_call'; error: string }

export interface ToolView { name: string; description?: string; inputSchema?: unknown }
export interface CallResult {
  isError: boolean
  text: string
  truncated: boolean
  /** `data` (base64) while they fit IMAGES_MAX together, else only the size. */
  images: Array<{ mimeType: string; bytes: number; data?: string }>
  structured?: unknown
}

function bad(error: string, code: McpError['code'] = 'bad_request'): McpError {
  return { ok: false, code, error }
}

/** `${VAR}`, `${VAR:-default}` and `${CLAUDE_PLUGIN_ROOT}`, as Claude Code expands an MCP config. */
export function expandVars(s: string, env: NodeJS.ProcessEnv, root?: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, dflt: string | undefined) => {
    if (name === 'CLAUDE_PLUGIN_ROOT' && root) return root
    const v = env[name]
    return typeof v === 'string' && v !== '' ? v : (dflt ?? '')
  })
}

function strMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === 'string') out[k] = x
  return out
}

/** One config entry as a server, or null when it is not one. */
export function toServerDef(name: string, raw: unknown, scope: ServerDef['scope'], plugin?: string, root?: string): ServerDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const t = typeof r.type === 'string' ? r.type : (typeof r.url === 'string' ? 'http' : 'stdio')
  const type: ServerDef['type'] | null = t === 'stdio' ? 'stdio' : t === 'http' || t === 'streamable-http' ? 'http' : t === 'sse' ? 'sse' : null
  if (!type) return null
  if (type === 'stdio' && typeof r.command !== 'string') return null
  if (type !== 'stdio' && typeof r.url !== 'string') return null
  return {
    name: plugin ? `plugin:${plugin}:${name}` : name, ...(plugin ? { plugin } : {}), scope, type,
    ...(typeof r.command === 'string' ? { command: r.command } : {}),
    ...(Array.isArray(r.args) ? { args: r.args.filter((a): a is string => typeof a === 'string') } : {}),
    ...(strMap(r.env) ? { env: strMap(r.env) } : {}),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
    ...(strMap(r.headers) ? { headers: strMap(r.headers) } : {}),
    ...(root ? { root } : {}),
    // Only the user's own offer file names what a server does; a project's or a plugin's never does.
    ...(scope === 'walnut' && typeof r.capability === 'string' && /^[a-z0-9-]{1,32}$/.test(r.capability) ? { capability: r.capability } : {}),
    ...(scope === 'walnut' && typeof r.description === 'string' ? { description: r.description.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) } : {}),
  }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** One live MCP server: JSON-RPC over its stdio, or over HTTP. */
interface Conn {
  key: string
  def: ServerDef
  ready: Promise<void>
  request: (method: string, params: unknown, ms: number) => Promise<unknown>
  /** A JSON-RPC notification: no id, nothing waits for an answer. */
  notify: (method: string) => void
  close: (now?: boolean) => void
  lastUsed: number
  inFlight: number
  dead: boolean
}

export function createHostMcp(deps: HostMcpDeps) {
  const now = deps.now ?? Date.now
  const conns = new Map<string, Conn>()
  const calls = new Map<string, { taskId: string; startedAt: number; endedAt: number | null; reply: Record<string, unknown> | null; waiters: Array<() => void> }>()
  let seq = 0

  /** Parsed config files, kept while their mtime and size stand: ~/.claude.json can be many MB. */
  const parsed = new Map<string, { mtimeMs: number; size: number; value: Record<string, unknown> | null }>()
  async function readJson(p: string, max = 32 * 1024 * 1024): Promise<Record<string, unknown> | null> {
    try {
      const st = await fs.promises.stat(p)
      if (!st.isFile() || st.size > max) return null
      const hit = parsed.get(p)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
      const v = JSON.parse(await fs.promises.readFile(p, 'utf8'))
      const value = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
      if (parsed.size > 64) parsed.clear()
      parsed.set(p, { mtimeMs: st.mtimeMs, size: st.size, value })
      return value
    } catch { return null }
  }

  /** The folder as given (Claude Code keys its projects by it) and as it really is, or null for none. */
  async function resolveCwd(raw: unknown): Promise<{ given: string; real: string } | null | McpError> {
    if (typeof raw !== 'string' || !raw.trim()) return null
    let cwd = raw.trim()
    if (cwd === '~') cwd = deps.home
    else if (cwd.startsWith('~/')) cwd = path.join(deps.home, cwd.slice(2))
    if (!path.isAbsolute(cwd)) return bad(`cwd must be an absolute path or start with ~/ (got "${cwd}")`)
    try {
      const real = await fs.promises.realpath(cwd)
      return (await fs.promises.stat(real)).isDirectory() ? { given: path.resolve(cwd), real } : bad(`${cwd} is not a directory on this host`, 'cwd_missing')
    } catch { return bad(`${cwd} does not exist on this host`, 'cwd_missing') }
  }
  const isErr = (v: unknown): v is McpError => !!v && typeof v === 'object' && (v as { ok?: unknown }).ok === false

  /** Every server Claude Code would see here (for `cwd`, the project's too). */
  async function servers(where: { given: string; real: string } | null): Promise<ServerDef[]> {
    const dir = deps.env.CLAUDE_CONFIG_DIR || path.join(deps.home, '.claude')
    const mainFile = deps.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(deps.home, '.claude.json')
    const [main, settings, installed] = await Promise.all([readJson(mainFile), readJson(path.join(dir, 'settings.json')), readJson(path.join(dir, 'plugins', 'installed_plugins.json'))])
    const out: ServerDef[] = []
    const seen = new Set<string>()
    const add = (d: ServerDef | null) => { if (d && !seen.has(d.name) && out.length < 128) { seen.add(d.name); out.push(d) } }
    const entries = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : [])
    // What the user offers other hosts on purpose comes first and wins a name.
    const offered = await readJson(path.join(deps.home, '.open-walnut', 'local', 'host-mcp.json'), 1024 * 1024)
    for (const [n, v] of entries(offered?.mcpServers)) add(toServerDef(n, v, 'walnut'))
    if (where) {
      // The project's own servers win over the user's, as in Claude Code, which keys a project
      // by the folder it was opened in (a symlink, or /tmp on macOS, is not its real path).
      type Project = { mcpServers?: unknown; enabledMcpjsonServers?: unknown; disabledMcpjsonServers?: unknown; enableAllProjectMcpServers?: unknown }
      const projects = (main?.projects ?? {}) as Record<string, Project>
      const project = projects[where.given] ?? projects[where.real]
      for (const [n, v] of entries(project?.mcpServers)) add(toServerDef(n, v, 'project'))
      // A .mcp.json server runs only once the user approved it there, as in Claude Code.
      const on = Array.isArray(project?.enabledMcpjsonServers) ? project!.enabledMcpjsonServers as unknown[] : []
      const off = Array.isArray(project?.disabledMcpjsonServers) ? project!.disabledMcpjsonServers as unknown[] : []
      const all = project?.enableAllProjectMcpServers === true || settings?.enableAllProjectMcpServers === true
      const dotMcp = await readJson(path.join(where.real, '.mcp.json'), 1024 * 1024)
      for (const [n, v] of entries(dotMcp?.mcpServers)) if (!off.includes(n) && (all || on.includes(n))) add(toServerDef(n, v, 'project'))
    }
    for (const [n, v] of entries(main?.mcpServers)) add(toServerDef(n, v, 'user'))
    const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>
    const plugins = (installed?.plugins ?? {}) as Record<string, Array<{ installPath?: unknown }>>
    for (const id of Object.keys(enabled).filter((k) => enabled[k] === true).slice(0, 64)) {
      const entry = Array.isArray(plugins[id]) ? plugins[id][0] : null
      const root = entry && typeof entry.installPath === 'string' ? entry.installPath : ''
      if (!root) continue
      const plugin = id.split('@')[0]
      const [dotMcp, manifest] = await Promise.all([readJson(path.join(root, '.mcp.json'), 1024 * 1024), readJson(path.join(root, '.claude-plugin', 'plugin.json'), 1024 * 1024)])
      const fromMcp = dotMcp ? (dotMcp.mcpServers !== undefined ? dotMcp.mcpServers : dotMcp) : null
      for (const [n, v] of entries(fromMcp)) add(toServerDef(n, v, 'plugin', plugin, root))
      for (const [n, v] of entries(manifest?.mcpServers)) add(toServerDef(n, v, 'plugin', plugin, root))
    }
    return out
  }

  async function list(req: { cwd?: unknown }): Promise<{ ok: true; servers: Array<Pick<ServerDef, 'name' | 'plugin' | 'scope' | 'type' | 'capability' | 'description'>> } | McpError> {
    const cwd = await resolveCwd(req.cwd)
    if (isErr(cwd)) return cwd
    const all = await servers(cwd)
    return { ok: true, servers: all.map((d) => ({
      name: d.name, ...(d.plugin ? { plugin: d.plugin } : {}), scope: d.scope, type: d.type,
      ...(d.capability ? { capability: d.capability } : {}), ...(d.description ? { description: d.description } : {}),
    })) }
  }

  function serverEnv(def: ServerDef): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...deps.env }
    for (const [k, v] of Object.entries(def.env ?? {})) env[k] = expandVars(v, deps.env, def.root)
    if (def.root) env.CLAUDE_PLUGIN_ROOT = def.root
    return env
  }

  function stdioConn(key: string, def: ServerDef, cwd: string): Conn {
    const env = serverEnv(def)
    const argv = [expandVars(def.command!, deps.env, def.root), ...(def.args ?? []).map((a) => expandVars(a, deps.env, def.root))]
    const pending = new Map<number, Pending>()
    let nextId = 1
    let stderr = ''
    const child = deps.spawn(deps.shell || '/bin/sh', ['-l', '-c', 'exec ' + argv.map(shellQuote).join(' ')], {
      cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    })
    const conn: Conn = {
      key, def, lastUsed: now(), inFlight: 0, dead: false,
      ready: Promise.resolve(),
      request: (method, params, ms) => new Promise((resolve, reject) => {
        if (conn.dead) { reject(new Error(`the server stopped${stderr ? `; its last words:\n${stderr.trim().slice(-500)}` : ''}`)); return }
        const id = nextId++
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no answer to ${method} within ${ms} ms`)) }, ms)
        timer.unref?.()
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
        write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      }),
      notify: (method) => write({ jsonrpc: '2.0', method }),
      close: (now?: boolean) => {
        if (conn.dead) return
        conn.dead = true
        try { child.stdin?.end() } catch { /* closed */ }
        const pid = child.pid
        if (typeof pid !== 'number') return
        // The daemon is exiting: no timer of ours would fire, so the group is told now.
        if (now) { try { deps.killGroup(pid, 'SIGTERM') } catch { /* gone */ } return }
        const term = setTimeout(() => {
          try { deps.killGroup(pid, 'SIGTERM') } catch { /* gone */ }
          const hard = setTimeout(() => { try { deps.killGroup(pid, 'SIGKILL') } catch { /* gone */ } }, KILL_GRACE_MS)
          hard.unref?.()
        }, 1_000)
        term.unref?.()
      },
    }
    const write = (msg: unknown) => { try { child.stdin?.write(JSON.stringify(msg) + '\n') } catch { /* the exit handler fails what waits */ } }
    let buf = ''
    // A character split across two pipe chunks stays whole.
    const out = new StringDecoder('utf8')
    const errText = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += out.write(chunk)
      if (buf.length > LINE_MAX) { buf = ''; return }
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue // a login shell's greeting, a stray log line
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) } catch { continue }
        if (typeof msg.method === 'string' && msg.id !== undefined) {
          // The server asks us: roots and ping have answers, nothing else is offered.
          if (msg.method === 'ping') write({ jsonrpc: '2.0', id: msg.id, result: {} })
          else if (msg.method === 'roots/list') write({ jsonrpc: '2.0', id: msg.id, result: { roots: [] } })
          else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not offered by this client' } })
          continue
        }
        if (typeof msg.id !== 'number') continue
        const p = pending.get(msg.id)
        if (!p) continue
        pending.delete(msg.id)
        const err = msg.error as { message?: unknown; code?: unknown } | undefined
        if (err) p.reject(new Error(`${String(err.message ?? 'error')} (${String(err.code ?? '')})`))
        else p.resolve(msg.result)
      }
    })
    // A server that exits leaves its stdin closed: a late write's EPIPE must not reach the daemon.
    child.stdin?.on('error', () => {})
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + errText.write(chunk)).slice(-STDERR_KEEP) })
    const gone = (why: string) => {
      conn.dead = true
      drop(key, conn)
      // What the server left in its group (npx's node, a uvx python) goes with it.
      if (typeof child.pid === 'number') { try { deps.killGroup(child.pid, 'SIGTERM') } catch { /* the group is gone */ } }
      for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(`the server stopped (${why})${stderr ? `; its last words:\n${stderr.trim().slice(-500)}` : ''}`)) }
    }
    child.on('error', (e) => gone(e.message))
    // close, not exit: the last answer may still be in the pipe when the process exits.
    child.on('close', (code, signal) => gone(signal ? `signal ${signal}` : `exit ${code}`))
    conn.ready = initialize(conn)
    return conn
  }

  function httpConn(key: string, def: ServerDef): Conn {
    const f = deps.fetch ?? globalThis.fetch
    const url = expandVars(def.url!, deps.env, def.root)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = expandVars(v, deps.env, def.root)
    let sessionId: string | null = null
    let nextId = 1
    /** A transport failure (not a JSON-RPC error) retires this connection: the next call starts a fresh session. */
    const post = async (msg: Record<string, unknown>, ms: number): Promise<unknown> => {
      try { return await exchange(msg, ms) } catch (err) {
        if (!(err as { rpc?: boolean }).rpc) { conn.dead = true; drop(key, conn) }
        throw err
      }
    }
    const exchange = async (msg: Record<string, unknown>, ms: number): Promise<unknown> => {
      const res = await f(url, {
        method: 'POST', signal: AbortSignal.timeout(ms),
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
        body: JSON.stringify(msg),
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) sessionId = sid
      if (res.status === 401 || res.status === 403) throw new Error(`the server refused this host's request (HTTP ${res.status}); a server that signs in with OAuth needs Claude Code's own sign-in, which Walnut does not use`)
      if (msg.id === undefined) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
      const type = res.headers.get('content-type') || ''
      const body = await res.text()
      let found: Record<string, unknown> | null = null
      if (type.includes('text/event-stream')) {
        for (const ev of body.split(/\r?\n\r?\n/)) {
          const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
          try { const m = JSON.parse(data) as Record<string, unknown>; if (m.id === msg.id) { found = m; break } } catch { /* not JSON */ }
        }
      } else {
        try { found = JSON.parse(body) as Record<string, unknown> } catch { /* below */ }
      }
      if (!found) throw new Error('the server sent no answer to the request')
      const err = found.error as { message?: unknown; code?: unknown } | undefined
      if (err) throw Object.assign(new Error(`${String(err.message ?? 'error')} (${String(err.code ?? '')})`), { rpc: true })
      return found.result
    }
    const conn: Conn = {
      key, def, lastUsed: now(), inFlight: 0, dead: false,
      ready: Promise.resolve(),
      request: (method, params, ms) => post({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, ms),
      notify: (method) => { void post({ jsonrpc: '2.0', method }, 10_000).catch(() => {}) },
      close: () => {
        conn.dead = true
        if (sessionId) void f(url, { method: 'DELETE', headers: { ...headers, 'Mcp-Session-Id': sessionId }, signal: AbortSignal.timeout(5_000) }).catch(() => {})
      },
    }
    conn.ready = initialize(conn)
    return conn
  }

  async function initialize(conn: Conn): Promise<void> {
    await conn.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'walnut-host-mcp', version: '1' } }, INIT_MS)
    conn.notify('notifications/initialized')
  }

  /** Forget `conn` under `key`, never a newer connection that took its place. */
  function drop(key: string, conn: Conn): void {
    if (conns.get(key) === conn) conns.delete(key)
  }

  function sweep(): void {
    const t = now()
    for (const [k, c] of conns) if (c.inFlight === 0 && t - c.lastUsed > IDLE_MS) { c.close(); conns.delete(k) }
    for (const [id, c] of calls) if (c.endedAt !== null && t - c.endedAt > KEEP_RESULT_MS) calls.delete(id)
    if (calls.size > MAX_CALLS) for (const [id, c] of calls) { if (calls.size <= MAX_CALLS) break; if (c.endedAt !== null) calls.delete(id) }
  }
  const timer = setInterval(sweep, 60_000)
  timer.unref?.()

  /** The live server for this task, server and folder, counted in flight: the caller's finally gives it back. */
  async function connFor(taskId: string, def: ServerDef, cwd: string | null): Promise<Conn | McpError> {
    const key = `${taskId}\u0000${def.name}\u0000${cwd ?? ''}`
    let c = conns.get(key)
    if (c && c.dead) { conns.delete(key); c = undefined }
    if (!c) {
      if (def.type === 'sse') return bad(`${def.name} uses the old sse transport, which Walnut does not call; only stdio and http servers`, 'unsupported_transport')
      sweep()
      if (conns.size >= MAX_LIVE) {
        // Make room: the idle server used longest ago goes.
        const idle = [...conns.values()].filter((x) => x.inFlight === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0]
        if (!idle) return bad(`this host already runs ${MAX_LIVE} MCP servers for other hosts, all busy; try again in a moment`, 'busy')
        idle.close(); conns.delete(idle.key)
      }
      try {
        c = def.type === 'http' ? httpConn(key, def) : stdioConn(key, def, cwd ?? deps.home)
      } catch (err) {
        return bad(`could not start ${def.name}: ${(err as Error).message}`, 'server_failed')
      }
      conns.set(key, c)
    }
    // In flight from here: a server still starting is never the idle one evicted.
    c.inFlight++
    try { await c.ready } catch (err) {
      c.inFlight--
      c.close(); drop(key, c)
      return bad(`${def.name} did not start: ${(err as Error).message}`, 'server_failed')
    }
    return c
  }

  function normalize(result: unknown): CallResult {
    const r = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown }
    const parts: string[] = []
    const images: CallResult['images'] = []
    let imageChars = 0
    for (const item of Array.isArray(r.content) ? r.content as Array<Record<string, unknown>> : []) {
      if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      else if (item.type === 'image' || item.type === 'audio') {
        const data = typeof item.data === 'string' ? item.data : ''
        const keep = item.type === 'image' && data && imageChars + data.length <= IMAGES_MAX
        if (keep) imageChars += data.length
        images.push({ mimeType: String(item.mimeType ?? item.type), bytes: Math.floor(data.length * 3 / 4), ...(keep ? { data } : {}) })
      }
      else if (item.type === 'resource' && item.resource && typeof (item.resource as { text?: unknown }).text === 'string') parts.push((item.resource as { text: string }).text)
      else if (item.type === 'resource_link') parts.push(`[resource ${String(item.uri ?? '')}]`)
    }
    let text = parts.join('\n')
    const truncated = text.length > TEXT_MAX
    if (truncated) text = text.slice(0, TEXT_MAX)
    let structured: unknown
    if (r.structuredContent !== undefined) {
      const s = JSON.stringify(r.structuredContent)
      if (s && s.length <= STRUCTURED_MAX) structured = r.structuredContent
    }
    return { isError: r.isError === true, text, truncated, images, ...(structured !== undefined ? { structured } : {}) }
  }

  /** Start one call (a tool, or the tool list) as a kept result, and wait up to `wait` for it. */
  async function start(req: { callId?: unknown; taskId?: unknown; wait?: unknown }, work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (typeof req.taskId !== 'string' || !req.taskId) return bad('taskId is required')
    const callId = typeof req.callId === 'string' && CALL_ID_RE.test(req.callId) ? req.callId : `mc-${now().toString(36)}-${(++seq).toString(36)}`
    if (calls.has(callId)) return bad(`call ${callId} already exists`)
    const entry = { taskId: req.taskId, startedAt: now(), endedAt: null as number | null, reply: null as Record<string, unknown> | null, waiters: [] as Array<() => void> }
    calls.set(callId, entry)
    void work().catch((err) => bad((err as Error).message, 'server_failed') as Record<string, unknown>).then((reply) => {
      entry.reply = reply
      entry.endedAt = now()
      for (const w of entry.waiters.splice(0)) w()
    })
    return waitFor(callId, entry, req.wait)
  }

  async function waitFor(callId: string, entry: NonNullable<ReturnType<typeof calls.get>>, wait: unknown): Promise<Record<string, unknown>> {
    const ms = typeof wait === 'number' && wait > 0 ? Math.min(wait, CALL_MAX_MS) : 0
    if (entry.endedAt === null && ms > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms)
        t.unref?.()
        entry.waiters.push(() => { clearTimeout(t); resolve() })
      })
    }
    if (entry.endedAt === null) return { ok: true, callId, running: true, ms: now() - entry.startedAt }
    return { callId, running: false, ms: entry.endedAt - entry.startedAt, ...entry.reply! }
  }

  async function prepare(req: { taskId?: unknown; server?: unknown; cwd?: unknown }): Promise<{ def: ServerDef; cwd: string | null } | McpError> {
    if (typeof req.server !== 'string' || !req.server) return bad('server is required')
    const cwd = await resolveCwd(req.cwd)
    if (isErr(cwd)) return cwd
    const def = (await servers(cwd)).find((d) => d.name === req.server)
    if (!def) return bad(`no MCP server named ${req.server} on this host${cwd ? ` for ${cwd.given}` : ''} (host_mcp_list names them)`, 'unknown_server')
    return { def, cwd: cwd ? cwd.real : null }
  }

  /** The server's tools (all pages), starting it when it is not running. */
  async function tools(req: { callId?: unknown; taskId?: unknown; server?: unknown; cwd?: unknown; wait?: unknown }): Promise<Record<string, unknown>> {
    const p = await prepare(req)
    if ('ok' in p) return p
    return start(req, async () => {
      const c = await connFor(req.taskId as string, p.def, p.cwd)
      if ('ok' in c) return c
      try {
        const out: ToolView[] = []
        let cursor: string | undefined
        for (let page = 0; page < 20; page++) {
          const r = await c.request('tools/list', cursor ? { cursor } : {}, CALL_DEFAULT_MS) as { tools?: Array<Record<string, unknown>>; nextCursor?: unknown }
          for (const t of r?.tools ?? []) if (typeof t.name === 'string') out.push({ name: t.name, ...(typeof t.description === 'string' ? { description: t.description.slice(0, 4000) } : {}), ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}) })
          cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
          if (!cursor) break
        }
        return { ok: true, server: p.def.name, tools: out }
      } finally { c.inFlight--; c.lastUsed = now() }
    })
  }

  async function call(req: { callId?: unknown; taskId?: unknown; server?: unknown; tool?: unknown; arguments?: unknown; cwd?: unknown; timeoutMs?: unknown; wait?: unknown }): Promise<Record<string, unknown>> {
    if (typeof req.tool !== 'string' || !req.tool) return bad('tool is required')
    if (req.arguments !== undefined && (typeof req.arguments !== 'object' || req.arguments === null || Array.isArray(req.arguments))) return bad('arguments must be an object')
    const p = await prepare(req)
    if ('ok' in p) return p
    const timeoutMs = Math.min(typeof req.timeoutMs === 'number' && req.timeoutMs > 0 ? req.timeoutMs : CALL_DEFAULT_MS, CALL_MAX_MS)
    return start(req, async () => {
      const c = await connFor(req.taskId as string, p.def, p.cwd)
      if ('ok' in c) return c
      try {
        const r = await c.request('tools/call', { name: req.tool, arguments: req.arguments ?? {} }, timeoutMs)
        return { ok: true, server: p.def.name, tool: req.tool, ...normalize(r) }
      } finally { c.inFlight--; c.lastUsed = now() }
    })
  }

  /** A kept call's answer, waiting up to `wait` for it; only the task that started it reads it. */
  async function result(req: { callId?: unknown; taskId?: unknown; wait?: unknown }): Promise<Record<string, unknown>> {
    const entry = typeof req.callId === 'string' ? calls.get(req.callId) : undefined
    if (!entry || (typeof req.taskId === 'string' && entry.taskId !== req.taskId)) return bad(`no call ${String(req.callId)} on this host (an answer is kept 10 minutes)`, 'unknown_call')
    return waitFor(req.callId as string, entry, req.wait)
  }

  function closeAll(): void {
    clearInterval(timer)
    for (const c of conns.values()) c.close(true)
    conns.clear()
  }

  return { list, tools, call, result, closeAll, liveCount: () => conns.size }
}

export type HostMcp = ReturnType<typeof createHostMcp>

/**
 * Host start: how a host's daemon starts a NEW Ask Walnut session while the Mac
 * is away (docs/plan/walnut-replica-servers-impl.md section 8, WP12,
 * cap `replica-start-v1`).
 *
 * The daemon never runs an argv a follower wrote, and it does not grow a second
 * argv builder beside src/providers/claude-code-session.ts. The Mac builds a
 * SPAWN TEMPLATE for this host (src/providers/spawn-template.ts, the same flags
 * claude-code-session.ts builds: the `--settings` JSON with the compact hook,
 * `--debug`, the bypass capability, the input and prompt flags) and pushes it on
 * its trusted socket (`leader.spawnTemplate`). The template holds literal strings
 * and SLOTS; this core fills the slots from validated fields only:
 *
 *   sid       a v4 UUID (the client's own id for the launch, else minted by the
 *             replica)                                    --session-id <sid>
 *   mode      the template's allowlist (the host default and plan; bypass only
 *             when the Mac allowed it for this Walnut)   --permission-mode <cli>
 *   model     a template model id (its CLI value), else the value itself when it
 *             is one CLI value (send() passes an unknown id through the same way)
 *                                                         --model <cli> (absent: Auto)
 *   effort    the CLI's effort ids, only for a model that takes it (the template's
 *             own flag, else the Mac's effort rules)      --effort <id>
 *   persona   the persona copy's text: written to a 0600 file under this
 *             Walnut's run dir; passed by path (`--append-system-prompt-file`) or
 *             as the string (`--append-system-prompt`, the template says which),
 *             at most 120 KB as a string (one argv string on Linux is 128 KB)
 *   tools     the agent's tool lists from the TEMPLATE (the Mac's lane profile),
 *             never from the follower                    --allowedTools, --tools
 *   cwd       the template's own folder (a follower naming another is refused)
 *   message   the first message rides stdin (the start's `message`), never argv
 *
 * No walnut MCP mount: a host ask gets its walnut tools the way every session this
 * Mac runs on a remote host does, through the `walnut` CLI on PATH, which the
 * daemon's spawn points at its own gateway socket (WALNUT_AGENT_SOCKET and
 * WALNUT_SESSION_ID in the CLI's env). An MCP server there would talk to that
 * host's 127.0.0.1:3456, which is not this Walnut.
 *
 * Limits as resumeForTrigger: 2 starting at once, none while 20 sessions here are
 * mid-turn, 10 starts per hour per Walnut. No template for that Walnut:
 * `needs_leader {why:'no_spawn_template'}`. `precheck` runs every check of a start
 * and starts nothing, so the replica journals the ask's task only after it passed.
 * `once` holds a start per session id: a retry while the CLI is still starting (or
 * soon after it answered) gets the first attempt's answer, never a second CLI.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createHostStart;
 * daemon-source.ts inlines `createHostStart.toString()` through
 * `__CREATE_HOST_START__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export type SpawnSlot = 'sid' | 'mode' | 'model' | 'effort' | 'persona' | 'tools'

/**
 * How a model value the template does not list decides --effort, as the Mac's
 * modelEffortCapability (core/types.ts) does: the first override whose `match` the
 * lowercased value contains (an override without `effort` falls to the family), then
 * the first family it contains, else effort (the Mac's permissive default).
 */
export interface EffortRules {
  overrides: Array<{ match: string; effort?: boolean }>
  families: Array<{ match: string; effort: boolean }>
}

/** An agent's tool lists, from the Mac's lane profile for that agent. */
export interface AgentTools { allowedTools?: string[]; tools?: string[] }

export interface SpawnTemplate {
  v: 1
  /** The Walnut (its data dir on the Mac) this template is for. */
  home: string
  /** Literal argv strings and slots, in the order claude-code-session.ts builds them. */
  argv: Array<string | { slot: SpawnSlot }>
  /** Walnut mode id to `--permission-mode` value: the only modes a start may ask for. */
  modes: Record<string, string>
  /** The mode a start that names none gets (one of `modes`). */
  defaultMode: string
  /** Model id (and its CLI value) to the CLI value, and whether that model takes --effort. */
  models: Record<string, { cli: string; effort: boolean }>
  /** No model (Auto): whether --effort is passed. */
  autoEffort: boolean
  /** A model value outside `models`: whether it takes --effort. */
  effortRules: EffortRules
  efforts: string[]
  /** Per agent id: the tool lists its ask gets (absent: none, the lanes' own default). */
  agents: Record<string, AgentTools>
  /** How the persona rides: as the CLI's file flag, or as the string flag. */
  persona: 'arg' | 'file'
  /** The folder asks run in on this host (absolute). */
  cwd: string
  builtAt: number
}

export interface HostStartFields {
  sid: string
  taskId: string
  agentId: string
  title: string
  cwd?: string
  model?: string
  effort?: string
  mode?: string
  /**
   * text: the persona copy's prompt; context: the session context the replica built for
   * the ask's task (session-context.ts), appended after it as claude-code-session.ts does.
   * No tool lists: those come from the template.
   */
  persona: { text: string; context?: string; mode?: 'append' | 'replace' }
  firstMessage: string
  /** A precheck (follower.start {check:true}): no taskId yet, nothing written or started. */
  check?: boolean
}

/** A start's answer as the twin sends it (`once` hands the same one to every retry). */
export type HostStartAnswer =
  | { ok: true; reply: Record<string, unknown> }
  | { ok: false; error: string; extra: Record<string, unknown> }

export interface HostStartPlan {
  sid: string
  taskId: string
  /** The full argv for the daemon's start (argv[0] is the CLI). */
  args: string[]
  cwd: string
  message: string
  /** Walnut mode id the session starts in. */
  mode: string
  personaFile: string
  /** The journal's `session` record body (offline-journal-core v2 kind `session`). */
  record: { kind: 'session'; sid: string; taskId: string; host: string; cwd: string; agentId: string; model?: string; effort?: string; mode: string; title: string; startedAt: number
    /** The first words (at most 4000 characters): the Mac titles the ask from them after adoption. */
    firstMessage?: string }
}

export type HostStartRefusal = { ok: false; code: string; message: string; detail?: Record<string, unknown>; retryAfterMs?: number }

export interface HostStartDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Where templates are kept (spawn-template-<key>.json) and persona files go (personas/<key>/). */
  dir: string
  keyOf: (home: string) => string
  now: () => number
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** Sessions here mid-turn now. */
  busy: () => number
}

/** A start whose CLI may run before its `session` record is kept (startHostAsk in the twins). */
export interface PendingStart {
  sid: string
  record: HostStartPlan['record']
  opId?: string
  actor?: unknown
}

export interface HostStart {
  /** The Mac's template for a Walnut (trusted socket only; the twin checks). Throws on a bad one. */
  setTemplate(home: string, raw: unknown): SpawnTemplate
  templateOf(home: string): SpawnTemplate | null
  /** Validate and fill: the plan the twin spawns, or a refusal. Never throws. */
  plan(home: string, raw: unknown, hostKey: string): { ok: true; plan: HostStartPlan } | HostStartRefusal
  /** Every check `plan` makes (the limits too), with no taskId needed and nothing written: null when it passes. */
  precheck(home: string, raw: unknown): HostStartRefusal | null
  /** A start is under way (limits). Returns the release. */
  begin(home: string): () => void
  /**
   * The start of `sid`, run once: `run` for the first ask, the first attempt's answer for
   * a retry while it runs, or for 10 minutes after it started a CLI (a failed start is
   * forgotten: nothing runs, so a later try plans again). 'taken': another Walnut's start.
   */
  once(home: string, sid: string, run: () => Promise<HostStartAnswer>): Promise<HostStartAnswer> | 'taken'
  /** The start of `sid` this daemon holds (running, or answered within 10 minutes), 'taken' for another Walnut's, or null. */
  firstStart(home: string, sid: string): Promise<HostStartAnswer> | 'taken' | null
  /**
   * Keep a start on disk before its CLI is spawned, until its `session` record is kept: a
   * daemon that dies in between journals the record at its next boot (pendingStarts), so
   * the Mac never loses an ask whose CLI runs. Throws when it cannot be written.
   */
  holdPending(home: string, entry: PendingStart): void
  releasePending(home: string, sid: string): void
  /** Every start kept on disk (an unreadable one is dropped with a warning). */
  pendingStarts(): Array<PendingStart & { home: string; at: number }>
}

export function createHostStart(deps: HostStartDeps): HostStart {
  const { fs, path } = deps
  const SLOTS = ['sid', 'mode', 'model', 'effort', 'persona', 'tools']
  const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
  const MODE_RE = /^[A-Za-z]{1,32}$/
  /** One CLI value: never a flag (it starts with a letter or digit), never a shell word. */
  const CLI_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,127}$/
  /** A tool rule (`Bash(walnut:*)`): never a flag, never two rules in one. */
  const TOOL_RE = /^[A-Za-z0-9_.:*()/][A-Za-z0-9_.:*()/ -]{0,199}$/
  const MATCH_RE = /^[a-z0-9._-]{1,64}$/
  /** How long a start's answer is handed to a retry after it started a CLI. */
  const ANSWER_KEEP_MS = 10 * 60 * 1000
  /** One argv string on Linux is at most 128 KB (MAX_ARG_STRLEN); keep room for the rest. */
  const MAX_PERSONA_ARG_BYTES = 120 * 1024
  const MAX_PERSONA_FILE_BYTES = 1024 * 1024
  const MAX_MESSAGE_BYTES = 512 * 1024
  const MAX_TEMPLATE_STRING = 64 * 1024
  const MAX_STARTING = 2
  const MAX_BUSY = 20
  const MAX_PER_HOUR = 10
  const HOUR_MS = 60 * 60 * 1000
  const templates = new Map<string, SpawnTemplate>()
  const startedAt = new Map<string, number[]>()
  /** Starts by session id: the Walnut, the answer, and when it started a CLI. */
  const firstStarts = new Map<string, { home: string; answer: Promise<HostStartAnswer>; doneAt?: number }>()
  let starting = 0

  function refuse(code: string, message: string, detail?: Record<string, unknown>, retryAfterMs?: number): HostStartRefusal {
    return { ok: false, code, message, ...(detail ? { detail } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  }

  function fileOf(home: string): string {
    return path.join(deps.dir, 'spawn-template-' + deps.keyOf(home) + '.json')
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v)
  }

  /** A tool list: null when any rule is not one (a template's makes the template bad). */
  function toolList(v: unknown): string[] | null {
    if (v === undefined) return []
    if (!Array.isArray(v) || v.length > 64 || !v.every((t) => typeof t === 'string' && TOOL_RE.test(t) && t.indexOf(',') === -1)) return null
    return v as string[]
  }

  /** The Mac's template, checked for shape (it comes from the trusted socket, but a bad one must not half-work). */
  function checkTemplate(home: string, raw: unknown): SpawnTemplate {
    if (!isRecord(raw) || raw.v !== 1) throw new Error('spawn template: v must be 1')
    if (raw.home !== home) throw new Error('spawn template: home must be the Walnut it is pushed for')
    if (!Array.isArray(raw.argv) || raw.argv.length < 2 || raw.argv.length > 128) throw new Error('spawn template: argv must hold 2 to 128 items')
    const argv: SpawnTemplate['argv'] = []
    const seen = new Set<string>()
    for (const a of raw.argv) {
      if (typeof a === 'string') {
        if (a.length > MAX_TEMPLATE_STRING) throw new Error('spawn template: an argv string is too long')
        argv.push(a)
        continue
      }
      const slot = isRecord(a) ? a.slot : undefined
      if (typeof slot !== 'string' || SLOTS.indexOf(slot) === -1 || seen.has(slot)) throw new Error('spawn template: bad or repeated slot')
      seen.add(slot)
      argv.push({ slot: slot as SpawnSlot })
    }
    if (typeof argv[0] !== 'string' || !argv[0]) throw new Error('spawn template: argv[0] must be the CLI')
    for (const need of ['sid', 'mode', 'persona']) if (!seen.has(need)) throw new Error('spawn template: missing slot ' + need)
    const modes: Record<string, string> = {}
    for (const [k, v] of Object.entries(isRecord(raw.modes) ? raw.modes : {})) {
      if (!MODE_RE.test(k) || typeof v !== 'string' || !MODE_RE.test(v)) throw new Error('spawn template: bad mode')
      modes[k] = v
    }
    if (typeof raw.defaultMode !== 'string' || !(raw.defaultMode in modes)) throw new Error('spawn template: defaultMode must be one of modes')
    const models: SpawnTemplate['models'] = {}
    for (const [k, v] of Object.entries(isRecord(raw.models) ? raw.models : {})) {
      const m = v as { cli?: unknown; effort?: unknown }
      if (!CLI_VALUE_RE.test(k) || !isRecord(m) || typeof m.cli !== 'string' || !CLI_VALUE_RE.test(m.cli)) throw new Error('spawn template: bad model')
      models[k] = { cli: m.cli, effort: m.effort === true }
    }
    const efforts = Array.isArray(raw.efforts) ? raw.efforts.filter((e): e is string => typeof e === 'string' && MODE_RE.test(e)) : []
    const rulesRaw = isRecord(raw.effortRules) ? raw.effortRules : {}
    const effortRules: EffortRules = { overrides: [], families: [] }
    for (const o of Array.isArray(rulesRaw.overrides) ? rulesRaw.overrides : []) {
      if (!isRecord(o) || typeof o.match !== 'string' || !MATCH_RE.test(o.match) || (o.effort !== undefined && typeof o.effort !== 'boolean')) throw new Error('spawn template: bad effort rule')
      effortRules.overrides.push({ match: o.match, ...(typeof o.effort === 'boolean' ? { effort: o.effort } : {}) })
    }
    for (const f of Array.isArray(rulesRaw.families) ? rulesRaw.families : []) {
      if (!isRecord(f) || typeof f.match !== 'string' || !MATCH_RE.test(f.match) || typeof f.effort !== 'boolean') throw new Error('spawn template: bad effort rule')
      effortRules.families.push({ match: f.match, effort: f.effort })
    }
    const agents: Record<string, AgentTools> = {}
    for (const [k, v] of Object.entries(isRecord(raw.agents) ? raw.agents : {})) {
      const a = isRecord(v) ? v : null
      const allowedTools = a ? toolList(a.allowedTools) : null
      const tools = a ? toolList(a.tools) : null
      if (!ID_RE.test(k) || !allowedTools || !tools) throw new Error('spawn template: bad agent tool list')
      agents[k] = { ...(allowedTools.length ? { allowedTools } : {}), ...(tools.length ? { tools } : {}) }
    }
    if (raw.persona !== 'arg' && raw.persona !== 'file') throw new Error('spawn template: persona must be arg or file')
    if (typeof raw.cwd !== 'string' || !raw.cwd.startsWith('/') || raw.cwd.length > 1024 || raw.cwd.split('/').indexOf('..') !== -1) throw new Error('spawn template: cwd must be an absolute path')
    return {
      v: 1, home, argv, modes, defaultMode: raw.defaultMode, models, autoEffort: raw.autoEffort === true, effortRules, efforts, agents,
      persona: raw.persona, cwd: raw.cwd, builtAt: typeof raw.builtAt === 'number' ? raw.builtAt : deps.now(),
    }
  }

  /** Whether a model value the template does not list takes --effort (EffortRules). */
  function effortOf(t: SpawnTemplate, value: string): boolean {
    const m = value.toLowerCase()
    const o = t.effortRules.overrides.find((r) => m.indexOf(r.match) !== -1)
    const f = t.effortRules.families.find((r) => m.indexOf(r.match) !== -1)
    return o && o.effort !== undefined ? o.effort : f ? f.effort : true
  }

  function writeAtomic(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.' + process.pid + '.' + deps.now() + '.tmp'
    fs.writeFileSync(tmp, body, { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function setTemplate(home: string, raw: unknown): SpawnTemplate {
    if (typeof home !== 'string' || !home) throw new Error('spawn template: missing home')
    const t = checkTemplate(home, raw)
    templates.set(home, t)
    // Kept on disk too: a daemon restarted while the Mac sleeps still starts asks.
    try { writeAtomic(fileOf(home), JSON.stringify(t)) } catch (err) {
      deps.log('warn', 'host start: the spawn template was not saved', { home, error: (err as Error).message })
    }
    deps.log('info', 'host start: spawn template set', { home, argv: t.argv.length, modes: Object.keys(t.modes).join(','), persona: t.persona })
    return t
  }

  function templateOf(home: string): SpawnTemplate | null {
    const known = templates.get(home)
    if (known) return known
    let text: string
    try { text = fs.readFileSync(fileOf(home), 'utf8') } catch { return null }
    try {
      const t = checkTemplate(home, JSON.parse(text))
      templates.set(home, t)
      return t
    } catch (err) {
      deps.log('warn', 'host start: the saved spawn template does not read back', { home, error: (err as Error).message })
      return null
    }
  }

  function begin(home: string): () => void {
    starting++
    const list = (startedAt.get(home) ?? []).filter((t) => deps.now() - t < HOUR_MS)
    list.push(deps.now())
    startedAt.set(home, list)
    let done = false
    return () => { if (!done) { done = true; starting-- } }
  }

  function limits(home: string): HostStartRefusal | null {
    const now = deps.now()
    const recent = (startedAt.get(home) ?? []).filter((t) => now - t < HOUR_MS)
    startedAt.set(home, recent)
    if (starting >= MAX_STARTING) return refuse('throttled', 'other sessions are starting on this host', undefined, 5_000)
    if (deps.busy() >= MAX_BUSY) return refuse('throttled', 'this host is busy', undefined, 60_000)
    if (recent.length >= MAX_PER_HOUR) return refuse('throttled', `this host started ${MAX_PER_HOUR} asks for this Walnut in the last hour`, undefined, HOUR_MS - (now - recent[0]))
    return null
  }

  function bytes(s: string): number {
    return Buffer.byteLength(s, 'utf8')
  }

  function personaFile(home: string, sid: string, text: string): string {
    const dir = path.join(deps.dir, 'personas', deps.keyOf(home))
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(dir, 0o700) } catch { /* the mkdir mode already holds on a new dir */ }
    const file = path.join(dir, sid + '.md')
    writeAtomic(file, text)
    fs.chmodSync(file, 0o600)
    return file
  }

  function str(v: unknown, max: number): string | undefined {
    return typeof v === 'string' && v.length <= max && v.indexOf('\u0000') === -1 ? v : undefined
  }

  interface Fields {
    t: SpawnTemplate; sid: string; taskId: string; agentId: string; title: string; mode: string
    model: { id: string; cli: string; effort: boolean } | null; effort?: string
    text: string; context: string; replace: boolean; appendText: string; message: string; tools: AgentTools
  }

  /** Every field of a start checked; a bad one refuses the whole start. `noTask`: a precheck, no taskId yet. */
  function validate(home: string, raw: unknown, noTask: boolean): Fields | HostStartRefusal {
    const t = templateOf(home)
    if (!t) return refuse('needs_leader', 'this host has no spawn template from your Mac yet; a new ask needs your Mac', { why: 'no_spawn_template' })
    if (!isRecord(raw)) return refuse('bad_request', 'follower.start needs an object')
    const sid = typeof raw.sid === 'string' && SID_RE.test(raw.sid) ? raw.sid : ''
    if (!sid) return refuse('bad_request', 'follower.start: sid must be a v4 UUID')
    const taskId = noTask && raw.taskId === undefined ? '' : typeof raw.taskId === 'string' && ID_RE.test(raw.taskId) ? raw.taskId : null
    if (taskId === null || (!noTask && !taskId)) return refuse('bad_request', 'follower.start: bad taskId')
    const agentId = raw.agentId === undefined ? 'general' : typeof raw.agentId === 'string' && ID_RE.test(raw.agentId) ? raw.agentId : ''
    if (!agentId) return refuse('bad_request', 'follower.start: bad agentId')
    const title = str(raw.title ?? '', 500)
    if (title === undefined) return refuse('bad_request', 'follower.start: bad title')
    if (raw.cwd !== undefined && raw.cwd !== t.cwd) return refuse('bad_request', 'follower.start: an ask runs in the folder your Mac set for this host')
    const mode = raw.mode === undefined || raw.mode === '' ? t.defaultMode : typeof raw.mode === 'string' && Object.prototype.hasOwnProperty.call(t.modes, raw.mode) ? raw.mode : ''
    if (!mode) return refuse('bad_request', 'follower.start: that permission mode is not allowed for an ask on this host', { modes: Object.keys(t.modes) })
    let model: Fields['model'] = null
    if (raw.model !== undefined && raw.model !== '' && raw.model !== 'default') {
      const id = typeof raw.model === 'string' ? raw.model : ''
      const hit = Object.prototype.hasOwnProperty.call(t.models, id) ? t.models[id] : Object.values(t.models).find((m) => m.cli === id)
      // A value the template does not list rides as itself, as send() passes it
      // (SESSION_MODEL_CLI_MAP[model] ?? model): one CLI value, never a flag.
      if (hit) model = { id, ...hit }
      else if (CLI_VALUE_RE.test(id)) model = { id, cli: id, effort: effortOf(t, id) }
      else return refuse('bad_request', 'follower.start: a model must be one CLI value', { models: Object.keys(t.models) })
    }
    const effort = raw.effort === undefined || raw.effort === '' ? undefined : typeof raw.effort === 'string' && t.efforts.indexOf(raw.effort) !== -1 ? raw.effort : null
    if (effort === null) return refuse('bad_request', 'follower.start: unknown effort')
    const p = isRecord(raw.persona) ? raw.persona : null
    const text = p ? str(p.text, MAX_PERSONA_FILE_BYTES) : undefined
    if (!p || !text) return refuse('needs_leader', 'the persona of this agent is not on this host yet; a new ask needs your Mac', { why: 'persona_not_copied' })
    const context = p.context === undefined ? '' : str(p.context, MAX_PERSONA_FILE_BYTES)
    if (context === undefined) return refuse('bad_request', 'follower.start: bad persona context')
    // A flag's value never starts with a dash: the CLI's parser must not read it as a flag.
    if (text.startsWith('-') || context.startsWith('-')) return refuse('bad_request', 'follower.start: a persona must not start with a dash')
    const replace = p.mode === 'replace'
    if (p.mode !== undefined && p.mode !== 'append' && p.mode !== 'replace') return refuse('bad_request', 'follower.start: bad persona mode')
    // Tool lists are the Mac's (the template): a follower naming its own is refused.
    if (p.allowedTools !== undefined || p.tools !== undefined) return refuse('bad_request', 'follower.start: tool lists come from your Mac\'s template, never from a start')
    const message = str(raw.firstMessage ?? '', MAX_MESSAGE_BYTES)
    if (message === undefined || bytes(message) > MAX_MESSAGE_BYTES) return refuse('bad_request', 'follower.start: bad first message')
    const appendText = replace ? context : [text, context].filter(Boolean).join('\n\n')
    if (t.persona === 'arg' && (bytes(appendText) > MAX_PERSONA_ARG_BYTES || (replace && bytes(text) > MAX_PERSONA_ARG_BYTES))) {
      return refuse('bad_request', `follower.start: the persona is over ${MAX_PERSONA_ARG_BYTES} bytes, too large for one argv string`, { why: 'persona_too_large' })
    }
    const tools = Object.prototype.hasOwnProperty.call(t.agents, agentId) ? t.agents[agentId] : {}
    return { t, sid, taskId, agentId, title, mode, model, ...(effort ? { effort } : {}), text, context, replace, appendText, message, tools }
  }

  function precheck(home: string, raw: unknown): HostStartRefusal | null {
    try {
      const f = validate(home, raw, true)
      if ('ok' in f) return f
      return limits(home)
    } catch (err) {
      deps.log('warn', 'host start: the start could not be checked', { home, error: (err as Error).message })
      return refuse('internal', 'this host could not check the session: ' + (err as Error).message)
    }
  }

  /** Validate the follower's fields and fill the template. */
  function plan(home: string, raw: unknown, hostKey: string): { ok: true; plan: HostStartPlan } | HostStartRefusal {
    try {
      const f = validate(home, raw, false)
      if ('ok' in f) return f
      const { t, sid, taskId, agentId, title, mode, model, effort, text, context, replace, appendText, message } = f
      const blocked = limits(home)
      if (blocked) return blocked
      const file = personaFile(home, sid, replace ? text + (context ? '\n\n' + context : '') : appendText)
      const contextFile = replace && context && t.persona === 'file' ? personaFile(home, sid + '-context', context) : ''
      const args: string[] = []
      for (const a of t.argv) {
        if (typeof a === 'string') { args.push(a); continue }
        switch (a.slot) {
          case 'sid': args.push('--session-id', sid); break
          case 'mode': args.push('--permission-mode', t.modes[mode]); break
          case 'model': if (model) args.push('--model', model.cli); break
          case 'effort': if (effort && (model ? model.effort : t.autoEffort)) args.push('--effort', effort); break
          case 'persona':
            if (t.persona === 'file') {
              if (replace) { args.push('--system-prompt-file', file); if (contextFile) args.push('--append-system-prompt-file', contextFile) }
              else if (appendText) args.push('--append-system-prompt-file', file)
            } else {
              if (replace) args.push('--system-prompt', text)
              if (appendText) args.push('--append-system-prompt', appendText)
            }
            break
          case 'tools':
            if (f.tools.allowedTools && f.tools.allowedTools.length) args.push('--allowedTools', f.tools.allowedTools.join(','))
            if (f.tools.tools && f.tools.tools.length) args.push('--tools', f.tools.tools.join(','))
            break
        }
      }
      const host = typeof hostKey === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(hostKey) ? hostKey : ''
      return {
        ok: true,
        plan: {
          sid, taskId, args, cwd: t.cwd, message, mode, personaFile: file,
          record: {
            kind: 'session', sid, taskId, host, cwd: t.cwd, agentId, mode, title, startedAt: deps.now(),
            ...(message ? { firstMessage: message.slice(0, 4000) } : {}),
            ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}),
          },
        },
      }
    } catch (err) {
      deps.log('warn', 'host start: the start could not be planned', { home, error: (err as Error).message })
      return refuse('journal_unwritable', 'this host could not prepare the session: ' + (err as Error).message)
    }
  }

  function firstStart(home: string, sid: string): Promise<HostStartAnswer> | 'taken' | null {
    const now = deps.now()
    for (const [k, e] of firstStarts) if (e.doneAt !== undefined && now - e.doneAt > ANSWER_KEEP_MS) firstStarts.delete(k)
    const e = firstStarts.get(sid)
    if (!e) return null
    return e.home === home ? e.answer : 'taken'
  }

  function once(home: string, sid: string, run: () => Promise<HostStartAnswer>): Promise<HostStartAnswer> | 'taken' {
    const known = firstStart(home, sid)
    if (known) return known
    let answer: Promise<HostStartAnswer>
    // run() is called at once, so its first steps (begin) happen before any other command is read.
    try { answer = Promise.resolve(run()) } catch (err) { answer = Promise.reject(err) }
    const entry: { home: string; answer: Promise<HostStartAnswer>; doneAt?: number } = {
      home,
      answer: answer.catch((err: unknown) => ({ ok: false as const, error: 'follower.start: ' + (err instanceof Error ? err.message : String(err)), extra: { errorKind: 'internal' } })),
    }
    firstStarts.set(sid, entry)
    void entry.answer.then((a) => {
      if (a.ok) entry.doneAt = deps.now()
      else if (firstStarts.get(sid) === entry) firstStarts.delete(sid)
    })
    return entry.answer
  }

  function pendingDir(): string {
    return path.join(deps.dir, 'pending-starts')
  }

  function pendingFile(home: string, sid: string): string {
    return path.join(pendingDir(), deps.keyOf(home) + '-' + sid + '.json')
  }

  function holdPending(home: string, entry: PendingStart): void {
    if (!SID_RE.test(entry.sid) || !isRecord(entry.record) || entry.record.sid !== entry.sid) throw new Error('pending start: bad entry')
    writeAtomic(pendingFile(home, entry.sid), JSON.stringify({ v: 1, home, ...entry, at: deps.now() }))
  }

  function releasePending(home: string, sid: string): void {
    if (!SID_RE.test(sid)) return
    try { fs.unlinkSync(pendingFile(home, sid)) } catch { /* none, or gone */ }
  }

  function pendingStarts(): Array<PendingStart & { home: string; at: number }> {
    let names: string[] = []
    try { names = fs.readdirSync(pendingDir()) } catch { return [] }
    const out: Array<PendingStart & { home: string; at: number }> = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(pendingDir(), name)
      let e: Record<string, unknown> | null = null
      try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); e = isRecord(v) ? v : null } catch { e = null }
      const home = e && typeof e.home === 'string' ? e.home : ''
      const sid = e && typeof e.sid === 'string' ? e.sid : ''
      const record = e && isRecord(e.record) ? e.record : null
      if (!e || e.v !== 1 || !home || !SID_RE.test(sid) || !record || record.kind !== 'session' || record.sid !== sid || name !== deps.keyOf(home) + '-' + sid + '.json') {
        deps.log('warn', 'host start: an unreadable pending start is dropped', { file: name })
        try { fs.unlinkSync(file) } catch { /* gone */ }
        continue
      }
      out.push({
        home, sid, record: record as PendingStart['record'], at: Number(e.at) || 0,
        ...(typeof e.opId === 'string' ? { opId: e.opId } : {}), ...(e.actor !== undefined ? { actor: e.actor } : {}),
      })
    }
    return out
  }

  return { setTemplate, templateOf, plan, precheck, begin, once, firstStart, holdPending, releasePending, pendingStarts }
}

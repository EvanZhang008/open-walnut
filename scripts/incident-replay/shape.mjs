/**
 * Shape-only incident replays: turn a real CLI stream file (Claude Code `-p --output-format
 * stream-json` stdout plus the daemon's own marker lines) into a fixture that keeps only the
 * SHAPE the session paths read (event order, types, control enums, tool names Walnut knows,
 * id correlations, counters) and none of the words.
 *
 * Pure, importing nothing but schema.mjs, on purpose: the mock CLI
 * (tests/providers/mock-claude-replay.mjs) loads this file under whatever runtime spawned it, so it
 * must not pull TypeScript sources. The one
 * production rule the converter needs (what an error result's words mean: a usage limit, a
 * retryable or a terminal error) is injected as `classifyText`; production.ts binds the real
 * detectors. Without it, only already-canonical texts survive and every other text becomes the
 * generic placeholder, which is exactly what validation needs.
 *
 * The rules, in one place:
 * - Allowlist, never denylist. Every event type, system subtype, key and enum value is listed in
 *   schema.mjs. A key that is not listed is dropped; a line whose type or subtype is not
 *   listed is dropped; an enum value that is not listed is dropped.
 * - Every free text becomes a fixed placeholder (empty stays empty, since "said nothing" is
 *   shape). A few prefixes the code branches on are kept as bare tags
 *   (`<local-command-stdout>`, `<task-notification>`, ...).
 * - Every id maps, through ONE map per file shared by every id field, to a synthetic id in
 *   first-seen order (uuid -> 00000000-0000-4000-8000-<n>, toolu_ -> toolu_synth<n>, ...), so
 *   uuid == command_uuid == walnutMessageId correlations and tool_use_id pairings survive.
 * - Tool names: Claude Code's built-in tools keep their names (Bash, AskUserQuestion, ...);
 *   every other name maps to mcp__synthetic__tool_<n>. Tool inputs keep only the fields the
 *   session paths read, with placeholder values (AskUserQuestion keeps its question/option
 *   structure). Models, agent types and MCP server names map the same way.
 * - Numbers survive only in listed numeric fields, finite and bounded. Process ids map to 10001+.
 * - A converted file is a fixpoint: converting it again yields the same bytes. validateStream
 *   checks that, plus an independent walk that rejects any string or key outside the allowed
 *   set, so a converter bug cannot leak a raw string into a fixture unnoticed.
 */

import {
  A,
  BUILTIN_AGENTS,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_SET,
  CONTROL_SUBTYPES,
  DECISION_REASON_TYPES,
  ERROR_TEXT,
  MAX_NUM,
  MODEL_USAGE_ENTRY,
  MCP_SOURCES,
  PERMISSION_SUGGESTION,
  PLACEHOLDER,
  RATE_LIMIT_INFO,
  RESULT_TEXTS,
  SCHEMAS,
  SYNTHETIC_MODEL,
  T,
  TOOL_INPUTS,
  TOOL_USE_RESULT,
  UNKNOWN_EVENT,
  UNKNOWN_SYSTEM,
  USAGE_LIMIT_TEXT,
  USER_TEXTS,
  canonicalOnlyClassifier,
  schemaFor,
  shapeUserString,
} from './schema.mjs'

export { PLACEHOLDER, USAGE_LIMIT_TEXT, ERROR_TEXT, BUILTIN_TOOLS, canonicalOnlyClassifier }

// ── Synthetic ids and names ──

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PATTERNS = [/^00000000-0000-4000-8000-\d{12}$/, /^(?:toolu|msg|req)_synth\d{6,}$/, /^synth_\d{6,}$/]
const NAME_PATTERNS = {
  tool: /^mcp__synthetic__tool_\d{1,6}$/,
  model: /^synthetic-model-\d{1,6}(?:\[1m\])?$/,
  agent: /^synthetic-agent-\d{1,6}$/,
  server: /^synthetic-server-\d{1,6}$/,
}
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ASK_QUESTION_RE = /^\(question \d{1,2}\)$/
const ASK_OPTION_RE = /^Option \d{1,2}$/
const PID_BASE = 10000
/** Timestamps move to this base, keeping their spacing: the first one in a file becomes it. */
const TS_BASE = Date.UTC(2026, 0, 1)
const TS_MAX = 253402300800000 // year 10000: toISOString keeps its four-digit form below it
const MAX_DEPTH = 64

const pad = (n, w) => String(n).padStart(w, '0')

function newCtx(classifyText) {
  return {
    ids: new Map(), idN: 0, pids: new Map(), tsShift: null,
    names: { tool: new Map(), model: new Map(), agent: new Map(), server: new Map() },
    classifyText, isError: false, errorReply: false,
    stats: { linesIn: 0, linesOut: 0, blank: 0, malformed: 0, unknownType: 0, skippedPartials: 0, droppedKeys: 0, droppedValues: 0, tornTail: false },
  }
}

function mapId(ctx, raw) {
  if (raw === '') return ''
  let out = ctx.ids.get(raw)
  if (out) return out
  const n = ++ctx.idN
  if (UUID_RE.test(raw)) out = `00000000-0000-4000-8000-${pad(n, 12)}`
  else if (raw.startsWith('toolu_')) out = `toolu_synth${pad(n, 6)}`
  else if (raw.startsWith('msg_')) out = `msg_synth${pad(n, 6)}`
  else if (raw.startsWith('req_')) out = `req_synth${pad(n, 6)}`
  else out = `synth_${pad(n, 6)}`
  ctx.ids.set(raw, out)
  return out
}

function mapName(ctx, space, raw) {
  if (space === 'tool' && BUILTIN_TOOL_SET.has(raw)) return raw
  if (space === 'agent' && BUILTIN_AGENTS.has(raw)) return raw
  if (space === 'model' && raw === SYNTHETIC_MODEL) return raw
  let base = raw
  let suffix = ''
  if (space === 'model' && raw.endsWith('[1m]')) { base = raw.slice(0, -4); suffix = '[1m]' }
  const map = ctx.names[space]
  let out = map.get(base)
  if (!out) {
    const n = map.size + 1
    out = space === 'tool' ? `mcp__synthetic__tool_${n}` : `synthetic-${space}-${n}`
    map.set(base, out)
  }
  return out + suffix
}

function nameAllowed(space, v) {
  if (space === 'tool' && BUILTIN_TOOL_SET.has(v)) return true
  if (space === 'agent' && BUILTIN_AGENTS.has(v)) return true
  if (space === 'model' && v === SYNTHETIC_MODEL) return true
  return NAME_PATTERNS[space].test(v)
}

// ── Convert ──

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const DROP = undefined

function textOf(v, ph) {
  if (typeof v !== 'string') return DROP
  return v.trim() ? ph : ''
}

function conv(spec, v, ctx) {
  switch (spec.k) {
    case 'enum':
      if (typeof v === 'string' && spec.values.includes(v)) return v
      ctx.stats.droppedValues++
      return typeof v === 'string' && spec.fallback !== undefined ? spec.fallback : DROP
    case 'id': return typeof v === 'string' ? mapId(ctx, v) : DROP
    case 'nullable': return v === null ? null : conv(spec.of, v, ctx)
    case 'pid': {
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return DROP
      let p = ctx.pids.get(v)
      if (!p) { p = PID_BASE + ctx.pids.size + 1; ctx.pids.set(v, p) }
      return p
    }
    case 'bool': return typeof v === 'boolean' ? v : DROP
    case 'num': return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= MAX_NUM ? v : DROP
    case 'iso': {
      if (typeof v !== 'string') return DROP
      const t = Date.parse(v)
      if (!Number.isFinite(t)) return DROP
      if (ctx.tsShift === null) ctx.tsShift = TS_BASE - t
      const shifted = t + ctx.tsShift
      return shifted >= 0 && shifted < TS_MAX ? new Date(shifted).toISOString() : DROP
    }
    case 'text': return textOf(v, spec.ph)
    case 'resultText': return typeof v === 'string' ? ctx.classifyText(v, ctx.isError) : DROP
    case 'userText': return typeof v === 'string' ? shapeUserString(v) : DROP
    case 'name': return typeof v === 'string' && v ? mapName(ctx, spec.space, v) : DROP
    case 'obj': {
      if (!isObj(v)) return DROP
      const out = {}
      for (const key of Object.keys(spec.f)) {
        if (!Object.prototype.hasOwnProperty.call(v, key)) continue
        const c = conv(spec.f[key], v[key], ctx)
        if (c !== DROP) out[key] = c
      }
      for (const key of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(spec.f, key)) ctx.stats.droppedKeys++
      return out
    }
    case 'arr': {
      if (!Array.isArray(v)) return DROP
      const out = []
      for (const item of v.slice(0, spec.max)) {
        const c = conv(spec.of, item, ctx)
        if (c !== DROP) out.push(c)
      }
      return out
    }
    case 'custom': return CUSTOM[spec.name].conv(v, ctx)
    default: throw new Error(`unknown spec kind ${spec.k}`)
  }
}

function toolInput(name, input, ctx) {
  if (!isObj(input)) return DROP
  const spec = BUILTIN_TOOL_SET.has(name) ? TOOL_INPUTS[name] : undefined
  if (!spec) { ctx.stats.droppedKeys += Object.keys(input).length; return {} }
  return conv(spec, input, ctx)
}

const TOOL_RESULT_BLOCK = {
  conv(b, ctx) {
    if (!isObj(b)) return DROP
    if (b.type === 'tool_reference' && typeof b.tool_name === 'string') return { type: 'tool_reference', tool_name: mapName(ctx, 'tool', b.tool_name) }
    if (b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: textOf(b.text, PLACEHOLDER.toolOutput) }
    return { type: 'text', text: PLACEHOLDER.toolOutput }
  },
}

/** Each custom spec: conv (raw -> shape) and the keys it may emit at any depth (for the key walk). */
const CUSTOM = {
  userContent: {
    conv(v, ctx) {
      if (typeof v === 'string') return shapeUserString(v)
      if (!Array.isArray(v)) return DROP
      const out = []
      for (const b of v.slice(0, 10000)) {
        if (!isObj(b)) continue
        if (b.type === 'tool_result') {
          const block = { type: 'tool_result' }
          if (typeof b.tool_use_id === 'string') block.tool_use_id = mapId(ctx, b.tool_use_id)
          if (typeof b.content === 'string') block.content = textOf(b.content, PLACEHOLDER.toolOutput)
          else if (Array.isArray(b.content)) block.content = b.content.slice(0, 1000).map((x) => TOOL_RESULT_BLOCK.conv(x, ctx)).filter((x) => x !== DROP)
          if (typeof b.is_error === 'boolean') block.is_error = b.is_error
          out.push(block)
        } else if (b.type === 'text' && typeof b.text === 'string') {
          out.push({ type: 'text', text: shapeUserString(b.text) })
        } else {
          // An image, a document, a block type this file does not know: still a real user block
          // (daemon-fold isRealUserLine counts any non-tool_result block), with no words.
          out.push({ type: 'text', text: PLACEHOLDER.user })
        }
      }
      return out
    },
    keys: ['type', 'tool_use_id', 'content', 'is_error', 'text', 'tool_name'],
  },
  assistantBlock: {
    conv(b, ctx) {
      if (!isObj(b)) return DROP
      if (b.type === 'text' && typeof b.text === 'string') {
        // Claude Code's own error reply (`error` on a <synthetic> message) is read by its words.
        return { type: 'text', text: ctx.errorReply ? ctx.classifyText(b.text, true) : textOf(b.text, PLACEHOLDER.text) }
      }
      // redacted_thinking reads as thinking to every reader (line-fate-core.ts skips both).
      if (b.type === 'thinking' || b.type === 'redacted_thinking') return { type: 'thinking', thinking: PLACEHOLDER.thinking, signature: '' }
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        const name = mapName(ctx, 'tool', b.name)
        const block = { type: 'tool_use' }
        if (typeof b.id === 'string') block.id = mapId(ctx, b.id)
        block.name = name
        const input = toolInput(name, b.input, ctx)
        if (input !== DROP) block.input = input
        return block
      }
      // A block this file does not know (server_tool_use, a future type): still output that
      // answers the turn (line-fate-core.ts counts any non-thinking block), with no words.
      ctx.stats.droppedValues++
      return { type: 'text', text: PLACEHOLDER.text }
    },
    keys: ['type', 'text', 'thinking', 'signature', 'id', 'name', 'input'],
  },
  streamBlock: {
    conv(b, ctx) {
      if (!isObj(b)) return DROP
      const type = ['text', 'thinking', 'tool_use'].includes(b.type) ? b.type : DROP
      if (!type) { ctx.stats.droppedValues++; return DROP }
      const block = { type }
      if (type === 'text') block.text = ''
      if (type === 'thinking') { block.thinking = ''; block.signature = '' }
      if (type === 'tool_use') {
        if (typeof b.id === 'string') block.id = mapId(ctx, b.id)
        if (typeof b.name === 'string') block.name = mapName(ctx, 'tool', b.name)
        block.input = {}
      }
      return block
    },
    keys: ['type', 'text', 'thinking', 'signature', 'id', 'name', 'input'],
  },
  askUserQuestion: {
    conv(input, ctx) {
      if (!isObj(input)) return DROP
      const out = {}
      if (Array.isArray(input.questions)) {
        out.questions = input.questions.slice(0, 99).filter(isObj).map((q, i) => {
          const shaped = {}
          if (typeof q.question === 'string') shaped.question = `(question ${i + 1})`
          if (typeof q.header === 'string') shaped.header = textOf(q.header, PLACEHOLDER.header)
          if (Array.isArray(q.options)) {
            shaped.options = q.options.slice(0, 99).filter(isObj).map((o, j) => {
              const opt = {}
              if (typeof o.label === 'string') opt.label = `Option ${j + 1}`
              if (typeof o.description === 'string') opt.description = textOf(o.description, PLACEHOLDER.optionDescription)
              return opt
            })
          }
          if (typeof q.multiSelect === 'boolean') shaped.multiSelect = q.multiSelect
          return shaped
        })
      }
      for (const key of Object.keys(input)) if (key !== 'questions') ctx.stats.droppedKeys++
      return out
    },
    keys: ['questions', 'question', 'header', 'options', 'label', 'description', 'multiSelect'],
  },
  controlRequest: {
    conv(r, ctx) {
      if (!isObj(r)) return DROP
      const out = {}
      if (r.subtype !== undefined) {
        const sub = conv(CONTROL_SUBTYPES, r.subtype, ctx)
        if (sub !== DROP) out.subtype = sub
      }
      let tool
      if (typeof r.tool_name === 'string' && r.tool_name) out.tool_name = tool = mapName(ctx, 'tool', r.tool_name)
      if (typeof r.display_name === 'string' && r.display_name) out.display_name = mapName(ctx, 'tool', r.display_name)
      if (tool !== undefined) { const input = toolInput(tool, r.input, ctx); if (input !== DROP) out.input = input }
      if (typeof r.tool_use_id === 'string') out.tool_use_id = mapId(ctx, r.tool_use_id)
      if (typeof r.requires_user_interaction === 'boolean') out.requires_user_interaction = r.requires_user_interaction
      if (typeof r.description === 'string') out.description = textOf(r.description, PLACEHOLDER.description)
      if (Array.isArray(r.permission_suggestions)) out.permission_suggestions = conv(A(PERMISSION_SUGGESTION, 100), r.permission_suggestions, ctx)
      if (typeof r.decision_reason === 'string') out.decision_reason = textOf(r.decision_reason, PLACEHOLDER.reason)
      if (r.decision_reason_type !== undefined) {
        const drt = conv(DECISION_REASON_TYPES, r.decision_reason_type, ctx)
        if (drt !== DROP) out.decision_reason_type = drt
      }
      if (typeof r.blocked_path === 'string') out.blocked_path = textOf(r.blocked_path, PLACEHOLDER.path)
      if (typeof r.classifier_approvable === 'boolean') out.classifier_approvable = r.classifier_approvable
      if (isObj(r.mcp_server)) {
        const s = {}
        if (typeof r.mcp_server.name === 'string' && r.mcp_server.name) s.name = mapName(ctx, 'server', r.mcp_server.name)
        if (r.mcp_server.source !== undefined) {
          const src = conv(MCP_SOURCES, r.mcp_server.source, ctx)
          if (src !== DROP) s.source = src
        }
        out.mcp_server = s
      }
      return out
    },
    keys: ['subtype', 'tool_name', 'display_name', 'input', 'tool_use_id', 'requires_user_interaction', 'description',
      'permission_suggestions', 'decision_reason', 'decision_reason_type', 'blocked_path', 'classifier_approvable', 'mcp_server',
      'name', 'source'],
  },
  permissionDenial: {
    conv(d, ctx) {
      if (!isObj(d)) return DROP
      const out = {}
      let tool
      if (typeof d.tool_name === 'string' && d.tool_name) out.tool_name = tool = mapName(ctx, 'tool', d.tool_name)
      if (typeof d.tool_use_id === 'string') out.tool_use_id = mapId(ctx, d.tool_use_id)
      if (tool !== undefined) { const input = toolInput(tool, d.tool_input, ctx); if (input !== DROP) out.tool_input = input }
      return out
    },
    keys: ['tool_name', 'tool_use_id', 'tool_input'],
  },
  toolUseResult: {
    // What the fold reads off a user line: ScheduleWakeup's scheduledFor, CronCreate's job id.
    conv(v, ctx) {
      if (typeof v === 'string') return textOf(v, PLACEHOLDER.toolOutput)
      return conv(TOOL_USE_RESULT, v, ctx)
    },
    check(v, parts, errs, line) {
      if (typeof v === 'string') { if (v !== '' && v !== PLACEHOLDER.toolOutput) errs.push({ line, path: maskPath(parts), reason: 'value is not a canonical text' }) }
      else walkSchema(TOOL_USE_RESULT, v, parts, errs, line)
    },
  },
  modelUsage: {
    conv(v, ctx) {
      if (!isObj(v)) return DROP
      const out = {}
      for (const [model, u] of Object.entries(v).slice(0, 50)) {
        const shaped = conv(MODEL_USAGE_ENTRY, u, ctx)
        if (shaped !== DROP && model) out[mapName(ctx, 'model', model)] = shaped
      }
      return out
    },
    check(v, parts, errs, line) {
      if (!isObj(v)) { errs.push({ line, path: maskPath(parts), reason: 'expected an object' }); return }
      for (const [model, u] of Object.entries(v)) {
        if (!nameAllowed('model', model)) errs.push({ line, path: maskPath([...parts, model]), reason: 'key not in the schema here' })
        walkSchema(MODEL_USAGE_ENTRY, u, [...parts, model], errs, line)
      }
    },
  },
}

/** Keys an obj spec may emit at any depth. */
function specKeys(spec, into = new Set()) {
  if (spec.k === 'nullable' || spec.k === 'arr') specKeys(spec.of, into)
  else if (spec.k === 'obj') for (const [key, s] of Object.entries(spec.f)) { into.add(key); specKeys(s, into) }
  return into
}
const TOOL_INPUT_KEYS = new Set(CUSTOM.askUserQuestion.keys)
for (const s of Object.values(TOOL_INPUTS)) specKeys(s, TOOL_INPUT_KEYS)
CUSTOM.assistantBlock.keys.push(...TOOL_INPUT_KEYS)
CUSTOM.permissionDenial.keys.push(...TOOL_INPUT_KEYS)
CUSTOM.controlRequest.keys.push(...TOOL_INPUT_KEYS, ...specKeys(PERMISSION_SUGGESTION))

/**
 * @typedef {{ linesIn: number, linesOut: number, blank: number, malformed: number, unknownType: number,
 *   skippedPartials: number, droppedKeys: number, droppedValues: number, tornTail: boolean,
 *   ids: number, pids: number }} ConvertReport  Counts only, never names or values.
 * @typedef {(text: string, isError: boolean) => string} ClassifyText
 * @typedef {{ classifyText?: ClassifyText, skipPartials?: boolean }} ConvertOptions
 */

/**
 * An incremental converter: one id map for every line fed to it.
 * @param {ConvertOptions} [opts]
 */
export function createStreamConverter(opts = {}) {
  const ctx = newCtx(opts.classifyText ?? canonicalOnlyClassifier)
  return {
    /**
     * One raw line (no newline) -> its shape-only line, or null for a blank line (and a
     * stream_event under skipPartials). A line that is not JSON, or of a type or system subtype
     * the schema does not list, becomes a stand-in line with no words (UNKNOWN_EVENT /
     * UNKNOWN_SYSTEM). @param {string} raw
     */
    line(raw) {
      ctx.stats.linesIn++
      if (!raw.trim()) { ctx.stats.blank++; return null }
      let o
      try { o = JSON.parse(raw) } catch { o = undefined }
      if (!isObj(o)) { ctx.stats.malformed++; ctx.stats.linesOut++; return UNKNOWN_EVENT }
      const spec = schemaFor(o)
      if (!spec) { ctx.stats.unknownType++; ctx.stats.linesOut++; return o.type === 'system' ? UNKNOWN_SYSTEM : UNKNOWN_EVENT }
      if (opts.skipPartials && o.type === 'stream_event') { ctx.stats.skippedPartials++; return null }
      ctx.isError = o.type === 'result' && o.is_error === true
      // Claude Code's own error reply, by the production rule (cli-error-reply.ts isCliErrorReply).
      ctx.errorReply = o.type === 'assistant' && (o.isApiErrorMessage === true
        || (typeof o.error === 'string' && isObj(o.message) && o.message.model === SYNTHETIC_MODEL))
      const out = conv(spec, o, ctx)
      ctx.stats.linesOut++
      return JSON.stringify(out)
    },
    /** The synthetic id a raw id became, or undefined (for parity checks; never printed). @param {string} raw */
    lookupId(raw) { return ctx.ids.get(raw) },
    /** The synthetic pid a raw pid became, or undefined. @param {number} raw */
    lookupPid(raw) { return ctx.pids.get(raw) },
    /** @param {boolean} torn */
    markTornTail(torn) { ctx.stats.tornTail = torn },
    /** @returns {ConvertReport} */
    report() { return { ...ctx.stats, ids: ctx.ids.size, pids: ctx.pids.size } },
  }
}

/**
 * A whole raw stream -> shape-only JSONL (every line newline-terminated). Deterministic, and a
 * fixpoint on its own output.
 * @param {string} content
 * @param {ConvertOptions} [opts]
 * @returns {{ content: string, report: ConvertReport }}
 */
export function convertStream(content, opts = {}) {
  const conv = createStreamConverter(opts)
  const parts = content.split('\n')
  const torn = parts.length > 0 && parts[parts.length - 1] !== ''
  if (!torn) parts.pop()
  const out = []
  parts.forEach((raw, i) => {
    // A torn last line (the writer died mid-line) is dropped: what it would have said is unknowable.
    if (torn && i === parts.length - 1 && !isJsonObject(raw)) { conv.markTornTail(true); return }
    const line = conv.line(raw)
    if (line !== null) out.push(line)
  })
  return { content: out.length ? out.join('\n') + '\n' : '', report: conv.report() }
}

function isJsonObject(raw) {
  try { return isObj(JSON.parse(raw)) } catch { return false }
}

/**
 * Stream text -> canonical shape-only text with only canonical texts kept (no production
 * classifier). For RAW input use production.ts toShapeOnly, which keeps the error classes.
 */
export function toCanonicalShape(content, opts = {}) {
  return convertStream(content, opts).content
}

// ── Validate ──

const STATIC_STRINGS = new Set([
  ...Object.values(PLACEHOLDER), ...RESULT_TEXTS, ...USER_TEXTS, ...BUILTIN_TOOLS, ...BUILTIN_AGENTS, SYNTHETIC_MODEL,
  ...Object.keys(TOOL_INPUTS),
])
function collectStatic(spec) {
  if (spec.k === 'enum') for (const v of spec.values) STATIC_STRINGS.add(v)
  else if (spec.k === 'nullable') collectStatic(spec.of)
  else if (spec.k === 'arr') collectStatic(spec.of)
  else if (spec.k === 'obj') for (const [key, s] of Object.entries(spec.f)) { STATIC_STRINGS.add(key); collectStatic(s) }
}
for (const s of Object.values(SCHEMAS)) collectStatic(s)
for (const s of Object.values(TOOL_INPUTS)) collectStatic(s)
collectStatic(PERMISSION_SUGGESTION)
collectStatic(RATE_LIMIT_INFO)
for (const c of Object.values(CUSTOM)) for (const k of c.keys ?? []) STATIC_STRINGS.add(k)
collectStatic(TOOL_USE_RESULT)
collectStatic(MODEL_USAGE_ENTRY)
collectStatic(CONTROL_SUBTYPES)
collectStatic(DECISION_REASON_TYPES)
collectStatic(MCP_SOURCES)
for (const v of ['text', 'thinking', 'tool_use', 'tool_result', 'tool_reference']) STATIC_STRINGS.add(v)

/** Is this string (a value or a key) one a shape-only fixture may hold? Independent of conv. @param {string} s */
export function isAllowedShapeString(s) {
  if (STATIC_STRINGS.has(s)) return true
  if (ID_PATTERNS.some((re) => re.test(s))) return true
  if (Object.values(NAME_PATTERNS).some((re) => re.test(s))) return true
  if (ASK_QUESTION_RE.test(s) || ASK_OPTION_RE.test(s)) return true
  return ISO_RE.test(s) && new Date(Date.parse(s)).toISOString() === s
}

/** Belt over the allowlist: shapes that are private whatever the schema says, named without their text. */
const PRIVATE_SHAPES = [
  ['home path', /(?:^|[^A-Za-z0-9])\/(?:Users|home|local\/home|root|private\/var|var\/folders)\//],
  ['windows path', /[A-Za-z]:\\\\/],
  ['email', /[A-Za-z0-9._%+-]@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ['url', /\bhttps?:\/\//i],
  ['key-like token', /\b(?:sk|pk|ghp|gho|xox[abp]|AKIA|ASIA)[-_]?[A-Za-z0-9]{12,}/],
]

const DEFAULT_LIMITS = { maxBytes: 4 * 1024 * 1024, maxLineBytes: 64 * 1024, maxLines: 50000 }

function maskPath(parts) {
  return parts.map((p) => typeof p === 'number' ? `[${p}]` : isAllowedShapeString(p) ? `.${p}` : '.<key>').join('') || '<line>'
}

function walkStrings(v, parts, errs, line) {
  if (parts.length > MAX_DEPTH) { errs.push({ line, path: '<line>', reason: `nested deeper than ${MAX_DEPTH}` }); return }
  if (typeof v === 'string') {
    if (!isAllowedShapeString(v)) errs.push({ line, path: maskPath(parts), reason: 'string outside the shape-only set' })
  } else if (typeof v === 'number') {
    if (!Number.isFinite(v) || Math.abs(v) > MAX_NUM) errs.push({ line, path: maskPath(parts), reason: 'number out of range' })
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => walkStrings(x, [...parts, i], errs, line))
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (!isAllowedShapeString(k)) errs.push({ line, path: maskPath([...parts, k]), reason: 'key outside the shape-only set' })
      walkStrings(x, [...parts, k], errs, line)
    }
  }
}

/** Schema walk: keys must be the ones this position allows (readable paths; the fixpoint is the final word). */
function walkSchema(spec, v, parts, errs, line) {
  if (parts.length > MAX_DEPTH) return // walkStrings reports it
  if (spec.k === 'nullable') { if (v !== null) walkSchema(spec.of, v, parts, errs, line); return }
  if (spec.k === 'arr') {
    if (!Array.isArray(v)) { errs.push({ line, path: maskPath(parts), reason: 'expected an array' }); return }
    v.forEach((x, i) => walkSchema(spec.of, x, [...parts, i], errs, line))
    return
  }
  if (spec.k === 'obj') {
    if (!isObj(v)) { errs.push({ line, path: maskPath(parts), reason: 'expected an object' }); return }
    for (const [k, x] of Object.entries(v)) {
      if (!Object.prototype.hasOwnProperty.call(spec.f, k)) errs.push({ line, path: maskPath([...parts, k]), reason: 'key not in the schema here' })
      else walkSchema(spec.f[k], x, [...parts, k], errs, line)
    }
    return
  }
  if (spec.k === 'custom') {
    const c = CUSTOM[spec.name]
    if (c.check) { c.check(v, parts, errs, line); return }
    // Keys only: the values of these subtrees are held by the string walk and the fixpoint.
    const allowed = new Set(c.keys)
    const walk = (x, p) => {
      if (p.length > MAX_DEPTH) return
      if (Array.isArray(x)) x.forEach((y, i) => walk(y, [...p, i]))
      else if (isObj(x)) for (const [k, y] of Object.entries(x)) {
        if (!allowed.has(k)) errs.push({ line, path: maskPath([...p, k]), reason: 'key not in the schema here' })
        walk(y, [...p, k])
      }
    }
    walk(v, parts)
    return
  }
  const ok = spec.k === 'enum' ? spec.values.includes(v)
    : spec.k === 'id' ? typeof v === 'string' && (v === '' || ID_PATTERNS.some((re) => re.test(v)))
      : spec.k === 'pid' ? Number.isInteger(v) && v > PID_BASE && v <= MAX_NUM
        : spec.k === 'bool' ? typeof v === 'boolean'
          : spec.k === 'num' ? typeof v === 'number' && v >= spec.min && v <= MAX_NUM
            : spec.k === 'iso' ? typeof v === 'string' && ISO_RE.test(v)
              : spec.k === 'text' ? v === '' || v === spec.ph
                : spec.k === 'resultText' ? RESULT_TEXTS.has(v)
                  : spec.k === 'userText' ? USER_TEXTS.has(v)
                    : spec.k === 'name' ? typeof v === 'string' && nameAllowed(spec.space, v)
                      : false
  if (!ok) errs.push({ line, path: maskPath(parts), reason: `value is not a canonical ${spec.k}` })
}

/**
 * Is this text a shape-only fixture? Strict: every line must parse to a listed event, every key
 * and string must be in the shape-only set, numbers in range, and converting the text again must
 * give the same bytes (a raw string, a duplicate JSON key, an escape trick or a non-canonical id
 * order all fail that). Errors carry a line number, a path whose unknown keys are masked, and a
 * reason: never the offending text.
 * @param {string} content
 * @param {Partial<typeof DEFAULT_LIMITS>} [limits]
 * @returns {{ ok: boolean, errors: { line: number, path: string, reason: string }[] }}
 */
export function validateStream(content, limits = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  const errors = []
  if (typeof content !== 'string') return { ok: false, errors: [{ line: 0, path: '<file>', reason: 'not text' }] }
  const bytes = new TextEncoder().encode(content).length
  if (bytes > lim.maxBytes) errors.push({ line: 0, path: '<file>', reason: `file over ${lim.maxBytes} bytes` })
  if (content === '') errors.push({ line: 0, path: '<file>', reason: 'empty file' })
  else if (!content.endsWith('\n')) errors.push({ line: 0, path: '<file>', reason: 'missing final newline' })
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length > lim.maxLines) errors.push({ line: 0, path: '<file>', reason: `over ${lim.maxLines} lines` })
  lines.forEach((raw, i) => {
    const line = i + 1
    if (new TextEncoder().encode(raw).length > lim.maxLineBytes) { errors.push({ line, path: '<line>', reason: `line over ${lim.maxLineBytes} bytes` }); return }
    for (const [label, re] of PRIVATE_SHAPES) if (re.test(raw)) errors.push({ line, path: '<line>', reason: `looks like a ${label}` })
    let o
    try { o = JSON.parse(raw) } catch { errors.push({ line, path: '<line>', reason: 'not JSON' }); return }
    if (!isObj(o)) { errors.push({ line, path: '<line>', reason: 'not a JSON object' }); return }
    walkStrings(o, [], errors, line)
    const spec = schemaFor(o)
    if (!spec) { errors.push({ line, path: '.type', reason: 'event type not in the schema' }); return }
    walkSchema(spec, o, [], errors, line)
  })
  const again = convertStream(content).content
  if (again !== content) {
    const a = again.split('\n')
    const idx = lines.findIndex((l, i) => l !== a[i])
    errors.push({ line: idx === -1 ? lines.length + 1 : idx + 1, path: '<line>', reason: 'not canonical: converting again changes this line' })
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Throw unless `content` is a shape-only fixture. The message lists at most 10 problems, by line,
 * masked path and reason, never the text.
 * @param {string} content
 * @param {string} [label]
 */
export function assertShapeOnly(content, label = 'stream') {
  const { ok, errors } = validateStream(content)
  if (ok) return
  const head = errors.slice(0, 10).map((e) => `  line ${e.line} ${e.path}: ${e.reason}`).join('\n')
  throw new Error(`${label} is not a shape-only replay (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n${head}`)
}

/**
 * Fixtures whose shape-only content is byte-identical (the canonical id map makes two recordings
 * of the same shape equal). @param {{ name: string, content: string }[]} fixtures
 * @returns {string[][]} groups of names, each with two or more members
 */
export function findDuplicateFixtures(fixtures) {
  const byContent = new Map()
  for (const f of fixtures) byContent.set(f.content, [...(byContent.get(f.content) ?? []), f.name])
  return [...byContent.values()].filter((g) => g.length > 1)
}

// ── Synthetic variants ──

/**
 * The usage-limit variant of a shape-only stream, in the order the CLI writes a blocked turn:
 * before its LAST result, the rejected rate_limit_event, then Claude Code's own error reply (a
 * `<synthetic>` assistant message with `error: 'rate_limit'`, `isApiErrorMessage`, the blocked
 * limit in `api_error_params` and the canonical limit text); the result itself becomes the
 * usage-limit stop (is_error, the same text). Earlier model output is kept as it is. Returns
 * canonical shape-only text.
 * @param {string} shapeContent
 * @param {{ window?: keyof typeof USAGE_LIMIT_TEXT, resetsAt?: number }} [opts]
 */
export function usageLimitVariant(shapeContent, opts = {}) {
  const window = opts.window ?? 'five_hour'
  if (!Object.prototype.hasOwnProperty.call(USAGE_LIMIT_TEXT, window)) throw new Error('unknown usage-limit window')
  const text = USAGE_LIMIT_TEXT[window]
  const lines = shapeContent.split('\n').filter((l) => l !== '')
  let at = -1
  lines.forEach((l, i) => { if (JSON.parse(l).type === 'result') at = i })
  if (at === -1) throw new Error('stream has no result line to turn into a usage-limit stop')
  const result = JSON.parse(lines[at])
  result.is_error = true
  result.result = text
  delete result.terminal_reason
  const sid = result.session_id ? { session_id: result.session_id } : {}
  const info = { status: 'rejected', ...(window !== 'unknown' ? { rateLimitType: window } : {}), resetsAt: opts.resetsAt ?? 1893456000, overageStatus: 'rejected', isUsingOverage: false }
  const event = { type: 'rate_limit_event', rate_limit_info: info, ...sid }
  const reply = {
    type: 'assistant',
    message: { id: 'msg_usage_limit_reply', type: 'message', role: 'assistant', model: SYNTHETIC_MODEL, content: [{ type: 'text', text }], stop_reason: 'stop_sequence' },
    parent_tool_use_id: null, ...sid, error: 'rate_limit', isApiErrorMessage: true, api_error_params: { rate_limit_info: info },
  }
  lines.splice(at, 1, JSON.stringify(event), JSON.stringify(reply), JSON.stringify(result))
  return convertStream(lines.join('\n') + '\n').content
}

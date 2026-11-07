/**
 * Context% denominator resolution + model-id shortening — pure, so the rules
 * are testable without a live CLI.
 *
 * WHY THIS EXISTS (incident inc-1787517631989-wpy5i3, 2026-08-23): the badge
 * percentage for a custom proxy model (GPT-5.6 Sol served through the local
 * Bedrock proxy) swung 70% → 25% → 10% inside one session, and disagreed with
 * the picker's own "Context — 99.4K / 400K (25%)" panel at the same moment.
 * Nothing about the numerator was wrong; the DENOMINATOR was being discovered
 * in three stages, each 2.5-5x apart, and rendered at every stage:
 *
 *   1. spawn            → 200K string guess (a custom model carries no `[1m]`
 *                         marker, so the Anthropic-shaped guess applied)
 *   2. +1.5-5s          → get_context_usage.maxTokens = 400K
 *   3. +first turn-end  → result.modelUsage[model].contextWindow = 1M
 *
 * Anthropic models hid the bug: the user runs `[1m]` variants, so stage 1
 * already guessed 1M and stages 2-3 barely moved the number.
 *
 * THE DENOMINATOR IS THE MODEL'S ABSOLUTE MAX WINDOW. Not the auto-compact
 * window. The badge answers "how much of this model am I using", which is a
 * property of the model, so it must not move when a session-level or env-level
 * compaction setting moves. The compaction threshold is a SEPARATE fact and is
 * rendered separately ("auto-compacts at 400K") instead of being folded into the
 * percentage where it silently redefines what the number means.
 *
 * Where the absolute max can be learned, in order of authority. Only the first
 * two are exact; the CLI does not expose a raw window anywhere else:
 *
 *   1. `result.modelUsage[<model>].contextWindow` (turn end). The CLI's own
 *      resolved model window: verified 2.1.240 reporting 1000000 for
 *      gpt-5.6-sol, claude-opus-5[1m] and claude-fable-5[1m].
 *   2. The same value cached per host+model, so the SECOND session on a model
 *      starts already knowing it (see rememberModelWindow).
 *   3. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, but ONLY for a model the CLI does not
 *      recognize. That is the CLI's own rule, and its own words: for an
 *      unrecognized model it prints "…is not a model this version of Claude Code
 *      recognizes… To make it recognized, append [1m] to the model name for 1M,
 *      or set CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window". Recognized
 *      claude-* models ignore the variable, so trusting it there would invent a
 *      1M window for a 200K model.
 *   4. The model string: `[1m]` → 1M, a recognized Anthropic family → 200K.
 *
 * 2026-11-07 (the user: "find the actual model context window for the current model ... not by
 * string matching which is flaky"): every answer now says whether it is the CLI's own number or an
 * estimate (`estimate`), the host+model cache is kept on disk (src/providers/model-window-store.ts),
 * so a restart no longer sends every session back to the name rule until its first turn ends, and
 * `get_context_usage.maxTokens` counts as exact when the CLI says nothing clamped it
 * (`autocompactSource` "auto" or "unknown-model", read from CLI 2.1.312's resolver). The name rule
 * is the last resort, and every surface shows a window from it as an estimate.
 *
 * `get_context_usage.maxTokens` is NOT in that list while a setting clamps it. In 2.1.240 the
 * payload is built as `{maxTokens: g, rawMaxTokens: g, autocompactSource: y}` —
 * the same variable twice, already clamped — so it reveals the effective window
 * and nothing about the model's real one.
 *
 * Second rule: never render a percent from a guess with no basis. An
 * unrecognized model with no CLI reading yet yields NO window, and the caller
 * shows the token count alone rather than a 200K Anthropic-shaped guess that is
 * 5x wrong for a 1M proxy model.
 */

import { MODEL_CATALOG } from '../model/providers/model-catalog.js'

/** Window assumed for an Anthropic model with no `[1m]` marker. */
export const ANTHROPIC_DEFAULT_WINDOW = 200_000
export const EXTENDED_WINDOW = 1_000_000

/** Where the resolved denominator came from — carried to the UI for the tooltip
 *  and logged, so a wrong percentage is diagnosable without a repro. */
export type ContextWindowSource =
  | 'cli-model-usage' // result.modelUsage[model].contextWindow — exact
  | 'host-model-cache' // an exact value learned from an earlier session (kept on disk)
  | 'cli-context-usage' // get_context_usage.maxTokens with nothing clamping it — exact
  | 'engine' // an ACP engine's own context size — exact
  | 'env-max-tokens' // CLAUDE_CODE_MAX_CONTEXT_TOKENS (unrecognized models only)
  | 'model-string' // `[1m]` marker / known Anthropic family
  | 'record' // the window an earlier run of this session wrote, not known to be the CLI's own
  | 'floor' // lifted to what the session already shows it holds (see ContextWindowInputs.effectiveWindow)

export interface ContextWindowInputs {
  /** result.modelUsage[model].contextWindow — the CLI's resolved model window
   *  for THIS session. Exact; prefer it over everything. */
  cliModelWindow?: number | undefined
  /** Same value learned earlier for this host+model (rememberModelWindow). */
  hostModelWindow?: number | undefined
  /** The window an earlier run of this session wrote on its record when nobody knew whether it
   *  was the CLI's own (an older Walnut wrote its 200K guess there too, 2026-11-06). A hint
   *  only: it ranks after the host cache and is lifted by the floor like every other one. */
  recordWindow?: number | undefined
  /** get_context_usage.maxTokens when its `autocompactSource` says no setting clamped it ("auto",
   *  "unknown-model"): then it IS the model's window, before any turn has ended. */
  cliUnclampedWindow?: number | undefined
  /** get_context_usage.maxTokens: the CLI's EFFECTIVE window, min(model window, auto-compact
   *  clamp). Never the denominator, but a floor under it: the model's window cannot be smaller. */
  effectiveWindow?: number | undefined
  /** CLAUDE_CODE_MAX_CONTEXT_TOKENS as the CLI reports it (get_settings
   *  effective.env). Applies to unrecognized models only — see the header. */
  envMaxContextTokens?: number | undefined
  /** Full model string from init / get_settings.applied. */
  model?: string | undefined
  /** input + cache_creation + cache_read of the latest call. A floor too: a session cannot
   *  hold more than its window. */
  observedTokens?: number | undefined
}

export interface ResolvedContextWindow {
  window: number
  source: ContextWindowSource
  /** Not a number the CLI or the engine gave: a name rule, a stored hint or a floor. Every surface
   *  shows such a window as an estimate. */
  estimate: boolean
}

/** The sources that are a number the CLI or the engine reported for this model. */
const EXACT_SOURCES: ReadonlySet<ContextWindowSource> = new Set(['cli-model-usage', 'host-model-cache', 'cli-context-usage', 'engine'])

/** A window from this source is the CLI's (or the engine's) own number, not an estimate. */
export function isExactWindowSource(source: ContextWindowSource | string | undefined): boolean {
  return !!source && EXACT_SOURCES.has(source as ContextWindowSource)
}

const resolved = (window: number, source: ContextWindowSource): ResolvedContextWindow =>
  ({ window, source, estimate: !EXACT_SOURCES.has(source) })

const positive = (n: number | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined

/** Does the CLI recognize this as one of its own models? Only those ignore
 *  CLAUDE_CODE_MAX_CONTEXT_TOKENS and carry an inferable window. */
export function isRecognizedClaudeModel(model: string | undefined): boolean {
  if (!model) return false
  const lower = shortModelId(model).toLowerCase()
  return /claude/.test(lower) || /\b(opus|sonnet|haiku|fable)\b/.test(lower)
}

/** Anthropic model ids are the only ones whose window we can infer from the
 *  string (the `[1m]` marker is a client-side opt-in the CLI honours; plain
 *  ids get the 200K default). Everything else — custom proxy models, OpenAI
 *  ids, anything routed through ANTHROPIC_CUSTOM_MODEL_OPTION — is unknowable
 *  and must come from the CLI. */
function windowFromModelString(model: string | undefined): number | undefined {
  if (!model) return undefined
  if (model.toLowerCase().includes('[1m]')) return EXTENDED_WINDOW
  if (!isRecognizedClaudeModel(model)) return undefined
  return hasNativeExtendedWindow(model) ? EXTENDED_WINDOW : ANTHROPIC_DEFAULT_WINDOW
}

/** The Claude ids Walnut's model catalog marks as 1M with no `[1m]` (Opus 5 and 5.5, Sonnet 5.5,
 *  Haiku 5.5: `compat.native_1m`), by their short form. */
let nativeExtended: Set<string> | undefined

/** A Claude model whose window is 1M with no `[1m]` in its id, as the catalog knows it. */
export function hasNativeExtendedWindow(model: string): boolean {
  nativeExtended ??= new Set(
    [...MODEL_CATALOG.bedrock ?? [], ...MODEL_CATALOG.anthropic ?? []]
      .filter((m) => m.compat?.native_1m)
      .map((m) => shortModelId(m.id).toLowerCase()),
  )
  return nativeExtended.has(shortModelId(model).toLowerCase().replace(/\[1m\]$/, ''))
}

/**
 * The window a model's NAME suggests: `[1m]` or a model with 1M built in reads 1M, any other Claude
 * id 200K, anything else nothing. An estimate, never the model's own number: the last resort of
 * resolveContextWindow and knownModelWindow, and of the web's twin for a page with no reading. Any
 * other caller is refused by tests/core/context-window-name-rule-guard.test.ts.
 */
export function modelNameWindowEstimate(model: string | undefined): number | undefined {
  return windowFromModelString(model)
}

/**
 * Resolve the context% denominator (the model's absolute max window), or null
 * when nothing available justifies a percentage — the caller then shows the
 * token count alone.
 *
 * Every answer but the session's own reading is lifted to the floor: what the session already
 * holds (its tokens) and what the CLI said it may hold (its effective window). A model string
 * names no window for a model with 1M built in (Opus 5.5 is 1M as `claude-opus-5-5`, with no
 * `[1m]`: the CLI decides from its served catalog), so the 200K guess read 324K / 200K (162%) on
 * a session whose CLI had reported a 500K effective window at its start (2026-11-06). An
 * Anthropic model's window is 200K or 1M, so one lifted past 200K is 1M; any other model is
 * lifted to the floor itself.
 */
export function resolveContextWindow(inputs: ContextWindowInputs): ResolvedContextWindow | null {
  const own = positive(inputs.cliModelWindow)
  if (own !== undefined) return resolved(own, 'cli-model-usage')

  const floor = Math.max(positive(inputs.observedTokens) ?? 0, positive(inputs.effectiveWindow) ?? 0)
  const lifted = (r: ResolvedContextWindow): ResolvedContextWindow => {
    if (r.window >= floor) return r
    const anthropic = isRecognizedClaudeModel(inputs.model) || /\[1m\]/i.test(inputs.model ?? '')
    return resolved(anthropic ? Math.max(EXTENDED_WINDOW, floor) : floor, 'floor')
  }

  const unclamped = positive(inputs.cliUnclampedWindow)
  if (unclamped !== undefined) return lifted(resolved(unclamped, 'cli-context-usage'))

  const cached = positive(inputs.hostModelWindow)
  if (cached !== undefined) return lifted(resolved(cached, 'host-model-cache'))

  const recorded = positive(inputs.recordWindow)
  if (recorded !== undefined) return lifted(resolved(recorded, 'record'))

  // The CLI applies this variable to models it does not recognize, and ignores
  // it for its own — mirror that exactly rather than trusting it everywhere.
  const envMax = positive(inputs.envMaxContextTokens)
  if (envMax !== undefined && !isRecognizedClaudeModel(inputs.model)) {
    return lifted(resolved(envMax, 'env-max-tokens'))
  }

  const guess = windowFromModelString(inputs.model)
  if (guess !== undefined) return lifted(resolved(guess, 'model-string'))

  return null
}

const hostKey = (host: string | null | undefined): string => host ?? '__local__'

/**
 * Last-seen auto-compact clamp per exec host.
 *
 * No longer a denominator (see the header) but still shown to the user, and
 * still worth sharing: CLAUDE_CODE_AUTO_COMPACT_WINDOW is a property of the
 * HOST's settings/env, not of one CLI process, so the first session to read it
 * can answer for every other session on that host.
 */
const autoCompactByHost = new Map<string, number>()

export function rememberAutoCompactWindow(host: string | null | undefined, window: number): void {
  if (Number.isFinite(window) && window > 0) autoCompactByHost.set(hostKey(host), window)
}

export function recallAutoCompactWindow(host: string | null | undefined): number | undefined {
  return autoCompactByHost.get(hostKey(host))
}

/**
 * Last-seen "auto-compact is off" per exec host (the CLI's own `isAutoCompactEnabled` in its
 * get_context_usage answer). A setting of the host, so one session's read answers for the others
 * until their own read lands; a project file can still override it per session.
 */
const autoCompactOffByHost = new Map<string, boolean>()

export function rememberAutoCompactOff(host: string | null | undefined, off: boolean): void {
  autoCompactOffByHost.set(hostKey(host), off)
}

export function recallAutoCompactOff(host: string | null | undefined): boolean | undefined {
  return autoCompactOffByHost.get(hostKey(host))
}

/**
 * Last-seen CLAUDE_CODE_MAX_CONTEXT_TOKENS per exec host. Same reasoning as the
 * clamp cache: it is a host env value, so one session's read answers for all.
 */
const envMaxTokensByHost = new Map<string, number>()

export function rememberEnvMaxContextTokens(host: string | null | undefined, tokens: number): void {
  if (Number.isFinite(tokens) && tokens > 0) envMaxTokensByHost.set(hostKey(host), tokens)
}

export function recallEnvMaxContextTokens(host: string | null | undefined): number | undefined {
  return envMaxTokensByHost.get(hostKey(host))
}

/**
 * Absolute max window per host+model, learned from `result.modelUsage` (or an unclamped
 * `get_context_usage`): only exact numbers are kept here.
 *
 * This is what removes the remaining ladder. The exact window only arrives at a
 * turn END, so without a cache every session would spend its first turn on a
 * string guess (or, for a proxy model, on no percentage at all) and then jump.
 * Keyed by host too: the same alias can resolve differently on a remote daemon.
 * A session's OWN reading always wins over the cache. The server keeps the cache on disk
 * (src/providers/model-window-store.ts, through onModelWindowLearned / seedModelWindows), so a
 * restart does not empty it.
 */
export interface LearnedModelWindow {
  window: number
  /** The CLI reading it came from. */
  source: 'cli-model-usage' | 'cli-context-usage'
  /** When it was learned (ms). */
  at: number
}
const modelWindowByHostModel = new Map<string, LearnedModelWindow>()
let learnedListener: ((key: string, entry: LearnedModelWindow) => void) | undefined
/** Normalized so one model can't occupy two slots. The writer sees the key
 *  `result.modelUsage` used and the reader sees the init/applied string, and the
 *  two differ by decoration: `openai.gpt-5.6-sol` vs `gpt-5.6-sol` missed the
 *  cache on every model switch until both sides ran through shortModelId. */
const modelKey = (host: string | null | undefined, model: string): string =>
  `${hostKey(host)}::${shortModelId(model).toLowerCase()}`
const modelOfKey = (key: string): string => key.slice(key.indexOf('::') + 2)

export function rememberModelWindow(
  host: string | null | undefined, model: string | undefined, window: number,
  source: LearnedModelWindow['source'] = 'cli-model-usage',
): void {
  if (!model) return
  if (!(Number.isFinite(window) && window > 0)) return
  const key = modelKey(host, model)
  const prev = modelWindowByHostModel.get(key)
  // A turn-end reading is never replaced by a usage read (the next turn end settles it), and the
  // same reading again is no news.
  if (prev?.source === 'cli-model-usage' && source !== 'cli-model-usage') return
  if (prev && prev.window === window && prev.source === source) return
  const entry = { window, source, at: Date.now() }
  modelWindowByHostModel.set(key, entry)
  learnedListener?.(key, entry)
}

export function recallModelWindow(host: string | null | undefined, model: string | undefined): number | undefined {
  if (!model) return undefined
  return modelWindowByHostModel.get(modelKey(host, model))?.window
}

/** The same model learned on any host, the newest first. A window is a property of the model; the
 *  host only matters for an alias, so a place with no host of its own may read another's. */
export function recallModelWindowAnyHost(model: string | undefined): number | undefined {
  if (!model) return undefined
  const want = shortModelId(model).toLowerCase()
  let best: LearnedModelWindow | undefined
  for (const [key, entry] of modelWindowByHostModel) {
    if (modelOfKey(key) === want && (!best || entry.at > best.at)) best = entry
  }
  return best?.window
}

/**
 * The window of a model for a place with no session of its own to read (an engine handoff's
 * budget, a gateway's model list, the chat stats before the lane reported): a window the CLI
 * reported for it on this host, else on any host, else the name rule as an estimate, else null.
 */
export function knownModelWindow(host: string | null | undefined, model: string | undefined): ResolvedContextWindow | null {
  const exact = recallModelWindow(host, model) ?? recallModelWindowAnyHost(model)
  if (exact !== undefined) return resolved(exact, 'host-model-cache')
  const guess = windowFromModelString(model)
  return guess !== undefined ? resolved(guess, 'model-string') : null
}

/** The store's hook: told every exact window learned, to keep it on disk. */
export function onModelWindowLearned(listener: ((key: string, entry: LearnedModelWindow) => void) | undefined): void {
  learnedListener = listener
}

/** The store's boot load: windows learned before the restart. A reading this process already
 *  made wins over the file. */
export function seedModelWindows(entries: Record<string, LearnedModelWindow>): number {
  let n = 0
  for (const [key, e] of Object.entries(entries)) {
    if (!key.includes('::') || !(Number.isFinite(e?.window) && e.window > 0)) continue
    if (e.source !== 'cli-model-usage' && e.source !== 'cli-context-usage') continue
    if (modelWindowByHostModel.has(key)) continue
    modelWindowByHostModel.set(key, { window: e.window, source: e.source, at: Number.isFinite(e.at) ? e.at : 0 })
    n++
  }
  return n
}

/** Every exact window known now, for the store to write. */
export function learnedModelWindows(): Record<string, LearnedModelWindow> {
  return Object.fromEntries(modelWindowByHostModel)
}

/** Test seam only. */
export function resetContextWindowCaches(): void {
  autoCompactByHost.clear()
  autoCompactOffByHost.clear()
  envMaxTokensByHost.clear()
  modelWindowByHostModel.clear()
}

/** Region/partition prefixes Bedrock-style model ids carry. */
const REGION_PREFIX = /^(?:global|us|eu|apac|jp|au|ca|sa|il|me|af|[a-z]{2}(?:-gov)?-[a-z]+-\d+)\./
/** Inference-provider prefixes. Deliberately an allowlist: the old rule was
 *  `replace(/^.*\./, '')`, which is greedy and therefore ate the model's OWN
 *  version dot — "gpt-5.6-sol" rendered as "6-sol" in the composer badge
 *  (2026-08-23 report). */
const PROVIDER_PREFIX = /^(?:anthropic|openai|meta|mistral|amazon|nova|deepseek|qwen|ai21|cohere|writer|stability|moonshot|zhipu|xai|google)\./

/**
 * Shorten a full model id for display, keeping the `[1m]` marker: strips a
 * transport prefix ("bedrock_mantle/"), region + provider prefixes, and a
 * trailing `-v1`/`_v2:0` revision. Anything it does not recognize is returned
 * unchanged — showing a longer true string beats showing a mangled one.
 */
export function shortModelId(raw: string): string {
  let out = raw.replace(/^[\w.-]+\//, '')
  for (let i = 0; i < 4; i++) {
    const next = out.replace(REGION_PREFIX, '').replace(PROVIDER_PREFIX, '')
    if (next === out) break
    out = next
  }
  out = out.replace(/[-_]v\d+(?::\d+)?(\[1m\])?$/, '$1')
  return out || raw
}

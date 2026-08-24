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
 * `get_context_usage.maxTokens` is deliberately NOT in that list. In 2.1.240 the
 * payload is built as `{maxTokens: g, rawMaxTokens: g, autocompactSource: y}` —
 * the same variable twice, already clamped — so it reveals the effective window
 * and nothing about the model's real one.
 *
 * Second rule: never render a percent from a guess with no basis. An
 * unrecognized model with no CLI reading yet yields NO window, and the caller
 * shows the token count alone rather than a 200K Anthropic-shaped guess that is
 * 5x wrong for a 1M proxy model.
 */

/** Window assumed for an Anthropic model with no `[1m]` marker. */
export const ANTHROPIC_DEFAULT_WINDOW = 200_000
export const EXTENDED_WINDOW = 1_000_000

/** Where the resolved denominator came from — carried to the UI for the tooltip
 *  and logged, so a wrong percentage is diagnosable without a repro. */
export type ContextWindowSource =
  | 'cli-model-usage' // result.modelUsage[model].contextWindow — exact
  | 'host-model-cache' // the same value, learned from an earlier session
  | 'env-max-tokens' // CLAUDE_CODE_MAX_CONTEXT_TOKENS (unrecognized models only)
  | 'model-string' // `[1m]` marker / known Anthropic family

export interface ContextWindowInputs {
  /** result.modelUsage[model].contextWindow — the CLI's resolved model window
   *  for THIS session. Exact; prefer it over everything. */
  cliModelWindow?: number | undefined
  /** Same value learned earlier for this host+model (rememberModelWindow). */
  hostModelWindow?: number | undefined
  /** CLAUDE_CODE_MAX_CONTEXT_TOKENS as the CLI reports it (get_settings
   *  effective.env). Applies to unrecognized models only — see the header. */
  envMaxContextTokens?: number | undefined
  /** Full model string from init / get_settings.applied. */
  model?: string | undefined
  /** input + cache_creation + cache_read of the latest call. Only used to
   *  correct a string guess a resume stripped the `[1m]` marker from. */
  observedTokens?: number | undefined
}

export interface ResolvedContextWindow {
  window: number
  source: ContextWindowSource
}

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
function windowFromModelString(model: string | undefined, observedTokens?: number): number | undefined {
  if (!model) return undefined
  if (model.toLowerCase().includes('[1m]')) return EXTENDED_WINDOW
  if (!isRecognizedClaudeModel(model)) return undefined
  // A resume can drop the `[1m]` suffix; tokens above the default prove the
  // session really is on the extended window (you cannot exceed the window).
  if (observedTokens != null && observedTokens > ANTHROPIC_DEFAULT_WINDOW) return EXTENDED_WINDOW
  return ANTHROPIC_DEFAULT_WINDOW
}

/**
 * Resolve the context% denominator (the model's absolute max window), or null
 * when nothing available justifies a percentage — the caller then shows the
 * token count alone.
 */
export function resolveContextWindow(inputs: ContextWindowInputs): ResolvedContextWindow | null {
  const own = positive(inputs.cliModelWindow)
  if (own !== undefined) return { window: own, source: 'cli-model-usage' }

  const cached = positive(inputs.hostModelWindow)
  if (cached !== undefined) return { window: cached, source: 'host-model-cache' }

  // The CLI applies this variable to models it does not recognize, and ignores
  // it for its own — mirror that exactly rather than trusting it everywhere.
  const envMax = positive(inputs.envMaxContextTokens)
  if (envMax !== undefined && !isRecognizedClaudeModel(inputs.model)) {
    return { window: envMax, source: 'env-max-tokens' }
  }

  const guess = windowFromModelString(inputs.model, inputs.observedTokens)
  if (guess !== undefined) return { window: guess, source: 'model-string' }

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
 * Absolute max window per host+model, learned from `result.modelUsage`.
 *
 * This is what removes the remaining ladder. The exact window only arrives at a
 * turn END, so without a cache every session would spend its first turn on a
 * string guess (or, for a proxy model, on no percentage at all) and then jump.
 * Keyed by host too: the same alias can resolve differently on a remote daemon.
 * A session's OWN reading always wins over the cache.
 */
const modelWindowByHostModel = new Map<string, number>()
/** Normalized so one model can't occupy two slots. The writer sees the key
 *  `result.modelUsage` used and the reader sees the init/applied string, and the
 *  two differ by decoration: `openai.gpt-5.6-sol` vs `gpt-5.6-sol` missed the
 *  cache on every model switch until both sides ran through shortModelId. */
const modelKey = (host: string | null | undefined, model: string): string =>
  `${hostKey(host)}::${shortModelId(model).toLowerCase()}`

export function rememberModelWindow(host: string | null | undefined, model: string | undefined, window: number): void {
  if (!model) return
  if (Number.isFinite(window) && window > 0) modelWindowByHostModel.set(modelKey(host, model), window)
}

export function recallModelWindow(host: string | null | undefined, model: string | undefined): number | undefined {
  if (!model) return undefined
  return modelWindowByHostModel.get(modelKey(host, model))
}

/** Test seam only. */
export function resetContextWindowCaches(): void {
  autoCompactByHost.clear()
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

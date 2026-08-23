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
 * Two rules encoded here:
 *
 * A. ONE denominator, and it is the CLI's EFFECTIVE window — min(raw model
 *    window, CLAUDE_CODE_AUTO_COMPACT_WINDOW). That is what `/context` divides
 *    by (verified in 2.1.240: it reports maxTokens === rawMaxTokens === the
 *    clamped value, with autocompactSource:'env'), and it is the window that
 *    governs behavior: a session with the user's global 400K clamp compacts at
 *    400K no matter how big the model's raw window is. The CLI's own statusline
 *    divides by the RAW window instead (2.1.240: `context_window: Fy0(v, T)`
 *    with `T = rawWindowForModel(model)`), which is why the two numbers
 *    disagree upstream too. Walnut shows both surfaces in ONE popover, so it
 *    picks the one that predicts compaction and labels the denominator.
 *
 * B. Never render a percent from a guess we have no basis for. An unrecognized
 *    model string yields NO window (and the caller emits tokens without a
 *    percent) rather than a 200K Anthropic-shaped guess that will be off by 5x.
 */

/** Window assumed for an Anthropic model with no `[1m]` marker. */
export const ANTHROPIC_DEFAULT_WINDOW = 200_000
export const EXTENDED_WINDOW = 1_000_000

/** Where the resolved denominator came from — carried to the UI for the tooltip
 *  and logged, so a wrong percentage is diagnosable without a repro. */
export type ContextWindowSource =
  | 'cli-effective' // get_context_usage.maxTokens — exact, matches /context
  | 'raw-clamped' // CLI raw model window ∧ the auto-compact clamp
  | 'cli-raw' // CLI raw model window, no clamp configured
  | 'model-clamped' // model-string guess ∧ the auto-compact clamp
  | 'model-string' // model-string guess, no clamp configured
  | 'clamp-only' // window unknowable, but the clamp bounds it

export interface ContextWindowInputs {
  /** get_context_usage.maxTokens — the CLI's own effective window, already
   *  min(model window, clamp). Exact; prefer it over everything. */
  cliEffectiveWindow?: number | undefined
  /** result.modelUsage[model].contextWindow — the CLI's RAW model window
   *  (immune to the auto-compact clamp). */
  cliRawWindow?: number | undefined
  /** CLAUDE_CODE_AUTO_COMPACT_WINDOW as the CLI reports it (get_settings
   *  effective.env). Process-wide, so it survives model switches. */
  autoCompactWindow?: number | undefined
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

/** Anthropic model ids are the only ones whose window we can infer from the
 *  string (the `[1m]` marker is a client-side opt-in the CLI honours; plain
 *  ids get the 200K default). Everything else — custom proxy models, OpenAI
 *  ids, anything routed through ANTHROPIC_CUSTOM_MODEL_OPTION — is unknowable
 *  and must come from the CLI. */
function windowFromModelString(model: string | undefined, observedTokens?: number): number | undefined {
  if (!model) return undefined
  const lower = model.toLowerCase()
  if (lower.includes('[1m]')) return EXTENDED_WINDOW
  const looksAnthropic = /claude/.test(lower) || /\b(opus|sonnet|haiku|fable)\b/.test(lower)
  if (!looksAnthropic) return undefined
  // A resume can drop the `[1m]` suffix; tokens above the default prove the
  // session really is on the extended window (you cannot exceed the window).
  if (observedTokens != null && observedTokens > ANTHROPIC_DEFAULT_WINDOW) return EXTENDED_WINDOW
  return ANTHROPIC_DEFAULT_WINDOW
}

/**
 * Resolve the context% denominator, or null when nothing available justifies a
 * percentage (caller then shows the token count alone).
 */
export function resolveContextWindow(inputs: ContextWindowInputs): ResolvedContextWindow | null {
  const clamp = positive(inputs.autoCompactWindow)

  const effective = positive(inputs.cliEffectiveWindow)
  if (effective !== undefined) return { window: effective, source: 'cli-effective' }

  const raw = positive(inputs.cliRawWindow)
  if (raw !== undefined) {
    return clamp !== undefined
      ? { window: Math.min(raw, clamp), source: 'raw-clamped' }
      : { window: raw, source: 'cli-raw' }
  }

  const guess = windowFromModelString(inputs.model, inputs.observedTokens)
  if (guess !== undefined) {
    return clamp !== undefined
      ? { window: Math.min(guess, clamp), source: 'model-clamped' }
      : { window: guess, source: 'model-string' }
  }

  // Unknown model. The clamp is still an upper bound on the effective window,
  // so it yields a real (if optimistic) percentage instead of nothing — and it
  // is what get_context_usage will confirm seconds later whenever the model's
  // raw window is the larger of the two, which is the common case for the
  // proxy models this path exists for.
  return clamp !== undefined ? { window: clamp, source: 'clamp-only' } : null
}

/**
 * Last-seen auto-compact clamp per exec host.
 *
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW is a property of the HOST's settings/env, not
 * of one CLI process, so the first session to read it can answer for every other
 * session on that host. Without this share, sessions that had not yet completed
 * a get_settings read divided by the raw window while their neighbours divided
 * by the clamp — live WS capture right after a server restart showed one
 * fable[1m] session reporting `window: 1000000` (20%) while another reported
 * `400000` (89%), which is the same jump this whole module exists to remove.
 *
 * A session's OWN read always wins; this is only the fallback for the window
 * before it lands. Keyed by host (null = local) so a remote daemon's clamp never
 * answers for the Mac's.
 */
const autoCompactByHost = new Map<string, number>()
const hostKey = (host: string | null | undefined): string => host ?? '__local__'

export function rememberAutoCompactWindow(host: string | null | undefined, window: number): void {
  if (Number.isFinite(window) && window > 0) autoCompactByHost.set(hostKey(host), window)
}

export function recallAutoCompactWindow(host: string | null | undefined): number | undefined {
  return autoCompactByHost.get(hostKey(host))
}

/** Test seam only. */
export function resetAutoCompactWindowCache(): void {
  autoCompactByHost.clear()
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

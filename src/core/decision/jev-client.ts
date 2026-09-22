/**
 * Jev decision client — TypeSafe's "System One" model behind Walnut's small
 * structured decisions.
 *
 * Jev is NOT a chat model: one POST carries a text `state` plus typed
 * questions and returns every answer in a single forward pass — a choice with
 * per-option probabilities, a rubric score, or a 0-1 truth probability — each
 * with calibrated confidence. That shape replaces the strict-JSON one-shots
 * this repo runs on the "fast model" (which on a CLI provider spawns a whole
 * `claude -p` per call; see agent.quick_parse in types.ts for the measured
 * damage) with a ~100-400ms, ~$0.00002 HTTP call and no JSON parsing at all.
 *
 * Follows the STT engine-openai pattern, deliberately NOT a ProtocolAdapter:
 * there is no messages array, no tools, no streaming — a provider adapter
 * would be the wrong altitude. Bare fetch, Bearer auth, hard timeout.
 *
 * Every call is accounted (usage source 'jev') — no anonymous background
 * model calls, same house rule as micro-agent.ts.
 */

import { autoDetectApiKey, resolveSecret } from '../../model/providers/secret.js';
import { log } from '../../logging/index.js';
import type { Config } from '../types.js';

/** First-party endpoint. Gateways mirror the request/response shape. */
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
/** Decisions sit on interactive paths; a slow answer is a wrong answer. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option key → what that option means */
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** ordered rubric levels, index 0..n-1 */
  criteria: string[];
}

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export interface JevDecideOptions {
  timeoutMs?: number;
  /** Usage attribution — rides the usage record, never the request. */
  taskId?: string;
  sessionId?: string;
}

export interface JevClient {
  /** The model id requests carry (config value or the client default), exposed
   *  so call sites can attribute results without re-deriving the default. */
  model: string;
  /** Ask typed questions about a state. Throws on transport/HTTP errors —
   *  callers keep their existing path as the fallback. */
  decide(
    state: string,
    questions: Record<string, JevQuestion>,
    opts?: JevDecideOptions,
  ): Promise<Record<string, JevAnswer>>;
}

/**
 * Shape-validate one answer as a Choice. Returns undefined for anything
 * malformed: wrong type, non-string choice, missing or non-numeric
 * confidence. The wire shape is a cast, not a contract, and a gateway that
 * omits `confidence` must not sail past a caller's `x.confidence < floor`
 * comparison (`undefined < 0.6` is false — the fail-open bug this helper
 * exists to prevent, worst at the unattended call sites).
 */
export function readChoice(answer: unknown): { choice: string; confidence: number } | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const a = answer as { type?: unknown; choice?: unknown; confidence?: unknown };
  if (a.type !== 'choice' || typeof a.choice !== 'string') return undefined;
  if (typeof a.confidence !== 'number' || Number.isNaN(a.confidence)) return undefined;
  return { choice: a.choice, confidence: a.confidence };
}

/** One entry: getJevClient is called per operation (every quick-parse
 *  keystroke), and resolving a `${file:}` key does a synchronous file read.
 *  The cache bounds that to one resolution per TTL; a config edit changes the
 *  cache key and takes effect immediately, while rotating the FILE content
 *  behind an unchanged ref is picked up within the TTL. */
const CLIENT_CACHE_TTL_MS = 60_000;
let clientCache: { key: string; at: number; client: JevClient | undefined } | undefined;

/**
 * The key reference Jev rides, in priority order:
 *   1. jev.api_key — an explicit Jev-specific override (a TypeSafe key, or a
 *      dedicated gateway key)
 *   2. providers.openrouter.api_key — the SHARED OpenRouter credential, when
 *      the endpoint is an OpenRouter URL. One key, configured once, serves
 *      chat models and Jev alike.
 *   3. OPENROUTER_API_KEY from the environment (same fallback the provider
 *      registry uses), again only for an OpenRouter endpoint.
 * Returns the UNRESOLVED reference (or a literal) — resolution happens once,
 * after the cache check.
 */
function keyRefFor(config: Config, endpoint: string): string | undefined {
  const own = config.jev?.api_key;
  if (typeof own === 'string' && own) return own;
  if (!/^https:\/\/openrouter\.ai\//.test(endpoint)) return undefined;
  const shared = (config.providers as Record<string, { api_key?: unknown }> | undefined)?.openrouter?.api_key;
  if (typeof shared === 'string' && shared) return shared;
  return autoDetectApiKey('openrouter');
}

/**
 * Build a client from config, or undefined when Jev isn't configured — the
 * one check every call site branches on. Missing key (no jev.api_key AND no
 * shared OpenRouter credential for an OpenRouter endpoint, or a `${file:}`/
 * `${env:}` reference that resolves to nothing) means "not configured"; the
 * unresolvable-reference case is logged so a typo'd path is diagnosable.
 * Non-string config values (YAML numbers) are treated as unset rather than
 * thrown on: callers rely on this function never throwing.
 */
export function getJevClient(config: Config): JevClient | undefined {
  const jev = config.jev;
  if (!jev) return undefined;

  const endpoint = (typeof jev.endpoint === 'string' ? jev.endpoint : DEFAULT_ENDPOINT).replace(/\/$/, '');
  const model = typeof jev.model === 'string' ? jev.model : DEFAULT_MODEL;
  const keyRef = keyRefFor(config, endpoint);
  if (!keyRef) return undefined;

  const cacheKey = JSON.stringify([keyRef, endpoint, model]);
  const now = Date.now();
  if (clientCache && clientCache.key === cacheKey && now - clientCache.at < CLIENT_CACHE_TTL_MS) {
    return clientCache.client;
  }

  const apiKey = resolveSecret(keyRef);
  if (!apiKey) {
    log.web.warn('jev is configured but api_key did not resolve — jev disabled', {});
    clientCache = { key: cacheKey, at: now, client: undefined };
    return undefined;
  }

  const client: JevClient = {
    model,
    async decide(state, questions, opts = {}) {
      const t0 = Date.now();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, state, questions }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        // Status is safe to log; the body may echo the state, so keep it short.
        throw new Error(`Jev ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json() as {
        model?: string;
        answers?: Record<string, JevAnswer>;
        // Some gateways add a `cost` field here. Deliberately unread: cost has
        // ONE owner, the pricing table (usage/pricing.ts 'jev' row) — reading
        // both would let the two drift or double-count.
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (!data.answers || typeof data.answers !== 'object') {
        throw new Error('Jev: response has no answers object');
      }

      try {
        // Dynamic on purpose: usage/index.js instantiates the sqlite-backed
        // tracker at import time. A static import would drag better-sqlite3 and
        // a real DB open into every unit test that imports a caller module.
        const { usageTracker } = await import('../usage/index.js');
        usageTracker.record({
          source: 'jev',
          // Prefer the versioned id the server reports over the alias we sent.
          model: data.model ?? model,
          input_tokens: data.usage?.input_tokens ?? 0,
          output_tokens: data.usage?.output_tokens ?? 0,
          duration_ms: Date.now() - t0,
          ...(opts.taskId ? { taskId: opts.taskId } : {}),
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        });
      } catch (err) {
        // Accounting must never fail the decision that already succeeded.
        log.usage.warn('jev usage record failed', {
          errorKind: err instanceof Error ? err.name : typeof err,
        });
      }

      return data.answers;
    },
  };
  clientCache = { key: cacheKey, at: now, client };
  return client;
}

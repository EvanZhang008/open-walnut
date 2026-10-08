import { MODEL_CATALOG } from '../model/providers/model-catalog.js';
import { CLAUDE_CLI_PROVIDER, LEGACY_DEFAULT_PROVIDER, resolveMainProviderName } from '../model/providers/default-provider.js';
import type { Config } from './types.js';

/**
 * Resolve the model used for cheap background work. Providers without a Haiku
 * catalog entry fall back to the main model through sendMessage unless
 * agent.fast_model is configured explicitly.
 */
export function fastModelFor(config: Config): string | undefined {
  if (config.agent?.fast_model) return config.agent.fast_model;
  const providerName = resolveMainProviderName(config);
  return MODEL_CATALOG[providerName]?.find((model) =>
    model.id.toLowerCase().includes('haiku')
  )?.id;
}

/**
 * True when a fast-model call would run through the Claude Code CLI, i.e.
 * spawn a whole `claude -p` process (measured ~5s before any prompt; see
 * agent.quick_parse in types.ts). Call sites with a faster structured-decision
 * backend (Jev) use this to skip the hopeless spawn instead of letting it blow
 * its timeout. The predicate is the PROVIDER NAME alone: sendMessage picks its
 * adapter from `config.provider ?? resolveMainProviderName(...)` and never
 * from the model id, so any agent.fast_model value under a claude_cli main
 * provider still spawns the CLI. (An earlier version of this function asked
 * the catalog whether the model id "was a CLI model", which wrongly reported
 * an escape for direct-API ids that sendMessage would still route to the CLI.)
 */
export function fastModelRidesCli(config: Config): boolean {
  return resolveMainProviderName(config) === CLAUDE_CLI_PROVIDER;
}

/** A fast-model call that rides the CLI gets at least this long (titleBudgetMs's value). */
export const CLI_FAST_CALL_BUDGET_MS = 60_000;

/**
 * How long one fast-model call may take, fitted to the CHANNEL it rides:
 * `directMs` for a direct API call, at least CLI_FAST_CALL_BUDGET_MS when it
 * spawns `claude -p` (provider, else the main provider, is the CLI). A CLI turn
 * is a process spawn (5 to 9 s warm on an idle Mac), it waits for one of the
 * adapter's slots, and a background one runs in the utility band when the
 * deploy raised the server: measured 2026-10-04 at load ~375, a stand-in turn
 * with fixed CPU work took 4.4 to 6.9 s there against 1.6 s at the server's
 * priority. The 10 and 15 s budgets of the background helpers expired on that
 * path before any answer; session titles moved to 60 s for the same reason
 * (titleBudgetMs, 2026-09-04).
 */
export function fastCallBudgetMs(config: Config, directMs: number, provider?: string): number {
  return (provider ?? resolveMainProviderName(config)) === CLAUDE_CLI_PROVIDER
    ? Math.max(directMs, CLI_FAST_CALL_BUDGET_MS)
    : directMs;
}

/**
 * A direct-API route for cheap background GENERATION when the main provider
 * rides the CLI (fastModelRidesCli). Decisions have Jev; generation (project
 * summaries) still needs a chat model, and spawning `claude -p` per background
 * call is never the right vehicle — it burned the 15s budget often enough that
 * most projects simply had no summary. Picks the first configured non-CLI
 * provider that has a haiku catalog entry; with no explicit providers map,
 * falls back to the legacy-synthesized bedrock (sendMessage always resolves
 * it; missing credentials surface as a throw the caller treats as "route
 * unavailable"). Returns undefined when every configured provider is the CLI —
 * callers keep the CLI path rather than losing the feature.
 */
export function directFastRoute(config: Config): { provider: string; model: string } | undefined {
  // An explicit agent.fast_model is the user's deliberate cheap-model choice —
  // honor it on the direct route too, but only when the chosen provider's
  // catalog actually serves that id (a CLI alias won't resolve on Bedrock).
  const pick = (name: string): { provider: string; model: string } | undefined => {
    const catalog = MODEL_CATALOG[name];
    if (!catalog) return undefined;
    const preferred = config.agent?.fast_model;
    if (preferred && catalog.some((m) => m.id === preferred)) return { provider: name, model: preferred };
    const haiku = catalog.find((m) => m.id.toLowerCase().includes('haiku'))?.id;
    return haiku ? { provider: name, model: haiku } : undefined;
  };
  const explicit = Object.keys(config.providers ?? {});
  for (const name of explicit) {
    if (name === CLAUDE_CLI_PROVIDER) continue;
    const route = pick(name);
    if (route) return route;
  }
  if (explicit.length === 0) return pick(LEGACY_DEFAULT_PROVIDER);
  return undefined;
}

/**
 * True when UNPROMPTED background model calls (session auto-organize, project
 * summaries) must not fire. Test servers (vitest e2e, the Playwright fixture)
 * are real servers with the host's real ~/.aws — without this gate every
 * quick-start POST in a test would hit live Bedrock: cost + nondeterminism
 * (a "successful" categorization moving a task mid-assertion is a flake).
 * Unit tests that mock sendMessage call the workers DIRECTLY, bypassing the
 * gated call sites, so they stay testable. WALNUT_DISABLE_BACKGROUND_AI=1
 * forces the gate outside test env (e.g. a constrained deployment).
 */
export function backgroundAiDisabled(): boolean {
  return !!(
    process.env.VITEST
    || process.env.VITEST_WORKER_ID
    || process.env.NODE_ENV === 'test'
    || process.env.WALNUT_DISABLE_BACKGROUND_AI === '1'
  );
}

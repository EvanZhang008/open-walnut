/**
 * Model servers on the user's own machine or network: Ollama, and an
 * OpenAI-compatible server (LM Studio, vLLM, llama.cpp) configured as an
 * `openai-chat` provider with a `base_url` and no key.
 *
 * They differ from a cloud provider in two ways that callers must respect:
 *   - readiness is "the server answers", never "a key is configured" (there is
 *     none), so it is probed over HTTP with a short deadline;
 *   - the catalog has no entry for them (the models are whatever the user
 *     installed), so a tier word like "sonnet" must never be sent as a model id.
 */
import type { ApiProtocol, ProviderConfig } from './types.js';
import { DEFAULT_BASE_URLS } from './defaults.js';

/**
 * True for a provider whose models run on a server the user hosts: Ollama, or an
 * `openai-chat` provider whose `base_url` is on this machine or the local network
 * (loopback, a private address, a one-word or `.local`/`.lan`/`.internal` name).
 * Decided by the address, never by a missing key: LM Studio users often set a
 * placeholder key, and a cloud endpoint may sign in through headers.
 */
export function isLocalModelProvider(prov: Pick<ProviderConfig, 'api' | 'base_url'> | undefined): boolean {
  if (!prov) return false;
  if (prov.api === 'ollama') return true;
  return prov.api === 'openai-chat' && !!prov.base_url && isLocalAddress(prov.base_url);
}

/** A URL whose host is on this machine or a private network. */
export function isLocalAddress(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === 'host.docker.internal') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const m172 = /^172\.(\d+)\./.exec(host);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(host)) return true;
  return !host.includes('.') && !host.includes(':');
}

/** The URL that answers when the server is up: Ollama's model list, or the OpenAI-style `/models`. */
export function localProviderProbeUrl(prov: Pick<ProviderConfig, 'api' | 'base_url'>): string {
  const trim = (u: string) => u.replace(/\/+$/, '');
  if (prov.api === 'ollama') return `${trim(prov.base_url ?? DEFAULT_BASE_URLS.ollama ?? 'http://localhost:11434')}/api/tags`;
  return `${trim(prov.base_url ?? '')}/models`;
}

/** The base address the user knows the server by (what a "not answering" line names). */
export function localProviderBaseUrl(prov: Pick<ProviderConfig, 'api' | 'base_url'>): string {
  return prov.base_url ?? (prov.api === 'ollama' ? (DEFAULT_BASE_URLS.ollama ?? 'http://localhost:11434') : '');
}

export const LOCAL_PROBE_TIMEOUT_MS = 1500;

/**
 * The model ids the server lists (Ollama's `/api/tags` names, the OpenAI-style
 * `/models` ids), or null when it did not answer with a list. Never throws.
 */
export async function listLocalModelIds(
  prov: Pick<ProviderConfig, 'api' | 'base_url' | 'api_key'>,
  timeoutMs = 3000,
): Promise<string[] | null> {
  try {
    // A server started with a key (vLLM --api-key) lists its models only with it.
    const headers: Record<string, string> = prov.api_key ? { authorization: `Bearer ${prov.api_key}` } : {};
    const res = await fetch(localProviderProbeUrl(prov), { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    const body = await res.json() as { models?: Array<{ name?: unknown }>; data?: Array<{ id?: unknown }> };
    const rows = prov.api === 'ollama' ? body.models?.map((m) => m?.name) : body.data?.map((m) => m?.id);
    if (!Array.isArray(rows)) return null;
    return rows.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return null;
  }
}

/**
 * Does the server answer? Any HTTP response counts (a 401 from a server that
 * wants a key still proves it is up; the call itself will say what is wrong).
 * Only a refused connection, a timeout or a bad URL reads as down. Never throws.
 */
export async function probeLocalProvider(
  prov: Pick<ProviderConfig, 'api' | 'base_url'>,
  timeoutMs = LOCAL_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; url: string; error?: string }> {
  const url = localProviderProbeUrl(prov);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return { ok: true, url };
  } catch (err) {
    return { ok: false, url, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Two names of one model on this server: Ollama's are case-insensitive, and no tag means `:latest`. */
export function sameLocalModel(api: ApiProtocol, a: string, b: string): boolean {
  if (a === b) return true;
  if (api !== 'ollama') return false;
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

const SERVED_TTL_MS = 60_000;
const served = new Map<string, { at: number; ids: Promise<string[] | null> }>();
const toldMissing = new Set<string>();

/**
 * The model to send a local server: `wanted` when it serves it, else `main` when it
 * serves that. A model Walnut's own helpers name (agent.fast_model, a title or
 * summary model) that the user never pulled answered every helper call with a 404
 * (2026-11-01: Path D's snippet set fast_model qwen3:8b next to a pull of only
 * qwen3-coder:30b, and host-learning failed). The list is read at most once a
 * minute per server; with no list, or neither model on it, `wanted` goes as asked
 * so the server's own error names it. `onFallback` runs once per server and model.
 */
export async function localModelOrMain(
  prov: Pick<ProviderConfig, 'api' | 'base_url' | 'api_key'>,
  wanted: string,
  main: string,
  onFallback?: (info: { wanted: string; main: string; base: string }) => void,
): Promise<string> {
  if (sameLocalModel(prov.api, wanted, main)) return wanted;
  const base = localProviderProbeUrl(prov);
  let entry = served.get(base);
  if (!entry || Date.now() - entry.at > SERVED_TTL_MS) {
    entry = { at: Date.now(), ids: listLocalModelIds(prov) };
    served.set(base, entry);
  }
  const ids = await entry.ids;
  if (!ids || ids.length === 0) return wanted;
  if (ids.some((id) => sameLocalModel(prov.api, id, wanted))) return wanted;
  if (!ids.some((id) => sameLocalModel(prov.api, id, main))) return wanted;
  const key = `${base}\n${wanted}`;
  if (!toldMissing.has(key)) {
    toldMissing.add(key);
    onFallback?.({ wanted, main, base: localProviderBaseUrl(prov) });
  }
  return main;
}

/** Tests only: forget the cached model lists and the fallbacks already logged. */
export function resetLocalModelCache(): void {
  served.clear();
  toldMissing.clear();
}

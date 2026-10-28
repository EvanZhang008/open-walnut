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
import type { ProviderConfig } from './types.js';
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

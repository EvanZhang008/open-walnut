/**
 * Warm-up cache for the embedded VS Code ensure call.
 *
 * Opening the Code view costs an ensure round trip (spawn/adopt code-server +
 * tunnel) BEFORE the iframe can even start booting. Hovering the Code chip is
 * a strong-enough intent signal to start that work early, so by the time the
 * user clicks, the ensure promise is usually already resolved.
 *
 * Prefetch uses install=false: hover must never trigger a ~100MB code-server
 * download on a host that doesn't have it (mouse-over is often accidental).
 * A rejected probe evicts itself, so the click path retries with install
 * allowed.
 */
import { ensureSessionVscodeEmbed, type VscodeEmbedInfo } from '@/api/sessions';

const TTL_MS = 15_000;

const cache = new Map<string, { at: number; promise: Promise<VscodeEmbedInfo> }>();

/** Fire-and-forget warm-up (Code chip hover). */
export function prefetchVscodeEmbed(sessionId: string): void {
  const cur = cache.get(sessionId);
  if (cur && Date.now() - cur.at < TTL_MS) return;
  const promise = ensureSessionVscodeEmbed(sessionId, { install: false });
  cache.set(sessionId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(sessionId));
}

/** The view's ensure: reuses a fresh prefetch, otherwise a full ensure (install allowed). */
export function consumeVscodeEmbed(sessionId: string, force = false): Promise<VscodeEmbedInfo> {
  if (!force) {
    const cur = cache.get(sessionId);
    if (cur && Date.now() - cur.at < TTL_MS) return cur.promise;
  }
  const promise = ensureSessionVscodeEmbed(sessionId);
  cache.set(sessionId, { at: Date.now(), promise });
  promise.catch(() => cache.delete(sessionId));
  return promise;
}

/**
 * The `hints` a sender asks for on one message (`on_request`): `{ question: { arg: "20" } }`,
 * `{ "voice-reply": {} }`. Taken from a request body as untrusted input: unknown shapes
 * are dropped, never an error, because a hint must not fail a send.
 */

import type { RequestedHints } from './hint-send.js';
import { HINT_KIND_RE } from './hint-registry.js';

const MAX_KINDS = 8;

export function requestedHintsOf(input: unknown): RequestedHints | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: RequestedHints = {};
  for (const [kind, v] of Object.entries(input as Record<string, unknown>).slice(0, MAX_KINDS)) {
    if (!HINT_KIND_RE.test(kind)) continue;
    if (v === true || v === null || v === undefined) { out[kind] = {}; continue; }
    if (typeof v === 'number' || typeof v === 'string') {
      const arg = String(v);
      if (/^[A-Za-z0-9._-]{1,32}$/.test(arg)) out[kind] = { arg };
      continue;
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      const raw = (v as { arg?: unknown }).arg;
      const arg = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : undefined;
      out[kind] = arg && /^[A-Za-z0-9._-]{1,32}$/.test(arg) ? { arg } : {};
    }
  }
  return Object.keys(out).length ? out : undefined;
}

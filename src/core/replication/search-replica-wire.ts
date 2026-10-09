/**
 * What the primary and the companion say to each other about the companion's
 * copy of the search index (search-replica.ts sends, search-replica-store.ts
 * answers, over POST /bridge/replica with kind 'search'), and the one rule
 * that decides whether the copy is on.
 *
 *   status {mode, model, digest}         → {enabled, reason, totalMb, …, digest, inSync}
 *   sync   {entries:[{k, h}]}            → {need:[k], removed}
 *   put    {docs:[WireDoc], digest?}     → {stored, keptVectors, inSync}
 *
 * `k` is a replica key (core/search/replica-refs.ts), `h` the primary's value
 * for it: the first 16 hex of the doc's content hash and its vector state.
 */

export type CompanionSearchMode = 'auto' | 'on' | 'off'

export function companionSearchMode(raw: unknown): CompanionSearchMode {
  return raw === 'on' || raw === 'off' ? raw : 'auto'
}

/**
 * Memory one query worker holds with the default model: 2.3 to 2.6 GB RSS
 * measured on the companion (arm64, 2026-10-09), 2.9 GB on the Mac.
 */
export const MODEL_FOOTPRINT_MB = 2_600

/** 'auto' turns the copy on only when this much memory is left for the server
 *  and the system once the model is loaded. */
export const HEADROOM_MB = 3_000

export const AUTO_MIN_TOTAL_MB = MODEL_FOOTPRINT_MB + HEADROOM_MB

export type CompanionSearchReason = 'auto' | 'on' | 'forced' | 'off' | 'memory' | 'model'

/**
 * Whether the copy is on. 'auto' asks for the headroom; 'on' is the user's
 * call even without it ('forced', which the Settings row warns about).
 */
export function companionSearchDecision(mode: CompanionSearchMode, totalMb: number): { enabled: boolean; reason: CompanionSearchReason } {
  if (mode === 'off') return { enabled: false, reason: 'off' }
  const roomy = totalMb >= AUTO_MIN_TOTAL_MB
  if (mode === 'on') return { enabled: true, reason: roomy ? 'on' : 'forced' }
  return roomy ? { enabled: true, reason: 'auto' } : { enabled: false, reason: 'memory' }
}

export interface WireDoc {
  k: string
  /** The primary's manifest value for this doc; the companion stamps the doc with it. */
  h: string
  title: string
  summary: string
  note: string
  meta: string
  updatedAt: number
  hash: string
  idents: string[]
  /** seq and base64 bytes of each stored vector. */
  vectors: Array<{ s: number; b: string }>
}

export const MANIFEST_VALUE_RE = /^[0-9a-f]{16}[nzv]$/

export function manifestValue(hash: string, vec: 'n' | 'z' | 'v'): string {
  return `${hash.slice(0, 16)}${vec}`
}

const MAX_TEXT = 4 * 1024 * 1024

function str(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === 'string' && v.length <= max
}

/** A doc as the wire carries it, or null for anything malformed. */
export function wireDocOf(raw: unknown): WireDoc | null {
  const d = raw as Partial<WireDoc> | null
  if (!d || typeof d !== 'object') return null
  if (!str(d.k, 4096) || !d.k || !str(d.h, 32) || !MANIFEST_VALUE_RE.test(d.h)) return null
  if (!str(d.title) || !str(d.summary) || !str(d.note) || !str(d.meta)) return null
  if (typeof d.updatedAt !== 'number' || !Number.isFinite(d.updatedAt)) return null
  if (!str(d.hash, 64) || !/^[0-9a-f]{40}$/.test(d.hash)) return null
  if (!Array.isArray(d.idents) || !d.idents.every((t) => str(t, 4096))) return null
  if (!Array.isArray(d.vectors)) return null
  for (const v of d.vectors) {
    if (!v || typeof v !== 'object' || !Number.isInteger(v.s) || v.s < 0 || v.s > 10_000 || !str(v.b, 64 * 1024)) return null
  }
  return d as WireDoc
}

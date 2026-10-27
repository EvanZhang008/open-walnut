/**
 * The pure half of the draft mirror (drafts.ts): which keys are drafts, and how
 * this browser's copy and the server's are merged. No DOM, so the rules are
 * graded in Node.
 */

/** The key families a draft uses. Keep in step with src/web/routes/drafts.ts. */
export const DRAFT_KEY_PREFIXES = ['draft:', 'side-thread-draft:'] as const;
/** The server keeps no longer draft; this browser still does. */
export const MAX_SYNCED_DRAFT_LEN = 64 * 1024;

/**
 * Words that carry a credential (a URL with a password in it, a well-known token
 * shape) stay in this browser: the server's copy is a file on disk.
 */
const CREDENTIAL = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})|[?&](?:access_?token|api_?key|apikey|token|secret|password|sig|signature)=[^\s&#]{8,}|hooks\.slack\.com\/services\//i;
export function hasCredential(text: string): boolean {
  return CREDENTIAL.test(text);
}

export function isDraftKey(key: string): boolean {
  return DRAFT_KEY_PREFIXES.some((p) => key.startsWith(p));
}

export interface DraftEntry { v: string | null; ts: number }

export interface LocalDraftView {
  /** This browser's value for a key (null = none). */
  get(key: string): string | null;
  /** When this browser last wrote the key (undefined = never seen by the mirror). */
  ts(key: string): number | undefined;
  /** Every draft key this browser holds a value for. */
  keys(): string[];
}

export interface DraftMergePlan {
  /** Server values this browser takes (v null = remove). */
  adopt: Record<string, DraftEntry>;
  /** This browser's values the server does not have yet. */
  push: Record<string, DraftEntry>;
}

/**
 * Last writer wins per key. A server entry is taken only when it is strictly
 * newer than this browser's write, or this browser has nothing and never wrote
 * the key. A local value the mirror never stamped (written before the mirror
 * existed) is what the person sees: it is never replaced, it is pushed up.
 */
export function planDraftMerge(server: Record<string, DraftEntry>, local: LocalDraftView, now = Date.now()): DraftMergePlan {
  const adopt: Record<string, DraftEntry> = {};
  const push: Record<string, DraftEntry> = {};
  for (const [key, entry] of Object.entries(server)) {
    if (!isDraftKey(key) || !entry || typeof entry.ts !== 'number') continue;
    if (entry.v !== null && typeof entry.v !== 'string') continue;
    const value = local.get(key);
    const ts = local.ts(key);
    if (ts === undefined) {
      if (value === null) { if (entry.v !== null) adopt[key] = entry; continue; }
      if (value !== entry.v) push[key] = { v: hasCredential(value) ? null : value, ts: now };
      continue;
    }
    if (entry.ts > ts) {
      if (entry.v !== value) adopt[key] = entry;
    } else if (entry.ts < ts && entry.v !== value) {
      push[key] = { v: value !== null && hasCredential(value) ? null : value, ts };
    }
  }
  for (const key of local.keys()) {
    if (!isDraftKey(key) || key in server) continue;
    const value = local.get(key);
    if (value === null || value.length > MAX_SYNCED_DRAFT_LEN || hasCredential(value)) continue;
    push[key] = { v: value, ts: local.ts(key) ?? now };
  }
  return { adopt, push };
}

/** Fold a newer entry into a pending batch (the older write of a key is dropped). */
export function foldPending(pending: Map<string, DraftEntry>, key: string, entry: DraftEntry): void {
  const prev = pending.get(key);
  if (!prev || prev.ts <= entry.ts) pending.set(key, entry);
}

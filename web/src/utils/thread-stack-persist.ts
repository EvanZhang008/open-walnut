/**
 * The question stack survives a reload (spec 5.4, C69): the path, where each page
 * was left, when each question was last viewed and the pending pages left with a
 * draft go to sessionStorage (`thread-stack.v1:<sessionId>`, per tab); the leaf's
 * head id rides the URL next to its column (`?s1=<sid>&t1=<headId>`).
 *
 * Stored by HEAD ID, not by thread key: a key embeds a whole passage, a head id
 * is short, stable and what the URL can carry. Restoring maps head ids back to
 * keys through the tree and gives up (root, silently) unless every one exists.
 */
import type { ThreadPendingPage } from '@/components/sessions/thread-ui-contract';
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';
import { isPendingKey, type PageLanding } from '@/utils/thread-stack-state';

export const STACK_STORAGE_PREFIX = 'thread-stack.v1:';

export interface PersistedStack {
  /** Head ids below the root, shallowest first (the page on screen last). */
  path: string[];
  /** Page landing records by head id ('' = the root page). */
  pages: Record<string, PageLanding>;
  /** Head id to when that page was last on screen (ms). */
  lastViewedAt: Record<string, number>;
  /** Pending pages left with text in their composer. */
  drafts: ThreadPendingPage[];
}

export function emptyPersistedStack(): PersistedStack {
  return { path: [], pages: {}, lastViewedAt: {}, drafts: [] };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Accept only the shape we write; anything else reads as nothing stored. */
export function sanitizePersistedStack(raw: unknown): PersistedStack | null {
  if (!isObj(raw)) return null;
  const path = Array.isArray(raw.path) ? raw.path.filter((h): h is string => typeof h === 'string' && !!h) : [];
  const pages: Record<string, PageLanding> = {};
  if (isObj(raw.pages)) {
    for (const [k, v] of Object.entries(raw.pages)) {
      if (!isObj(v) || typeof v.scrollTop !== 'number' || !Number.isFinite(v.scrollTop)) continue;
      pages[k] = {
        scrollTop: v.scrollTop,
        ...(typeof v.sentenceTop === 'number' && Number.isFinite(v.sentenceTop) ? { sentenceTop: v.sentenceTop } : {}),
      };
    }
  }
  const lastViewedAt: Record<string, number> = {};
  if (isObj(raw.lastViewedAt)) {
    for (const [k, v] of Object.entries(raw.lastViewedAt)) {
      if (typeof v === 'number' && Number.isFinite(v)) lastViewedAt[k] = v;
    }
  }
  const drafts = Array.isArray(raw.drafts)
    ? raw.drafts.filter((d): d is ThreadPendingPage => isObj(d)
      && typeof d.pageKey === 'string' && isPendingKey(d.pageKey)
      && typeof d.parentKey === 'string' && typeof d.parentMsgId === 'string' && typeof d.title === 'string')
    : [];
  return { path, pages, lastViewedAt, drafts };
}

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem'>;

function defaultStore(): Storage | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; }
}

export function readPersistedStack(sessionId: string, store: ReadStore | undefined = defaultStore()): PersistedStack | null {
  if (!store || !sessionId) return null;
  try {
    const raw = store.getItem(`${STACK_STORAGE_PREFIX}${sessionId}`);
    return raw ? sanitizePersistedStack(JSON.parse(raw)) : null;
  } catch { return null; }
}

export function writePersistedStack(sessionId: string, state: PersistedStack, store: WriteStore | undefined = defaultStore()): void {
  if (!store || !sessionId) return;
  try { store.setItem(`${STACK_STORAGE_PREFIX}${sessionId}`, JSON.stringify(state)); } catch { /* quota or private mode */ }
}

/** Page keys (root first) as the head ids stored for them. Pending pages and
 *  the root carry no head id and are skipped. */
export function headIdsOfPath(tree: ThreadTree, path: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of path) {
    if (key === ROOT_THREAD_KEY || isPendingKey(key)) continue;
    const head = tree.byKey.get(key)?.headId;
    if (head) out.push(head);
  }
  return out;
}

/**
 * Head ids back to a page path, or null unless EVERY one still names a question
 * and each is the child of the one before it (an anchor removed, a /compact
 * rewrite, a hand-edited URL: the stack then opens at the root, silently).
 */
export function restorePath(tree: ThreadTree, headIds: readonly string[]): string[] | null {
  if (headIds.length === 0) return [ROOT_THREAD_KEY];
  const byHead = new Map<string, string>();
  for (const node of tree.threads) if (node.headId && node.key !== ROOT_THREAD_KEY) byHead.set(node.headId, node.key);
  const path = [ROOT_THREAD_KEY];
  for (const head of headIds) {
    const key = byHead.get(head);
    if (!key) return null;
    const node = tree.byKey.get(key);
    if (!node || (node.parentKey ?? ROOT_THREAD_KEY) !== path[path.length - 1]) return null;
    path.push(key);
  }
  return path;
}

/** Leaf-only restore (a URL without the session's stored path): the whole
 *  path to that head, or null when the tree does not know it. */
export function pathForLeaf(tree: ThreadTree, headId: string): string[] | null {
  for (const node of tree.threads) {
    if (node.headId !== headId || node.key === ROOT_THREAD_KEY) continue;
    const path: string[] = [];
    let cur: typeof node | undefined = node;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key);
      path.unshift(cur.key);
      cur = cur.parentKey === undefined ? undefined : tree.byKey.get(cur.parentKey);
    }
    return path[0] === ROOT_THREAD_KEY ? path : null;
  }
  return null;
}

// ── URL: the leaf head id per column, `t<n>` beside `s<n>` ──

export function threadParamName(columnIndex: number): string {
  return `t${columnIndex + 1}`;
}

/** The leaf head id the URL holds for this session's column, if any. */
export function readUrlLeaf(search: string, sessionId: string, maxColumns = 12): string | null {
  const sp = new URLSearchParams(search);
  for (let i = 0; i < maxColumns; i++) {
    if (sp.get(`s${i + 1}`) === sessionId) return sp.get(threadParamName(i)) || null;
  }
  return null;
}

const leaves = new Map<string, string>();
const leafListeners = new Set<() => void>();

/** A panel reports the head id on screen (null at the root). useUrlSync reads it. */
export function setThreadLeaf(sessionId: string, headId: string | null): void {
  if (!sessionId) return;
  const before = leaves.get(sessionId) ?? null;
  if (before === headId) return;
  if (headId) leaves.set(sessionId, headId); else leaves.delete(sessionId);
  for (const l of leafListeners) l();
}

export function getThreadLeaves(): ReadonlyMap<string, string> {
  return leaves;
}

export function subscribeThreadLeaves(listener: () => void): () => void {
  leafListeners.add(listener);
  return () => { leafListeners.delete(listener); };
}

/** `t<n>` entries for the columns whose session is on a question page. */
export function threadParamsFor(sessionColumns: readonly string[], leafMap: ReadonlyMap<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  sessionColumns.forEach((sid, i) => {
    const head = leafMap.get(sid);
    if (head) out.push([threadParamName(i), head]);
  });
  return out;
}

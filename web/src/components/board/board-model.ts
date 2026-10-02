/**
 * Pure helpers of the task Board pane (TaskBoardPane.tsx): the payload types of
 * `GET /api/v1/tasks/:id/board`, the frame document wrapper, the live task refs
 * the frame renders its `<walnut-task>` chips from, and the per-browser "seen"
 * record. No React, no DOM: unit-pinned in tests/web/task-board-model.test.ts.
 */

export type BoardAuthor = 'user' | `task:${string}`;

export interface BoardMessage {
  id: string;
  author: BoardAuthor;
  text: string;
  ts: string;
}

export interface BoardMark {
  state?: string;
  note?: string;
  updated_at: string;
}

export interface BoardDoc {
  html: string;
  version: number;
  updated_at: string;
  /** 'human' or `task:<id>`. */
  updated_by: string;
}

/** One task the html names, as the server resolved it. `ref` is the id as written (may be a prefix). */
export interface BoardRef {
  ref?: string;
  id: string;
  title: string;
  phase: string;
  status: string;
}

export interface BoardPayload {
  board: BoardDoc | null;
  threads: Record<string, BoardMessage[]>;
  marks: Record<string, BoardMark>;
  refs: BoardRef[];
}

/** What the frame reads for a task chip or a message author. */
export interface FrameTask {
  id: string;
  title: string;
  phase: string;
  status: string;
}

/** thread id → the newest message ts this browser has read. */
export type BoardSeen = Record<string, string>;

/** The minimum of a store task the board reads. */
export interface StoreTaskLike {
  id: string;
  title: string;
  phase?: string;
  status?: string;
}

// ── The frame document ──

export const BOARD_FRAME_CSP = '<meta http-equiv="Content-Security-Policy" content="'
  + "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'unsafe-inline'"
  + '">';

/** Base look for a bare fragment only: a full document chose its own styling. */
const FRAGMENT_BASE_CSS = 'body{margin:0;padding:16px 20px;'
  + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5}';

/** `<head>` or `<head attr…>`, never `<header>`. */
const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * The board html as the frame's document: CSP first, then the runtime's css,
 * then the runtime itself, all at the very top of `<head>` so the custom
 * elements are defined before the body parses (they upgrade as they appear).
 *
 * A document that has a `<head>` gets the block right after it; one with only
 * `<html>` gets a `<head>` there; a bare fragment is wrapped in a minimal
 * standards-mode document. `</script` / `</style` inside the injected sources
 * are escaped so they cannot end their own element early.
 */
/**
 * A fresh nonce per rendered document. The runtime keeps it in a closure and
 * stamps every message it sends; the host drops frame messages without it, so a
 * script the board's author wrote cannot post to a thread or set a mark as the
 * user (board-runtime.frame.js explains the rest of that boundary).
 */
export function newBoardNonce(): string {
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: (b: Uint8Array) => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); return b; } })
    .getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function wrapBoardHtml(html: string, runtimeSrc: string, runtimeCss: string, nonce = newBoardNonce()): string {
  const css = runtimeCss.replace(/<\/style/gi, '<\\/style');
  const js = runtimeSrc.replace('__WN_BOARD_NONCE__', nonce).replace(/<\/script/gi, '<\\/script');
  const block = `${BOARD_FRAME_CSP}<style id="wn-board-runtime-css">${css}</style><script>${js}</script>`;
  if (HEAD_OPEN.test(html)) return html.replace(HEAD_OPEN, (m) => `${m}${block}`);
  if (HTML_OPEN.test(html)) return html.replace(HTML_OPEN, (m) => `${m}<head>${block}</head>`);
  const doctype = DOCTYPE.exec(html);
  if (doctype) {
    return `${doctype[0]}<head>${block}</head>${html.slice(doctype[0].length)}`;
  }
  return `<!doctype html><html><head>${block}<style>${FRAGMENT_BASE_CSS}</style></head><body>${html}</body></html>`;
}

// ── Live refs ──

function frameTask(t: StoreTaskLike): FrameTask {
  return { id: t.id, title: t.title, phase: t.phase ?? '', status: t.status ?? '' };
}

/**
 * Every task the frame may need, keyed by the id as the html wrote it AND by
 * the full id: the payload's refs (live from the store when the store has the
 * row), plus `extraIds` (the board's own task, message authors) when the store
 * knows them. The store wins because it is the browser's one truth for a task
 * row; the payload's copy is the fallback for a row the store has not loaded.
 */
export function buildFrameRefs(
  payloadRefs: readonly BoardRef[],
  storeById: ReadonlyMap<string, StoreTaskLike> | null,
  extraIds: readonly string[] = [],
): Record<string, FrameTask> {
  const out: Record<string, FrameTask> = {};
  const resolved = payloadRefs.map((r) => {
    const live = storeById?.get(r.id);
    return { r, t: live ? frameTask(live) : { id: r.id, title: r.title, phase: r.phase, status: r.status } };
  });
  for (const { r, t } of resolved) out[r.id] = t;
  // The id exactly as the html wrote it wins over a full id it happens to equal.
  for (const { r, t } of resolved) if (r.ref) out[r.ref] = t;
  for (const id of extraIds) {
    if (!id || out[id]) continue;
    const live = storeById?.get(id);
    if (live) out[id] = frameTask(live);
  }
  return out;
}

/** Same keys, same four fields: the frame does not need a re-post. */
export function frameRefsEqual(a: Record<string, FrameTask>, b: Record<string, FrameTask>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    const x = a[k], y = b[k];
    if (!y || x.id !== y.id || x.title !== y.title || x.phase !== y.phase || x.status !== y.status) return false;
  }
  return true;
}

/** Task ids that wrote in any thread (`task:<id>` authors). */
export function threadAuthorIds(threads: Record<string, BoardMessage[]>): string[] {
  const ids = new Set<string>();
  for (const list of Object.values(threads)) {
    for (const m of list) if (m.author.startsWith('task:')) ids.add(m.author.slice(5));
  }
  return [...ids];
}

/** A message merged into its thread (deduped by id, kept in ts order). */
export function mergeBoardMessage(
  threads: Record<string, BoardMessage[]>,
  thread: string,
  message: BoardMessage,
): Record<string, BoardMessage[]> {
  const list = threads[thread] ?? [];
  if (list.some((m) => m.id === message.id)) return threads;
  const next = [...list, message].sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
  return { ...threads, [thread]: next };
}

// ── The top bar ──

/** Who last wrote the html, in the bar's words. */
export function boardWriterLabel(updatedBy: string, boardTaskId: string): string {
  if (updatedBy === 'human') return 'you';
  if (updatedBy === `task:${boardTaskId}`) return 'leader';
  if (updatedBy.startsWith('task:')) return 'worker';
  return updatedBy || 'unknown';
}

// ── Seen state (per browser) ──

export const BOARD_SEEN_PREFIX = 'walnut-board-seen:';

export function parseSeen(raw: string | null): BoardSeen {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: BoardSeen = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The seen record after the frame reports `ts` read in `thread`; null when nothing moves. */
export function advanceSeen(seen: BoardSeen, thread: string, ts: string): BoardSeen | null {
  if (!thread || !ts) return null;
  if ((seen[thread] ?? '') >= ts) return null;
  return { ...seen, [thread]: ts };
}

/** Only an absolute http(s) URL leaves the frame as a new tab. */
export function safeExternalHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * "@" mention entities — pure ranking logic behind the palette's Tasks group.
 *
 * The palette lists TASKS only. A session is never a separate row: every
 * session belongs to a task, so the task row carries it (status dot, "running"
 * / "waiting on you" in its meta line), and picking the row INSERTS A
 * `<task-ref/>` pill into the message. The server's reference card for a task
 * names its session and that session's status, so the receiving agent still
 * learns which session to talk to. Nothing is routed by the composer.
 *
 * Two result layers feed one list:
 *   - LOCAL: an in-memory fuzzy pass over the task list the browser already
 *     holds — zero debounce, zero network, so the first paint is instant on
 *     every keystroke;
 *   - SERVER: `/api/search` hybrid hits (full-text + vector) that arrive a
 *     beat later and RE-RANK the list: a semantic hit ("login bug" → "OAuth
 *     callback 401") lands on top even though no character matched. A hit on a
 *     session's transcript folds into the task that owns the session
 *     (hitsAsTasks), so transcript matches still find their task.
 * mergeServerHits bands them (agreed → server-only → local-only), so the list
 * only ever gets smarter and never drops a row the user could already see.
 */
import type { Task } from '@open-walnut/core';
import { resolveTaskSessionId } from '@/utils/session-status';
import { extractEntityRefs } from '@/utils/entity-ref-tags';
import type { EntitySearchHit } from '@/stores/mention-search';
import { fuzzyMatch } from './session-mention';

export interface MentionEntity {
  /** Task id. */
  id: string;
  title: string;
  /** One-line secondary text ("IN_PROGRESS · walnut · running"). */
  meta: string;
  /** Sort hints for the EMPTY query: pinned first, then a live session, then
   *  not-complete, then recency. */
  pinned?: boolean;
  live?: boolean;
  active?: boolean;
  /** Comparable recency key (ISO timestamp or any lexically ordered string). */
  recencyKey?: string;
  /** The task's session, when it has one. */
  sessionId?: string;
  /** That session's status for the dot: running / waiting / error / idle / stopped. */
  status?: string;
  /** Server search snippet — shown when the row is a semantic hit so the user
   *  sees WHY it matched even without highlighted characters. */
  summary?: string;
}

export interface RankedEntity {
  entity: MentionEntity;
  /** Matched character positions in `title` (or `id`), for highlighting. */
  positions: number[];
  matchField: 'title' | 'id' | null;
  /** Where this row came from: server-ranked, local fuzzy, or both. */
  source: 'local' | 'server' | 'both';
}

/** What the live status store knows about a task's session. */
export interface TaskLiveStatus {
  process_status?: string;
  pendingPermissionTool?: string | null;
}

/**
 * The palette's row for a task, its session folded in. `live` (the WS-fed
 * store) wins over the task's enrichment snapshot, which can be a poll old.
 */
export function taskEntity(t: Task, live?: TaskLiveStatus | null): MentionEntity {
  const sessionId = resolveTaskSessionId(t);
  const s = sessionId ? (live ?? t.session_status ?? null) : null;
  const waiting = !!s?.pendingPermissionTool;
  const status = waiting ? 'waiting' : s?.process_status;
  const liveWord = waiting ? 'waiting on you' : status === 'running' ? 'running' : '';
  return {
    id: t.id,
    title: t.title || '(untitled)',
    meta: [t.phase, t.project || 'Inbox', liveWord].filter(Boolean).join(' · '),
    pinned: !!t.pinned || t.focus_tier === 'focus',
    live: status === 'running' || waiting,
    active: t.phase !== 'COMPLETE',
    recencyKey: t.updated_at ?? '',
    ...(sessionId ? { sessionId, status: status ?? 'idle' } : {}),
  };
}

/**
 * The task a slim search hit stands for. A session row carries the id of the
 * task that OWNS the transcript in `id` and the session's own id only inside
 * `ref` (src/web/routes/search.ts); the two are equal exactly when no task owns
 * the session, and such a session has no row in a tasks-only palette.
 */
export function taskIdOfHit(h: EntitySearchHit): string | null {
  if (h.type === 'task') return h.id || null;
  if (h.type !== 'session') return null;
  const ref = h.ref ? extractEntityRefs(h.ref)[0] : undefined;
  if (ref && ref.kind === 'session' && ref.id === h.id) return null;
  return h.id || null;
}

/** The session id a session hit names, when its ref carries one. */
function sessionIdOfHit(h: EntitySearchHit): string | null {
  if (h.type !== 'session' || !h.ref) return null;
  const ref = extractEntityRefs(h.ref)[0];
  return ref && ref.kind === 'session' ? ref.id : null;
}

/**
 * Server hits as task entities, in server order, one row per task: a task hit
 * and a hit on its session's transcript collapse into one row (the first wins
 * the position, a task hit's phase/project and the local row's live meta win
 * the content). A local row for the task, when the browser holds one, lends
 * its meta and session so the folded row looks like its neighbours. The task
 * the user is already talking from (`self`: its id, and its session's id for a
 * transcript hit) is never offered.
 */
export function hitsAsTasks(
  hits: EntitySearchHit[],
  local: Map<string, MentionEntity>,
  self: { taskId?: string | null; sessionId?: string | null } = {},
): MentionEntity[] {
  const byId = new Map<string, MentionEntity>();
  for (const h of hits) {
    const taskId = taskIdOfHit(h);
    if (!taskId || taskId === self.taskId) continue;
    if (self.sessionId && sessionIdOfHit(h) === self.sessionId) continue;
    const known = local.get(taskId);
    const seen = byId.get(taskId);
    if (seen) {
      // A task hit arriving after its session hit still owns the row's text.
      if (h.type === 'task' && !known) {
        byId.set(taskId, { ...seen, title: h.title || seen.title, meta: hitMeta(h), summary: seen.summary ?? h.summary });
      }
      continue;
    }
    byId.set(taskId, known
      ? { ...known, summary: h.summary }
      : {
        id: taskId,
        title: h.title || '(untitled)',
        meta: hitMeta(h),
        active: h.phase !== 'COMPLETE',
        summary: h.summary,
      });
  }
  return [...byId.values()];
}

function hitMeta(h: EntitySearchHit): string {
  return `${h.phase ?? 'task'} · ${h.project || 'Inbox'}`;
}

function byHints(a: MentionEntity, b: MentionEntity): number {
  return (
    Number(!!b.pinned) - Number(!!a.pinned) ||
    Number(!!b.live) - Number(!!a.live) ||
    Number(!!b.active) - Number(!!a.active) ||
    (b.recencyKey ?? '').localeCompare(a.recencyKey ?? '')
  );
}

/**
 * Rank the in-memory entities against the typed query.
 * Empty query → most useful first (pinned, live, active, recent). Non-empty →
 * best fuzzy score over title (preferred) or id wins; matched positions come
 * back for highlighting.
 */
export function rankEntities(
  query: string,
  items: MentionEntity[],
  opts: { limit?: number } = {},
): RankedEntity[] {
  const limit = opts.limit ?? 12;
  const q = query.trim();
  if (!q) {
    return [...items]
      .sort(byHints)
      .slice(0, limit)
      .map((entity) => ({ entity, positions: [], matchField: null, source: 'local' as const }));
  }
  const hits: Array<RankedEntity & { score: number }> = [];
  for (const entity of items) {
    const fields: Array<['title' | 'id', string, number]> = [
      ['title', entity.title, 2],
      ['id', entity.id, 1],
    ];
    let best: (RankedEntity & { score: number }) | null = null;
    for (const [field, text, bias] of fields) {
      if (!text) continue;
      const m = fuzzyMatch(q, text);
      if (!m) continue;
      const scored = { entity, matchField: field, positions: m.positions, source: 'local' as const, score: m.score * 4 + bias };
      if (!best || scored.score > best.score) best = scored;
    }
    if (best) hits.push(best);
  }
  return hits
    .sort((a, b) => b.score - a.score || byHints(a.entity, b.entity))
    .slice(0, limit)
    .map(({ entity, positions, matchField, source }) => ({ entity, positions, matchField, source }));
}

/**
 * Fold the server's ranked hits into the local list, in three bands: rows
 * BOTH layers returned (local order — two rankers agree, and the characters
 * the user typed are the stronger signal about what they meant), then
 * server-only rows (the semantic ranking the local pass can't produce), then
 * local-only fuzzy stragglers. Bands, not a plain server-first order, because
 * a tight row budget let a loosely related server row push the exact title the
 * user was typing out of sight the moment the search answered.
 *
 * A row present in both keeps its local highlight positions and is marked
 * 'both'; a server-only row gets positions from a fuzzy pass over its title
 * when one exists (a keyword hit) and none when it is a purely semantic match
 * (the summary then explains it).
 */
export function mergeServerHits(
  query: string,
  local: RankedEntity[],
  server: MentionEntity[],
): RankedEntity[] {
  if (server.length === 0) return local;
  const q = query.trim();
  const serverById = new Map(server.map((e) => [e.id, e]));
  const agreed: RankedEntity[] = [];
  const localOnly: RankedEntity[] = [];
  for (const r of local) {
    const hit = serverById.get(r.entity.id);
    if (hit) {
      // The server row may carry a fresher summary; the local row carries live
      // status/meta — keep both.
      agreed.push({ ...r, entity: { ...r.entity, summary: hit.summary ?? r.entity.summary }, source: 'both' });
    } else {
      localOnly.push(r);
    }
  }
  const localIds = new Set(local.map((r) => r.entity.id));
  const serverOnly: RankedEntity[] = [];
  const seen = new Set<string>();
  for (const entity of server) {
    if (seen.has(entity.id) || localIds.has(entity.id)) continue;
    seen.add(entity.id);
    const m = q ? fuzzyMatch(q, entity.title) : null;
    serverOnly.push({ entity, positions: m ? m.positions : [], matchField: m ? 'title' : null, source: 'server' });
  }
  return [...agreed, ...serverOnly, ...localOnly];
}

/**
 * How many rows each group may show so that BOTH groups (Tasks, Files) are
 * visible at once: a group alone gets the whole panel; with both showing, each
 * gets half.
 *
 * Sized against the list's 560px ceiling with REAL row heights: a task row is
 * two lines (~48px), a file row one (~32px), a group head ~26px, so two groups
 * = 5×48 + 5×32 + 2×26 = 452. Over the ceiling the last group scrolls out of
 * sight, which is the one thing this budget must prevent.
 */
export function groupRowBudget(nonEmptyGroups: number): { entity: number; files: number } {
  if (nonEmptyGroups <= 1) return { entity: 12, files: 12 };
  return { entity: 5, files: 5 };
}

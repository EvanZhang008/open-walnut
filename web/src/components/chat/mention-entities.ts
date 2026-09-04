/**
 * "@" mention entities — pure ranking logic shared by the palette's Tasks,
 * Sessions and Projects groups.
 *
 * Picking an entity INSERTS A REFERENCE (a `<task-ref/>` / `<session-ref/>` /
 * `<project-ref/>` pill) into the message; it never routes the message
 * anywhere. The message still goes to the current session, whose agent decides
 * what to do with the reference (read the task, message the session, …).
 *
 * Two result layers feed one list:
 *   - LOCAL: an in-memory fuzzy pass over what the browser already holds
 *     (task list, session index, project registry) — zero debounce, zero
 *     network, so the first paint is instant on every keystroke;
 *   - SERVER: `/api/search` hybrid hits (full-text + vector) that arrive a
 *     beat later and RE-RANK the list: a semantic hit ("login bug" → "OAuth
 *     callback 401") lands on top even though no character matched.
 * mergeServerHits bands them (agreed → server-only → local-only), so the list
 * only ever gets smarter and never drops a row the user could already see.
 */
import { fuzzyMatch } from './session-mention';

export type MentionEntityKind = 'task' | 'session' | 'project';

export interface MentionEntity {
  kind: MentionEntityKind;
  /** Task id / session id / project name (a project's identity IS its name). */
  id: string;
  title: string;
  /** One-line secondary text ("IN_PROGRESS · walnut", "local · running · 2m ago"). */
  meta: string;
  /** Sort hints for the EMPTY query: pinned first, then active, then recency. */
  pinned?: boolean;
  active?: boolean;
  /** Comparable recency key (ISO timestamp or any lexically ordered string). */
  recencyKey?: string;
  /** Session process status, for the status dot. */
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

function byHints(a: MentionEntity, b: MentionEntity): number {
  return (
    Number(!!b.pinned) - Number(!!a.pinned) ||
    Number(!!b.active) - Number(!!a.active) ||
    (b.recencyKey ?? '').localeCompare(a.recencyKey ?? '')
  );
}

/**
 * Rank the in-memory entities of ONE kind against the typed query.
 * Empty query → most useful first (pinned, active, recent). Non-empty → best
 * fuzzy score over title (preferred) or id wins; matched positions come back
 * for highlighting.
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
      ['id', entity.kind === 'session' ? entity.id.slice(0, 8) : entity.id, 1],
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
 * Fold the server's ranked hits (same kind) into the local list, in three
 * bands: rows BOTH layers returned (local order — two rankers agree, and the
 * characters the user typed are the stronger signal about what they meant),
 * then server-only rows (the semantic ranking the local pass can't produce),
 * then local-only fuzzy stragglers. Bands, not a plain server-first order,
 * because a tight row budget (two per group when four groups show) let a
 * loosely related server row push the exact title the user was typing out of
 * sight the moment the search answered.
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
  const serverByKey = new Map(server.map((e) => [`${e.kind}:${e.id}`, e]));
  const agreed: RankedEntity[] = [];
  const localOnly: RankedEntity[] = [];
  for (const r of local) {
    const hit = serverByKey.get(`${r.entity.kind}:${r.entity.id}`);
    if (hit) {
      // The server row may carry a fresher summary; the local row carries live
      // status/meta — keep both.
      agreed.push({ ...r, entity: { ...r.entity, summary: hit.summary ?? r.entity.summary }, source: 'both' });
    } else {
      localOnly.push(r);
    }
  }
  const localKeys = new Set(local.map((r) => `${r.entity.kind}:${r.entity.id}`));
  const serverOnly: RankedEntity[] = [];
  const seen = new Set<string>();
  for (const entity of server) {
    const key = `${entity.kind}:${entity.id}`;
    if (seen.has(key) || localKeys.has(key)) continue;
    seen.add(key);
    const m = q ? fuzzyMatch(q, entity.title) : null;
    serverOnly.push({ entity, positions: m ? m.positions : [], matchField: m ? 'title' : null, source: 'server' });
  }
  return [...agreed, ...serverOnly, ...localOnly];
}

/**
 * How many rows each group may show so that EVERY non-empty group is visible
 * at once (the "half-half" rule, generalized): a group alone gets the whole
 * panel; the more groups have something to show, the fewer rows each gets.
 *
 * Sized against the list's 560px ceiling with REAL row heights: an entity row
 * is two lines (~48px), a file row one (~32px), a group head ~26px. Worst case
 * per branch: 2 groups = 5×48 + 5×32 + 2×26 = 452; 3 groups = 3×(26 + 3×48) =
 * 510; 4 groups = 3×(26 + 2×48) + 26 + 3×32 = 488. Over the ceiling the last
 * group scrolls out of sight, which is the one thing this budget must prevent.
 */
export function groupRowBudget(nonEmptyGroups: number): { entity: number; files: number } {
  if (nonEmptyGroups <= 1) return { entity: 12, files: 12 };
  if (nonEmptyGroups === 2) return { entity: 5, files: 5 };
  if (nonEmptyGroups === 3) return { entity: 3, files: 4 };
  return { entity: 2, files: 3 };
}

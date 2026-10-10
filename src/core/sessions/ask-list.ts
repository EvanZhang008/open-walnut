/**
 * The asks list: which tasks are an agent's asks, in what order, under which
 * title, and in which state. ONE definition, read by three places:
 *   - the web console's Ask Walnut drawer (through the `@open-walnut/ask-list`
 *     alias, over its live task store),
 *   - `GET /api/v1/asks` (src/web/routes/asks-v1.ts, over the server's store),
 *   - so the phone, which renders whatever that endpoint answers.
 *
 * Pure on purpose: no node imports, no I/O, so the browser bundles this exact
 * file and the server serves the same answer for the same rows. Before it, the
 * drawer sorted by BIRTH (`created_at`) while it printed the last-touch stamp
 * (`updated_at`), so an old ask continued yesterday read "1d ago" in the middle
 * of the "1w ago" rows; and the phone listed a different store altogether.
 *
 * The rules, each with the reason it is that and not the obvious alternative:
 *
 *  - MEMBERSHIP: born the agent's ask (`walnut_agent` + its `agent_id` stamp,
 *    no stamp = Walnut, wherever it has since been filed) OR filed under the
 *    agent's `Ask <name>` project now (user, 2026-09-07). Moving an ask to a
 *    project must not make the conversation vanish, and dragging a task into
 *    the project makes it reachable from the chat.
 *  - ORDER: most recent conversation activity first, and the stamp a row
 *    PRINTS is the stamp it SORTS by, so the times read in order down a fresh
 *    list. While the web drawer is open it holds rows in place (`holdOrder`), so
 *    it also holds what they print: each row keeps the stamp it had when the list
 *    first appeared, and a row that came since reads "New" (`printedStamp`). A
 *    live stamp under a held order would put "just now" under "5mo ago".
 *    Activity is `last_session_update` (set only when a message is sent into the
 *    task's session: start, resume, send), never `updated_at`, which any field
 *    edit moves: a bulk re-file stamped eight asks with one minute on the real
 *    board, and title drift renames a task without anyone talking to it.
 *    Streaming does not move it either, so an answering ask does not climb.
 *    A task whose activity predates its birth (an imported session) uses its
 *    birth. Ties: newer birth first, then the id, compared by code unit so
 *    every runtime (V8, JavaScriptCore, Swift) agrees.
 *  - TITLE: the task's title, or the agent's project name while it has none
 *    (the same placeholder the launch writes before auto-titling names it).
 *  - STATE: the board's circle meaning, so a dot reads the same everywhere:
 *    done (COMPLETE), running (its session is running a turn), idle (a session
 *    is attached and not running), todo (no session yet).
 */

/** The Personal AI's agent id. Its asks carry no `agent_id` stamp. */
export const GENERAL_AGENT_ID = 'general';

/** The general agent's project. */
export const ASK_WALNUT_PROJECT = 'Ask Walnut';

export interface AskAgentRef {
  id: string;
  name: string;
}

/** An agent as the list sees it: identity plus the project its asks file under. */
export interface AskListAgent {
  id: string;
  project: string;
}

/** The fields the rules read. `Task`, the slim list row and a test literal all
 *  satisfy it, so neither side has to convert before asking. */
export interface AskTaskLike {
  id: string;
  title?: string;
  project?: string;
  status?: string;
  phase?: string;
  created_at?: string;
  last_session_update?: string;
  walnut_agent?: boolean;
  agent_id?: string;
  unread?: boolean;
  session_id?: string;
  exec_session_id?: string;
  plan_session_id?: string;
  session_ids?: readonly string[];
  session_status?: { process_status?: string } | null;
}

export type AskState = 'running' | 'idle' | 'done' | 'todo';

/** One row of `GET /api/v1/asks`. Additive fields only, ever. */
export interface AskRow {
  /** The task id. */
  id: string;
  title: string;
  state: AskState;
  /** The ISO stamp the row sorts by and prints ("2d ago"). */
  activityAt: string;
  createdAt: string;
  /** The session the conversation opens, when it has one. */
  sessionId?: string;
  phase?: string;
  unread?: boolean;
  /** Set by GET /api/v1/asks when the ask is a chat (lane-ask-link.ts): the
   *  conversation it was written in. */
  conversationId?: string;
}

/**
 * The project an agent's asks are filed under.
 *
 * A project name becomes a directory segment (assertValidProjectName in
 * task-manager), and an agent's display name is free text, so the name is
 * folded to what the gate accepts: separators and `..` are not allowed and the
 * length is capped; the id stands in for a name that folds to nothing. The
 * leading "Ask " already rules out the hidden-directory and reserved-key cases.
 */
export function askProjectFor(agent: AskAgentRef): string {
  if (agent.id === GENERAL_AGENT_ID) return ASK_WALNUT_PROJECT;
  return `Ask ${projectSafeName(agent.name) || projectSafeName(agent.id) || 'agent'}`;
}

function projectSafeName(raw: string): string {
  return raw
    .replace(/[/\\\0]/g, '-')
    .replace(/\.{2,}/g, '.')
    .trim()
    .slice(0, 60)
    .trim();
}

/** Project names compare case-insensitively and ignore surrounding whitespace:
 *  the registry keeps the user's casing, and a task moved by hand may carry
 *  either. */
function sameProject(a: string | undefined, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether a task belongs to an agent's list (see MEMBERSHIP above). */
export function isAskOf(task: AskTaskLike, agent: AskListAgent): boolean {
  if (task.walnut_agent === true && (task.agent_id || GENERAL_AGENT_ID) === agent.id) return true;
  return sameProject(task.project, agent.project);
}

/** ISO to ms; an unparseable or absent stamp is NaN. */
function ms(iso: string | undefined): number {
  return Date.parse(iso ?? '');
}

/**
 * The stamp a row sorts by and prints: the later of its last conversation
 * activity and its birth. Undefined only when the task has neither (a broken
 * row), which sorts last.
 */
export function askActivityAt(task: AskTaskLike): string | undefined {
  const touched = ms(task.last_session_update);
  const born = ms(task.created_at);
  if (Number.isNaN(touched)) return Number.isNaN(born) ? undefined : task.created_at;
  if (Number.isNaN(born)) return task.last_session_update;
  return touched >= born ? task.last_session_update : task.created_at;
}

/** Descending on a stamp, with an absent one LAST (never NaN into the sort). */
function newerFirst(a: string | undefined, b: string | undefined): number {
  const x = ms(a);
  const y = ms(b);
  const xa = Number.isNaN(x);
  const ya = Number.isNaN(y);
  if (xa || ya) return xa === ya ? 0 : xa ? 1 : -1;
  return y - x;
}

/** The list order (see ORDER above). A total order: two distinct tasks never
 *  compare equal, so a refetch can never swap them. */
export function compareAsks(a: AskTaskLike, b: AskTaskLike): number {
  return newerFirst(askActivityAt(a), askActivityAt(b))
    || newerFirst(a.created_at, b.created_at)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every ask of ONE agent, in list order. Never mutates the input (on the web
 *  it is the shared task store's array). */
export function selectAsks<T extends AskTaskLike>(tasks: readonly T[], agent: AskListAgent): T[] {
  return tasks.filter((t) => isAskOf(t, agent)).sort(compareAsks);
}

/** The row's title (see TITLE above). */
export function askTitle(task: AskTaskLike, agent: AskListAgent): string {
  return task.title?.trim() || agent.project;
}

/** The session a task's conversation opens: the single slot, then the exec and
 *  plan slots, then the newest legacy entry. Same precedence as the web's
 *  `resolveTaskSessionId` (utils/session-status.ts; a test pins the two). */
export function askSessionId(task: AskTaskLike): string | null {
  return task.session_id
    || task.exec_session_id
    || task.plan_session_id
    || (task.session_ids?.length ? task.session_ids[task.session_ids.length - 1] : null)
    || null;
}

/**
 * The row's state (see STATE above). `live` is a fresher process status than
 * the task's own enrichment snapshot (the web's session-status store); the
 * server passes nothing and reads the snapshot its list was enriched with.
 * Same answer as the board's `taskCircleClass` for the same inputs.
 */
export function askState(
  task: AskTaskLike,
  live?: { process_status?: string } | null,
): AskState {
  if (task.status === 'done' || task.phase === 'COMPLETE') return 'done';
  if (!askSessionId(task)) return 'todo';
  const status = live ?? task.session_status ?? null;
  return status?.process_status === 'running' ? 'running' : 'idle';
}

/** Case-insensitive "every word of the query appears in the title", so
 *  `deploy ios` finds "iOS build 73 deploy". A blank query matches all. */
export function matchesAskQuery(title: string, query: string): boolean {
  const hay = title.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function toAskRow(task: AskTaskLike, agent: AskListAgent): AskRow {
  const sessionId = askSessionId(task);
  return {
    id: task.id,
    title: askTitle(task, agent),
    state: askState(task),
    activityAt: askActivityAt(task) ?? '',
    createdAt: task.created_at ?? '',
    ...(sessionId ? { sessionId } : {}),
    ...(task.phase ? { phase: task.phase } : {}),
    ...(task.unread ? { unread: true } : {}),
  };
}

/**
 * The whole list for one agent: membership, order, then the search filter on
 * the title the row shows. `total` counts the matches before `limit`, so a
 * capped answer is detectable.
 */
export function buildAskList(
  tasks: readonly AskTaskLike[],
  agent: AskListAgent,
  opts: { query?: string; limit?: number } = {},
): { total: number; asks: AskRow[] } {
  const query = opts.query?.trim() ?? '';
  const rows = selectAsks(tasks, agent)
    .map((t) => toAskRow(t, agent))
    .filter((r) => !query || matchesAskQuery(r.title, query));
  const limit = opts.limit ?? rows.length;
  return { total: rows.length, asks: rows.slice(0, Math.max(0, limit)) };
}

/**
 * The drawer's order while it is OPEN: rows keep the places they had when it
 * opened, so nothing moves under the cursor when a background ask gets a
 * message. A row that was not there at open time joins at the END (joining at
 * the top would shift every row under the cursor just the same); a row that
 * went away is simply gone. The next open shows the true order.
 */
export function holdOrder<T extends { id: string }>(rows: readonly T[], openedWith: readonly string[]): T[] {
  const place = new Map(openedWith.map((id, i) => [id, i] as const));
  const kept = rows.filter((r) => place.has(r.id)).sort((a, b) => place.get(a.id)! - place.get(b.id)!);
  const joined = rows.filter((r) => !place.has(r.id));
  return [...kept, ...joined];
}

/** One agent's list as the drawer first showed it in this open: the ids in
 *  their places, and the stamp each row printed then. A row that printed none
 *  (the just-launched ask before the store carried it) has no entry. */
export interface HeldList {
  ids: readonly string[];
  stamps: ReadonlyMap<string, string>;
}

/** Every list the drawer has shown in this open, one per agent. */
export interface HeldOrder {
  byAgent: ReadonlyMap<string, HeldList>;
}

/** A drawer row as the snapshot reads it: its id and its live stamp. */
export interface HeldRowView {
  id: string;
  activityAt?: string;
}

/**
 * Advance the drawer's open-time snapshots by one render.
 *
 * A snapshot is what the user SAW when an agent's list first appeared, so it
 * is not taken until there is a list to see: while the task list is still
 * loading, or holds no rows yet, there is nothing to hold, and the rows follow
 * the live order. Taking it on the opening frame instead captured an empty list
 * whenever the drawer opened before the board arrived, so every row counted as
 * "new" and followed the live order for that whole open: continuing the oldest
 * ask moved it from the bottom to the top under the user's cursor.
 *
 * ONE snapshot per agent for the whole open: switching Walnut, Mentor, Walnut
 * shows Walnut's list exactly as it was the first time, because nothing moves
 * while the drawer is open. Closed: no snapshots; the next open takes fresh
 * ones, in the true order with the real times. An agent that already has one
 * returns `prev` itself (same object, so a memo keyed on it holds).
 */
export function nextHeldOrder(
  prev: HeldOrder | null,
  view: { open: boolean; agentId: string; rows: readonly HeldRowView[]; loading: boolean },
): HeldOrder | null {
  if (!view.open) return null;
  if (prev?.byAgent.has(view.agentId)) return prev;
  if (view.loading || view.rows.length === 0) return prev;
  const stamps = new Map<string, string>();
  for (const r of view.rows) if (r.activityAt) stamps.set(r.id, r.activityAt);
  const byAgent = new Map(prev?.byAgent ?? []);
  byAgent.set(view.agentId, { ids: view.rows.map((r) => r.id), stamps });
  return { byAgent };
}

/** What a drawer row prints: a time, the "New" mark, or nothing. */
export type PrintedStamp = { kind: 'time'; at: string } | { kind: 'new' } | { kind: 'none' };

/**
 * What a row prints (see ORDER above). Without a snapshot, its live stamp. With
 * one, the stamp it had in the snapshot, so a held row continued since keeps
 * its old time and the list still reads in order; a row with no stamp there
 * (it came after the snapshot, or it was the just-launched ask that had none
 * yet) reads "New", which is true and never out of order.
 */
export function printedStamp(held: HeldList | undefined, row: HeldRowView): PrintedStamp {
  if (!held) return row.activityAt ? { kind: 'time', at: row.activityAt } : { kind: 'none' };
  const at = held.stamps.get(row.id);
  return at ? { kind: 'time', at } : { kind: 'new' };
}

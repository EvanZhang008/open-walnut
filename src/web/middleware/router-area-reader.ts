// Area read isolation for sessions and automated callers: one named area object is refused before
// its route reads it, and list rows of other areas are removed. A person (no caller header) passes.
import type { Request, Response, NextFunction } from 'express';
import { WALNUT_HOME } from '../../constants.js';
import { readRouterAreas, taskArea, type RouterAreaItem, type RouterAreasFile } from '../../core/router/areas.js';
import { pendingRuleAreas, readPendingRuleMatches, type PendingRuleMatch } from '../../core/router/rules.js';
import { resolveRouterItem } from '../../core/router/source-registry.js';
import { mailRouterKey } from '../../integrations/mail/router-source.js';
import type { SessionRecord, Task } from '../../core/types.js';
import { orgNodesAbove, orgPlaces, type FollowTask } from '../../core/org/thread-follow.js';

const VISIBILITY_NOTE = 'Incoming-item area isolation is active. Rows and counts include only work this caller may read.';
const TASK_PAGE = 'walnutAreaTaskPage';

/** The adapter key an item was classified under (optional: older registries have none). */
const keyOf = (item: RouterAreaItem): string => {
  const key = (item as RouterAreaItem & { canonicalKey?: unknown }).canonicalKey;
  return typeof key === 'string' ? key : '';
};

/** A router task with no area anywhere: a scope no caller ever holds. */
const NO_AREA_ROUTER = '\u0000router-without-area';
/** A mail that only shares a confirmed item's key: it restricts, and no caller holds this scope, so nobody gets its body. */
const UNCONFIRMED_COPY = '\u0000mail-copy-not-confirmed';

const FORBIDDEN = { error: 'This session may not read work of another incoming-item area.', code: 'area_forbidden' } as const;
const UNVERIFIABLE = { error: 'The incoming-item area of this request cannot be checked, so it is not served.', code: 'area_unverifiable' } as const;

// Matches the mail surface's bounds without importing its full module graph.
const MAIL_OP_MAX_IDS = 25;
const MAIL_ID_MAX = 1000;
const MAIL_ACCOUNT_MAX = 320;

/** A mail op's input the area check will not look up; the middleware answers it 400. */
export class AreaBadInput extends Error {
  readonly code = 'area_bad_request';
}

export type AreaScopes = ReadonlySet<string>;

/** Target outside every area, or caller and target both in exactly the same one area. */
export function scopeAllows(caller: AreaScopes, target: AreaScopes): boolean {
  if (target.size === 0) return true;
  if (caller.size !== 1 || target.size !== 1) return false;
  const [c] = caller;
  const [t] = target;
  return c === t && c !== NO_AREA_ROUTER;
}

export type ScopedTask = Pick<Task, 'id'> & { router_area_id?: string | null; org_role?: string | null }
  & Partial<Pick<FollowTask, 'title' | 'parent_task_id' | 'project' | 'org_leads' | 'phase' | 'status' | 'created_at' | 'org_name'>>;

/** Reuse the org's reporting chain, not project-name guesses or a blanket role bypass.
 * An area-scoped caller never acquires broader reads from a stale org role. */
async function supervisedTasks(caller: AreaCaller, scopes: AreaScopes, tasks: readonly ScopedTask[], file: RouterAreasFile): Promise<Set<string>> {
  if (!('sid' in caller) || scopes.size) return new Set();
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js');
  const record = await getSessionByClaudeId(caller.sid);
  const me = tasks.find((t) => t.id === record?.taskId);
  if (!me || me.phase === 'COMPLETE' || (me.org_role !== 'main' && me.org_role !== 'lead')) return new Set();
  const places = orgPlaces(tasks as readonly FollowTask[]);
  // Routers process the original incoming item; their own notes and transcripts
  // are not the downstream work a supervisor follows.
  const routers = new Set(file.routers.map((r) => r.taskId));
  return new Set(tasks.filter((t) => t.org_role !== 'router' && !routers.has(t.id)
    && orgNodesAbove(t as FollowTask, places).has(me.id)).map((t) => t.id));
}

/** Every scope a task carries: its mark, its registry area, its router assignment. */
export function taskScopes(task: ScopedTask, file: RouterAreasFile | undefined, out = new Set<string>()): Set<string> {
  let found = false;
  const add = (s: string | undefined) => { if (s) { out.add(s); found = true; } };
  add(typeof task.router_area_id === 'string' ? task.router_area_id.trim() : '');
  if (file) {
    add(taskArea(file, task.id)?.id);
    for (const r of file.routers) if (r.taskId === task.id) add(r.areaId);
  }
  if (!found && task.org_role === 'router') out.add(NO_AREA_ROUTER);
  return out;
}

const profileArea = (record: Pick<SessionRecord, 'profile'> | null | undefined): string =>
  typeof record?.profile?.areaId === 'string' ? record.profile.areaId.trim() : '';

export type AreaTarget =
  | { kind: 'task'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'letter'; id: string }
  | { kind: 'approval'; id: string }
  | { kind: 'mail'; account: string; message: string }
  | { kind: 'mail-op' };

const TASK_LITERALS = new Set(['meta', 'enriched', 'groups', 'quick-parse', 'suggest-feedback', 'suggest-accuracy',
  'bulk', 'board-counts', 'reorder', 'batch', 'folders']);
const SESSION_LITERALS = new Set(['status', 'recent', 'summaries', 'live-activity', 'mention-index', 'ask-walnut-launch',
  'git-status', 'host-model-catalogs', 'host-retry', 'import-external', 'list-dirs', 'quick-start', 'working-dirs',
  'launch-options', 'task']);
const LETTER_LITERALS = new Set(['body']);
const APPROVAL_LITERALS = new Set(['keys']);
/** Mail ops whose input names a message (`message` / `messages`, with `account`). */
const MAIL_MESSAGE_OPS = new Set(['mail_read', 'mail_thread', 'mail_mark_read', 'mail_unsubscribe_request', 'mail_draft', 'mail_request_send']);

function seg(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

const idTarget = <K extends 'task' | 'session' | 'letter' | 'approval'>(kind: K, raw: string, literals: Set<string>) =>
  literals.has(seg(raw)) ? undefined : { kind, id: seg(raw) };

/** The one area object `path` (relative to /api) names, if any. */
export function areaTargetOf(method: string, path: string): AreaTarget | undefined {
  let m = /^\/sessions\/task\/([^/]+)/.exec(path);
  if (m) return { kind: 'task', id: seg(m[1]) };
  if ((m = /^\/(?:v1\/)?tasks\/([^/]+)(?:\/|$)/.exec(path))) return idTarget('task', m[1], TASK_LITERALS);
  if ((m = /^\/(?:v1\/)?sessions\/([^/]+)(?:\/|$)/.exec(path))) return idTarget('session', m[1], SESSION_LITERALS);
  if ((m = /^\/(?:v1\/)?human-inbox\/([^/]+)(?:\/|$)/.exec(path))) return idTarget('letter', m[1], LETTER_LITERALS);
  if ((m = /^\/v1\/approvals\/([^/]+)(?:\/|$)/.exec(path))) return idTarget('approval', m[1], APPROVAL_LITERALS);
  if ((m = /^\/plugins\/mail\/messages\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path))) return { kind: 'mail', account: seg(m[1]), message: seg(m[2]) };
  m = /^\/plugin-runtime\/mail\/ops\/([a-z0-9_]+)$/.exec(path);
  if (m && method.toUpperCase() === 'POST' && MAIL_MESSAGE_OPS.has(m[1])) return { kind: 'mail-op' };
  return undefined;
}

export type RowKind = 'task' | 'session' | 'result' | 'generic' | 'mail';

/** GET answers that are filtered, with what a row of a top-level array answer is. */
const LIST_ROUTES: Array<[RegExp, RowKind]> = [
  [/^\/(?:v1\/)?tasks\/?$/, 'task'], [/^\/tasks\/(?:bulk|enriched)\/?$/, 'task'], [/^\/v1\/tasks\/enriched\/?$/, 'task'],
  [/^\/dashboard\/?$/, 'task'],
  [/^\/sessions\/?$/, 'session'], [/^\/sessions\/(?:recent|summaries|status|live-activity|mention-index)\/?$/, 'session'],
  [/^\/v1\/sessions\/?$/, 'session'], [/^\/v1\/sessions\/(?:recent|summaries)\/?$/, 'session'],
  [/^\/search(?:\/agent)?\/?$/, 'result'], [/^\/v1\/search\/?$/, 'result'],
  [/^\/(?:v1\/)?human-inbox\/?$/, 'generic'], [/^\/v1\/approvals\/?$/, 'generic'],
  [/^\/plugins\/mail\/(?:messages|search)\/?$/, 'mail'],
];

/** The row kind of a filtered list route, or undefined when the route is not filtered. */
export function areaListKindOf(method: string, path: string): RowKind | undefined {
  if (method.toUpperCase() !== 'GET') return undefined;
  return LIST_ROUTES.find(([re]) => re.test(path))?.[1];
}

export function isAreaListPath(method: string, path: string): boolean {
  return areaListKindOf(method, path) !== undefined;
}

export interface AreaDenials {
  tasks: ReadonlySet<string>;
  sessions: ReadonlySet<string>;
  /** `key`: the row's adapter key (mailRouterKey), so an unledgered copy of a classified RFC message matches. */
  mail(account: string, message: string, key?: string, version?: string, sender?: string, subject?: string): boolean;
  /** The judged snapshot: a task or session row outside it (made or marked after it) is left out until the next read. */
  knownTasks?: ReadonlySet<string>;
  knownSessions?: ReadonlySet<string>;
  supervisedTasks?: ReadonlySet<string>;
  supervisedSessions?: ReadonlySet<string>;
}

/** Top-level keys whose array rows are filtered, by what a row's own `id` means. */
export const AREA_LIST_KEYS: Readonly<Record<string, RowKind>> = {
  tasks: 'task', urgent_tasks: 'task', today_tasks: 'task', recent_tasks: 'task',
  // `recent_sessions` (dashboard) are session records; `summaries` are summary files, keyed by slug.
  sessions: 'session', recent_sessions: 'session', summaries: 'generic',
  results: 'result', hits: 'result',
  letters: 'generic', approvals: 'generic',
  messages: 'mail',
};
const AREA_DICT_KEYS: Readonly<Record<string, 'task' | 'session'>> = { byTask: 'task', statuses: 'session' };
/** A denied one of these turns the whole answer into a 403. */
const AREA_SINGLE_KEYS: Readonly<Record<string, RowKind>> = {
  task: 'task', session: 'session', letter: 'generic', approval: 'generic', message: 'mail',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Whether one row names a denied task, session or mail message. */
export function rowDenied(row: unknown, kind: RowKind, d: AreaDenials): boolean {
  const r = obj(row);
  if (!r) return false;
  const task = (v: unknown) => !!str(v) && d.tasks.has(str(v));
  const session = (v: unknown) => !!str(v) && d.sessions.has(str(v));
  const newTask = (v: string) => !!v && !!d.knownTasks && !d.knownTasks.has(v);
  const newSession = (v: string) => !!v && !!d.knownSessions && !d.knownSessions.has(v);
  // A bulk read's per-id error row (`{ id, error }`) carries no task data.
  const errorOnly = typeof r.error === 'string' && Object.keys(r).every((k) => k === 'id' || k === 'error');
  if (!errorOnly) {
    if (kind === 'task' && newTask(str(r.id))) return true;
    if (kind === 'session' && newSession(str(r.claudeSessionId) || str(r.id))) return true;
    if (kind === 'result' && (newTask(str(r.taskId) || (r.type === 'task' ? str(r.id) : ''))
      || newSession(str(r.sessionId) || (r.type === 'session' ? str(r.id) : '')))) return true;
  }
  if (task(r.taskId) || task(r.task_id) || task(r.legacyTaskId) || task(obj(r.task)?.id)) return true;
  if ((session(r.sessionId) || session(r.session_id) || session(r.claudeSessionId))
    && !(kind === 'task' && d.supervisedTasks?.has(str(r.id)))) return true;
  for (const who of [obj(r.sender), obj(r.requester), obj(r.answeredBy), obj(r.awayThread)]) {
    if (who && (task(who.taskId) || session(who.sessionId))) return true;
  }
  if (Array.isArray(r.task_ids) && r.task_ids.some(task)) return true;
  if (kind === 'task' && task(r.id)) return true;
  if (kind === 'session' && session(r.id)) return true;
  // Search rows: `id` is the task id or session id by `type` (slim shape); memory rows carry a path.
  if (kind === 'result' && ((r.type === 'task' && task(r.id)) || (r.type === 'session' && session(r.id)))) return true;
  const account = str(r.accountId);
  const message = str(r.messageId);
  if (kind !== 'mail' || !account || !message) return false;
  const version = typeof r.deliveryVersion === 'string' && r.deliveryVersion ? r.deliveryVersion : undefined;
  // `from` is the DTO's address object (or a plain string): its address is the row's from_addr.
  const sender = typeof r.from === 'string' ? r.from : str(obj(r.from)?.address);
  return d.mail(account, message, mailRouterKey(account, message, str(r.rfcMessageId)), version,
    sender || undefined, typeof r.subject === 'string' ? r.subject : undefined);
}

/** Supervised work stays a task row, but its isolated transcript references never leak. */
function redactTaskSessions(row: unknown, d: AreaDenials): unknown {
  const r = obj(row);
  if (!r || !d.supervisedTasks?.has(str(r.id))) return row;
  const out = { ...r };
  let changed = false;
  for (const [key, status] of [['session_id', 'session_status'], ['plan_session_id', 'plan_session_status'],
    ['exec_session_id', 'exec_session_status'], ['sessionId', 'session_status'], ['claudeSessionId', 'session_status']]) {
    const id = str(out[key]);
    if (id && (d.sessions.has(id) || (d.knownSessions && !d.knownSessions.has(id)))) {
      delete out[key]; delete out[status]; changed = true;
    }
  }
  if (Array.isArray(r.session_ids)) {
    const ids = r.session_ids.filter((id) => !d.sessions.has(str(id)) && (!d.knownSessions || d.knownSessions.has(str(id))));
    if (ids.length !== r.session_ids.length) { out.session_ids = ids; changed = true; }
  }
  return changed ? out : row;
}

/** Rows of denied areas removed (never mutating `body`); `denied` when the answer is one denied object. */
export function filterAreaPayload(body: unknown, d: AreaDenials, rootKind?: RowKind): { body: unknown; denied?: true } {
  if (Array.isArray(body)) {
    if (!rootKind) return { body };
    const kept = body.filter((row) => !rowDenied(row, rootKind, d)).map((row) => rootKind === 'task' ? redactTaskSessions(row, d) : row);
    return { body: kept.every((row, i) => row === body[i]) && kept.length === body.length ? body : kept };
  }
  const top = obj(body);
  if (!top) return { body };
  let out: Record<string, unknown> | undefined;
  const set = (key: string, value: unknown) => { (out ??= { ...top })[key] = value; };
  for (const [key, kind] of Object.entries(AREA_SINGLE_KEYS)) {
    if (obj(top[key]) && rowDenied(top[key], kind, d)) return { body: undefined, denied: true };
    if (kind === 'task') {
      const safe = redactTaskSessions(top[key], d);
      if (safe !== top[key]) set(key, safe);
    }
  }
  for (const [key, kind] of Object.entries(AREA_LIST_KEYS)) {
    const rows = top[key];
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter((row) => !rowDenied(row, kind, d)).map((row) => kind === 'task' ? redactTaskSessions(row, d) : row);
    if (kept.length !== rows.length || kept.some((row, i) => row !== rows[i])) set(key, kept);
  }
  if (rootKind === 'task' && Array.isArray(top.tasks) && typeof top.count === 'number') {
    const kept = (out?.tasks ?? top.tasks) as unknown[];
    set('count', kept.length);
    if (typeof top.errors === 'number') set('errors', kept.filter((row) => typeof obj(row)?.error === 'string').length);
  }
  // Task list routes hand us the UNLIMITED match set. Both snapshots judge this
  // same set before its count and page are produced, so a denied first page
  // cannot hide an allowed row on the next one or leave a phantom total.
  if (rootKind === 'task' && Array.isArray(top.tasks) && typeof top.total === 'number') {
    const kept = (out?.tasks ?? top.tasks) as unknown[];
    set('total', kept.length);
    set('truncated', false);
    if (typeof top.count === 'number') set('count', kept.length);
  }
  for (const [key, kind] of Object.entries(AREA_DICT_KEYS)) {
    const dict = obj(top[key]);
    if (!dict) continue;
    const ids = kind === 'task' ? d.tasks : d.sessions;
    const known = kind === 'task' ? d.knownTasks : d.knownSessions;
    const drop = (id: string) => ids.has(id) || (!!known && !known.has(id));
    if (Object.keys(dict).some(drop)) set(key, Object.fromEntries(Object.entries(dict).filter(([id]) => !drop(id))));
  }
  return { body: out ?? body };
}

const readAreas = (): Promise<RouterAreasFile | undefined> => readRouterAreas(WALNUT_HOME).catch(() => undefined);

/** Live inbound rules, read only when bindings exist; a failed read is unverifiable, never "no rules". */
const readPending = async (file: RouterAreasFile): Promise<ReadonlyArray<PendingRuleMatch> | 'unverifiable'> =>
  file.ruleBindings?.length ? readPendingRuleMatches(file).catch(() => 'unverifiable' as const) : [];

const NOT_FOUND = /^(No task found|Ambiguous ID prefix)/;

async function findTask(id: string): Promise<Task | undefined> {
  const { getTask } = await import('../../core/task-manager.js');
  try {
    return await getTask(id);
  } catch (error) {
    if (error instanceof Error && NOT_FOUND.test(error.message)) return undefined;
    throw error;
  }
}

/** A task's scopes plus the profile of every session it holds (a dropped mark still counts). */
async function fullTaskScopes(task: ScopedTask, file: RouterAreasFile | undefined, out = new Set<string>()): Promise<Set<string>> {
  taskScopes(task, file, out);
  const { getSessionsForTask } = await import('../../core/session-tracker.js');
  for (const record of await getSessionsForTask(task.id)) {
    const area = profileArea(record);
    if (area) out.add(area);
  }
  return out;
}

async function taskIdScopes(id: string, file: RouterAreasFile | undefined, out = new Set<string>()): Promise<Set<string>> {
  return fullTaskScopes((await findTask(id)) ?? { id }, file, out);
}

async function sessionScopes(record: SessionRecord, file: RouterAreasFile | undefined, out = new Set<string>()): Promise<Set<string>> {
  const area = profileArea(record);
  if (area) out.add(area);
  for (const id of new Set([record.taskId, record.legacyTaskId].filter((v): v is string => !!v))) await taskIdScopes(id, file, out);
  return out;
}

async function sessionIdScopes(sid: string, file: RouterAreasFile | undefined, out = new Set<string>()): Promise<Set<string>> {
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js');
  const record = await getSessionByClaudeId(sid);
  return record ? sessionScopes(record, file, out) : out;
}

/** Scopes of the owners an inbox letter or an approval names. */
async function ownerScopes(owners: Array<{ taskId?: string; sessionId?: string } | undefined>, file: RouterAreasFile | undefined): Promise<Set<string>> {
  const out = new Set<string>();
  for (const o of owners) {
    if (o?.taskId) await taskIdScopes(o.taskId, file, out);
    if (o?.sessionId && o.sessionId !== 'external') await sessionIdScopes(o.sessionId, file, out);
  }
  return out;
}

/**
 * One mail message's scopes, from cache metadata only (never a body): its exact registry rows (an
 * area gone or inconsistent still holds them) together with every confirmed item sharing its key,
 * so a key confirmed in two areas allows nobody. A copy with no exact row of its own also carries
 * UNCONFIRMED_COPY: it restricts, and grants no area its body. When the account holds keyed items
 * and the adapter cannot give this message's key, nothing is cleared, the exact row included.
 */
async function mailScopes(
  file: RouterAreasFile, account: string, message: string, pending: ReadonlyArray<PendingRuleMatch> = [],
): Promise<Set<string> | 'unverifiable'> {
  const classified = file.items.filter((i) => i.source.kind === 'mail' && i.source.account === account);
  if (classified.length === 0 && pending.length === 0) return new Set();
  let key: string;
  let version: string | undefined;
  let prospective: Set<string>;
  try {
    const item = await resolveRouterItem({ kind: 'mail', account, message });
    key = item.scopeKey ?? item.key;
    version = item.source.version;
    prospective = pendingRuleAreas(pending, {
      kind: 'mail', ...(item.sender ? { sender: item.sender } : {}), ...(typeof item.subject === 'string' ? { subject: item.subject } : {}),
    });
  } catch {
    return 'unverifiable';
  }
  const isMine = (i: RouterAreaItem) => i.source.message === message && (i.source.version ?? '') === (version ?? '');
  const exact = classified.filter(isMine);
  const legacy = version !== undefined ? classified.filter((i) => i.source.message === message && i.source.version === undefined) : [];
  const out = new Set([...exact, ...legacy].map((i) => i.areaId));
  if (legacy.length && exact.length === 0) out.add(UNCONFIRMED_COPY);
  const own = new Set([key, ...exact.map(keyOf).filter(Boolean)]);
  const copies = classified.filter((i) => !isMine(i) && keyOf(i) && own.has(keyOf(i))).map((i) => i.areaId);
  for (const areaId of copies) out.add(areaId);
  if (exact.length === 0 && copies.length) out.add(UNCONFIRMED_COPY);
  // A rule's area is prospective, never a grant: without the exact row nobody gets the body.
  for (const areaId of prospective) out.add(areaId);
  if (exact.length === 0 && prospective.size) out.add(UNCONFIRMED_COPY);
  return out;
}

/** The ids a mail op names, trimmed as the mail surface trims them; too many or too long throws before any lookup. */
const mailOpIds = (body: unknown): Set<string> => {
  const b = obj(body) ?? {};
  const raw: unknown[] = Array.isArray(b.messages) ? b.messages : [];
  if (raw.length > MAIL_OP_MAX_IDS) throw new AreaBadInput(`A mail op names at most ${MAIL_OP_MAX_IDS} messages; this one named ${raw.length}.`);
  const named = [str(b.message), ...raw.map(str)].map((id) => id.trim());
  if (named.some((id) => id.length > MAIL_ID_MAX)) throw new AreaBadInput(`A message id is at most ${MAIL_ID_MAX} characters.`);
  if (str(b.account).trim().length > MAIL_ACCOUNT_MAX) throw new AreaBadInput(`An account is at most ${MAIL_ACCOUNT_MAX} characters.`);
  const ids = new Set(named.filter(Boolean));
  // `message` beside 25 `messages` can still name 26: the cap is on the distinct ids too.
  if (ids.size > MAIL_OP_MAX_IDS) throw new AreaBadInput(`A mail op names at most ${MAIL_OP_MAX_IDS} messages; this one named ${ids.size}.`);
  return ids;
};

/** Each named message's own scopes, judged against one registry read; a batch is never one union. */
async function mailOpItemScopes(
  ids: Set<string>, body: unknown, file: RouterAreasFile | undefined, pending: ReadonlyArray<PendingRuleMatch> = [],
): Promise<Array<Set<string> | 'unverifiable'> | 'unverifiable'> {
  if (ids.size === 0) return [];
  if (!file) return 'unverifiable';
  // The plugin resolves `account` itself (an id, else an address, else the only account): only an
  // account id the registry names is read here.
  const account = str(obj(body)?.account).trim();
  // A live rule may capture mail of an account no area lists yet, so its account is read too.
  if (account && (pending.length > 0 || file.areas.some((a) => a.sources.some((s) => s.kind === 'mail' && s.account === account)))) {
    // At most MAIL_OP_MAX_IDS lookups at once, each under its own deadline, so the batch waits one deadline.
    return Promise.all([...ids].map((id) => mailScopes(file, account, id, pending)));
  }
  const classified = file.items.some((i) => i.source.kind === 'mail' && (ids.has(i.source.message) || !!keyOf(i)));
  return classified || pending.length > 0 ? 'unverifiable' : [...ids].map(() => new Set<string>());
}

/** One message, both ways: an area caller only its own exact item, a caller with no area only unassigned mail. */
const mailItemAllowed = (caller: AreaScopes, scopes: ReadonlySet<string>): boolean =>
  scopes.size === 0 ? caller.size === 0 : scopeAllows(caller, scopes);

/** The object's scopes; undefined when it does not exist (its route answers that). */
// Mail and mail ops are judged message by message in judgeAreaRead, never as one set here.
async function targetScopes(target: Exclude<AreaTarget, { kind: 'mail' | 'mail-op' }>, file: RouterAreasFile | undefined): Promise<Set<string> | undefined> {
  switch (target.kind) {
    case 'task': {
      const task = await findTask(target.id);
      return task ? fullTaskScopes(task, file) : undefined;
    }
    case 'session': {
      const { resolveSessionByIdOrPrefix } = await import('../../core/session-tracker.js');
      const found = await resolveSessionByIdOrPrefix(target.id);
      return found.status === 'found' ? sessionScopes(found.session, file) : undefined;
    }
    case 'letter': {
      const { readLetterIndexForReplica } = await import('../../core/human-inbox/store.js');
      const letter = (await readLetterIndexForReplica({ readErrors: 'throw' })).find((l) => l.id === target.id);
      return letter ? ownerScopes([letter.sender, letter.awayThread], file) : undefined;
    }
    case 'approval': {
      const { getApproval } = await import('../../core/approvals/store.js');
      const rec = await getApproval(target.id);
      return rec ? ownerScopes([rec.requester], file) : undefined;
    }
  }
}

export type AreaReadVerdict = 'pass' | 'deny' | 'unverifiable';

/** A session by its id, or an automated caller with no session (no area of its own). */
export type AreaCaller = { sid: string } | { automation: true };

const callerScopesOf = (caller: AreaCaller, file: RouterAreasFile | undefined): Promise<Set<string>> =>
  'sid' in caller ? sessionIdScopes(caller.sid, file) : Promise.resolve(new Set());

/** Whether `caller` may read `target` (`body`: a mail op's input; bad input throws AreaBadInput); reusable by WS or the op gateway. */
export async function judgeAreaRead(caller: AreaCaller | undefined, target: AreaTarget, body?: unknown, allowSupervisor = false): Promise<AreaReadVerdict> {
  if (!caller || ('sid' in caller && !caller.sid.trim())) return 'pass';
  if ('sid' in caller && target.kind === 'session' && target.id === caller.sid.trim()) return 'pass';
  // Bad mail-op input throws AreaBadInput here, before the registry or any adapter is read.
  const opIds = target.kind === 'mail-op' ? mailOpIds(body) : undefined;
  const file = await readAreas();
  if (target.kind === 'mail' || target.kind === 'mail-op') {
    const pending = file ? await readPending(file) : [];
    if (pending === 'unverifiable') return 'unverifiable';
    // Every named message on its own, against one registry read and one caller snapshot.
    const each = target.kind === 'mail' ? [file ? await mailScopes(file, target.account, target.message, pending) : 'unverifiable' as const]
      : await mailOpItemScopes(opIds ?? new Set(), body, file, pending);
    if (each === 'unverifiable') return 'unverifiable';
    if (each.length === 0) return file ? 'pass' : 'unverifiable';
    const scopes = await callerScopesOf(caller, file);
    if (each.some((one) => one !== 'unverifiable' && !mailItemAllowed(scopes, one))) return 'deny';
    return each.includes('unverifiable') || !file ? 'unverifiable' : 'pass';
  }
  const scopes = await targetScopes(target, file);
  if (scopes === undefined) return 'pass';
  const denied = scopes.size > 0 && !scopeAllows(await callerScopesOf(caller, file), scopes);
  // Supervisors may READ their team's work, never write it through this exception
  // or read the raw incoming mail. Only a denied object needs the org snapshot.
  if (denied && allowSupervisor && file && (target.kind === 'task' || target.kind === 'session')) {
    const built = await buildAreaDenials(caller);
    if (!built) return 'unverifiable';
    if (target.kind === 'task') {
      const task = await findTask(target.id);
      if (task && built.denials.supervisedTasks?.has(task.id)) return 'pass';
    } else {
      const { resolveSessionByIdOrPrefix } = await import('../../core/session-tracker.js');
      const found = await resolveSessionByIdOrPrefix(target.id);
      if (found.status === 'found' && built.denials.supervisedSessions?.has(found.session.claudeSessionId)) return 'pass';
    }
  }
  if (denied) return 'deny';
  // Marks and profiles already denied above; past them an unreadable registry fails closed.
  return file ? 'pass' : 'unverifiable';
}

/** One read of every task and session for one list answer; undefined when the registry is unreadable. */
export async function buildAreaDenials(
  who: AreaCaller,
  // `tasks`: the caller's own snapshot, so what it then shows is exactly what was judged.
  snapshot: { tasks?: readonly ScopedTask[] } = {},
): Promise<{ denials: AreaDenials; none: boolean } | undefined> {
  const [{ listTasks }, { listSessions }] = await Promise.all([
    import('../../core/task-manager.js'), import('../../core/session-tracker.js'),
  ]);
  const [file, tasks, sessions] = await Promise.all([readAreas(), snapshot.tasks ?? listTasks({}), listSessions()]);
  if (!file) return undefined;
  const pending = await readPending(file);
  if (pending === 'unverifiable') return undefined;
  const caller = await callerScopesOf(who, file);
  const byTask = new Map<string, Set<string>>();
  const add = (id: string, scope: string) => { let s = byTask.get(id); if (!s) byTask.set(id, s = new Set()); s.add(scope); };
  for (const t of tasks) for (const s of taskScopes(t, file)) add(t.id, s);
  for (const area of file.areas) for (const id of area.taskIds) add(id, area.id);
  for (const r of file.routers) add(r.taskId, r.areaId);
  for (const s of sessions) { const area = profileArea(s); if (area && s.taskId) add(s.taskId, area); }
  const supervised = await supervisedTasks(who, caller, tasks, file);
  const supervisedSessions = new Set<string>();
  const deniedTasks = new Set<string>();
  for (const [id, scopes] of byTask) if (!scopeAllows(caller, scopes) && !supervised.has(id)) deniedTasks.add(id);
  const deniedSessions = new Set<string>();
  for (const s of sessions) {
    const scopes = new Set<string>();
    const area = profileArea(s);
    if (area) scopes.add(area);
    for (const id of [s.taskId, s.legacyTaskId]) if (id) for (const x of byTask.get(id) ?? []) scopes.add(x);
    const owners = [s.taskId, s.legacyTaskId].filter((id): id is string => !!id);
    if (!area && owners.length && owners.every((id) => supervised.has(id))) supervisedSessions.add(s.claudeSessionId);
    if (!scopeAllows(caller, scopes) && !supervisedSessions.has(s.claudeSessionId)) deniedSessions.add(s.claudeSessionId);
  }
  const mail = mailDenial(file, caller, pending);
  return {
    denials: {
      tasks: deniedTasks, sessions: deniedSessions, mail: mail.denied,
      supervisedTasks: supervised, supervisedSessions,
      knownTasks: new Set(tasks.map((t) => t.id)),
      knownSessions: new Set(sessions.map((s) => s.claudeSessionId)),
    },
    none: deniedTasks.size === 0 && deniedSessions.size === 0 && mail.count === 0,
  };
}

// The same rule as one read: only the exact row grants, a row sharing a confirmed key (in any area) is denied,
// and an area caller gets no unassigned row.
function mailDenial(file: RouterAreasFile, caller: AreaScopes, pending: ReadonlyArray<PendingRuleMatch> = []): { denied: AreaDenials['mail']; count: number } {
  const exact = new Map<string, Set<string>>();
  const handles = new Map<string, Set<string>>();
  const keys = new Map<string, Set<string>>();
  let count = 0;
  const add = (map: Map<string, Set<string>>, key: string, areaId: string) => { const s = map.get(key) ?? new Set<string>(); s.add(areaId); map.set(key, s); };
  for (const i of file.items) {
    if (i.source.kind !== 'mail') continue;
    add(exact, JSON.stringify([i.source.account, i.source.message, i.source.version ?? '']), i.areaId);
    add(handles, JSON.stringify([i.source.account, i.source.message]), i.areaId);
    if (keyOf(i)) add(keys, keyOf(i), i.areaId);
    if (keyOf(i) || !scopeAllows(caller, new Set([i.areaId]))) count++;
  }
  // A live rule may capture any row, so the snapshot always filters while one exists.
  if (pending.length > 0) count++;
  const denied = (a: string, m: string, key?: string, version?: string, sender?: string, subject?: string): boolean => {
    const own = exact.get(JSON.stringify([a, m, version ?? ''])) ?? new Set<string>();
    const legacy = version !== undefined ? exact.get(JSON.stringify([a, m, ''])) ?? [] : handles.get(JSON.stringify([a, m])) ?? [];
    // Rule areas only restrict: the exact row below is still the one grant.
    const prospective = pendingRuleAreas(pending, { kind: 'mail', ...(sender !== undefined ? { sender } : {}), ...(subject !== undefined ? { subject } : {}) });
    const restriction = new Set([...own, ...legacy, ...(key ? keys.get(key) ?? [] : []), ...prospective]);
    if (restriction.size === 0) return caller.size > 0;
    return !(version && own.size > 0 && scopeAllows(caller, restriction));
  };
  // An area caller is filtered even with nothing classified: its unassigned rows are denied too.
  return { denied, count: caller.size > 0 ? Math.max(count, 1) : count };
}

/** The answer judged again against a second batch snapshot (one fresh listTasks/listSessions); undefined = registry unreadable. */
export async function recheckAreaPayload(caller: AreaCaller, body: unknown, rootKind?: RowKind): Promise<{ body: unknown; denied?: true } | undefined> {
  const fresh = await buildAreaDenials(caller);
  return fresh ? filterAreaPayload(body, fresh.denials, rootKind) : undefined;
}

/** Which of `ids` a second batch snapshot denies or no longer holds; undefined = registry unreadable. */
export async function deniedTasksNow(caller: AreaCaller, ids: readonly string[]): Promise<Set<string> | undefined> {
  const fresh = await buildAreaDenials(caller);
  if (!fresh) return undefined;
  const { tasks, knownTasks } = fresh.denials;
  return new Set(ids.filter((id) => tasks.has(id) || !knownTasks?.has(id)));
}

/** Both search routes apply the request's judged visibility before their search limit. */
export function areaSearchVisibility(res: Response): import('../../core/search.js').SearchOptions['visibility'] {
  const denials = res.locals.walnutAreaDenials as AreaDenials | undefined;
  return denials && (denials.tasks.size || denials.sessions.size) ? {
    allows: (row) => !rowDenied(row, 'result', denials),
    excludedCount: denials.tasks.size + denials.sessions.size,
  } : undefined;
}

/** The task route validates the limit, then defers pagination to its two visibility checks. */
export function deferAreaTaskPage(res: Response, limit?: number, completedWithinDays?: number): boolean {
  if (!res.locals[TASK_PAGE]) return false;
  res.locals[TASK_PAGE] = { limit, completedWithinDays };
  return true;
}

async function finishTaskPage(body: unknown, page: { limit?: number; completedWithinDays?: number }): Promise<unknown> {
  const top = obj(body);
  if (!top || !Array.isArray(top.tasks)) return body;
  const { taskMatchPage } = await import('../../core/task-query-page.js');
  const matched = taskMatchPage(top.tasks as Task[], page.limit, page.completedWithinDays);
  const { enrichTasksWithSessionStatus } = await import('../routes/tasks.js');
  // Only the final visible page pays for session enrichment. Keep this original
  // page alongside it so the caller can recheck permissions on any added keys.
  const tasks = await enrichTasksWithSessionStatus(matched.tasks);
  return { ...top, ...matched, tasks,
    ...(typeof top.count === 'number' ? { count: tasks.length } : {}) };
}

/** Holds the route's one JSON answer until `decide` has judged it; a second res.json is ignored. */
function deferJson(res: Response, next: NextFunction, decide: (body: unknown) => Promise<{ status?: number; body: unknown }>): void {
  const original = res.json.bind(res);
  let taken = false;
  res.json = ((body: unknown) => {
    if (taken) return res;
    taken = true;
    decide(body).then((out) => {
      if (res.headersSent) return;
      if (out.status) res.status(out.status);
      original(out.body);
    }, (error: unknown) => { if (!res.headersSent) next(error); });
    return res;
  }) as Response['json'];
}

/** Every "@" source's search, whatever source id (registered or not yet). */
export function isMentionSearchPath(method: string, path: string): boolean {
  return method.toUpperCase() === 'GET' && /^\/mention-sources\/[^/]+\/search\/?$/.test(path);
}

// The org routes narrow their own tree (org-v1.ts callerOrgView); only the time report stays whole-or-nothing.
const AGGREGATE_PATHS = [/^\/time\/report\/?$/];

/** Aggregates whose nested titles and counters carry no full scope: served whole or refused whole. */
export function isAreaAggregatePath(method: string, path: string): boolean {
  return method.toUpperCase() === 'GET' && AGGREGATE_PATHS.some((re) => re.test(path));
}

/** The request's caller: a session id, else a declared automated caller, else a person (undefined). */
export function areaCallerOf(req: Pick<Request, 'headers'>): AreaCaller | undefined {
  const sid = req.headers['x-walnut-caller-sid'];
  if (typeof sid === 'string' && sid.trim()) return { sid: sid.trim() };
  const kind = req.headers['x-walnut-caller-kind'];
  return typeof kind === 'string' && kind.trim().toLowerCase() === 'automation' ? { automation: true } : undefined;
}

/** Mounted on /api after the caller-id rewrite (acp-caller-sid), beside routerAreaAccess. */
export async function routerAreaReader(req: Request, res: Response, next: NextFunction): Promise<void> {
  const caller = areaCallerOf(req);
  if (!caller) { next(); return; }
  if (isMentionSearchPath(req.method, req.path) || isAreaAggregatePath(req.method, req.path)) {
    // These answers carry no per-row scope, so any area this caller may not read refuses the whole answer.
    try {
      const built = await buildAreaDenials(caller);
      if (!built) { res.status(503).json(UNVERIFIABLE); return; }
      if (!built.none) { res.status(403).json(FORBIDDEN); return; }
      // An area classified while the source ran refuses the answer it produced.
      deferJson(res, next, async (body) => {
        const again = await buildAreaDenials(caller);
        if (!again) return { status: 503, body: UNVERIFIABLE };
        return again.none ? { body } : { status: 403, body: FORBIDDEN };
      });
      next();
    } catch (error) {
      next(error);
    }
    return;
  }
  const target = areaTargetOf(req.method, req.path);
  const listKind = target ? undefined : areaListKindOf(req.method, req.path);
  if (!target && !listKind) { next(); return; }
  try {
    if (target) {
      let verdict: AreaReadVerdict;
      try {
        verdict = await judgeAreaRead(caller, target, req.body, req.method === 'GET');
      } catch (error) {
        if (!(error instanceof AreaBadInput)) throw error;
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      if (verdict === 'deny') { res.status(403).json(FORBIDDEN); return; }
      if (verdict === 'unverifiable') { res.status(503).json(UNVERIFIABLE); return; }
      // Judged again when the route answers: the object may have been classified meanwhile.
      deferJson(res, next, async (body) => {
        const again = await judgeAreaRead(caller, target, req.body, req.method === 'GET');
        if (again === 'deny') return { status: 403, body: FORBIDDEN };
        if (again === 'unverifiable') return { status: 503, body: UNVERIFIABLE };
        if (target.kind === 'mail' || (target.kind === 'task' && req.method === 'GET')) {
          const built = await buildAreaDenials(caller);
          if (!built) return { status: 503, body: UNVERIFIABLE };
          const judged = filterAreaPayload(body, built.denials, target.kind);
          if (judged.denied) return { status: 403, body: FORBIDDEN };
          return { body: judged.body };
        }
        return { body };
      });
      next();
      return;
    }
    const built = await buildAreaDenials(caller);
    if (!built) { res.status(503).json(UNVERIFIABLE); return; }
    res.locals.walnutAreaDenials = built.denials;
    if (/^\/tasks\/?$/.test(req.path)) res.locals[TASK_PAGE] = {};
    // The snapshot drops rows made after it; the recheck catches a row it judged that was classified since.
    deferJson(res, next, async (body) => {
      const first = filterAreaPayload(body, built.denials, listKind);
      if (first.denied) return { status: 403, body: FORBIDDEN };
      const fresh = await buildAreaDenials(caller);
      if (!fresh) return { status: 503, body: UNVERIFIABLE };
      const again = filterAreaPayload(first.body, fresh.denials, listKind);
      if (again.denied) return { status: 403, body: FORBIDDEN };
      let visible = res.locals[TASK_PAGE] ? await finishTaskPage(again.body, res.locals[TASK_PAGE]) : again.body;
      if (res.locals[TASK_PAGE]) {
        const final = await buildAreaDenials(caller);
        if (!final) return { status: 503, body: UNVERIFIABLE };
        const enriched = filterAreaPayload(visible, final.denials, listKind);
        const all = filterAreaPayload(again.body, final.denials, listKind);
        // A classification during async enrichment invalidates even an off-page
        // row's contribution to total. Retry instead of returning stale counters.
        if (enriched.denied || all.denied || obj(all.body)?.total !== obj(again.body)?.total
          || (obj(enriched.body)?.tasks as unknown[] | undefined)?.length
          !== (obj(visible)?.tasks as unknown[] | undefined)?.length) return { status: 503, body: UNVERIFIABLE };
        const safe = obj(enriched.body);
        // Keep pre-page counters; the final pass only redacts added session keys.
        if (safe) visible = { ...obj(visible), tasks: safe.tasks };
      }
      let top = obj(visible);
      if (top?.board && Array.isArray(top.tasks)) {
        // Board counters describe the whole visible board, even when q, a
        // tier filter or limit narrows the page. Both snapshots must allow it.
        const { getBoardCounts } = await import('../../core/task-manager.js');
        top = { ...top, board: await getBoardCounts((t) => !rowDenied(t, 'task', built.denials)
          && !rowDenied(t, 'task', fresh.denials)) };
      }
      return { body: top ? { ...top, ...(!built.none ? { visibility_note: VISIBILITY_NOTE } : {}) } : visible };
    });
    next();
  } catch (error) {
    next(error);
  }
}

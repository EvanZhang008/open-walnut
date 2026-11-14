// In-process twin of router-area-reader.ts scopes; only exact registry items are authority.
import { WALNUT_HOME } from '../../constants.js';
import { canonicalItemKey, readRouterAreas, taskArea, type RouterAreasFile } from './areas.js';
import { pendingRuleAreas, readPendingRuleMatches, type PendingRuleMatch } from './rules.js';
import type { RouterSourceKind } from './types.js';
import type { SessionRecord, Task } from '../types.js';

/** A router task placed nowhere: a scope no caller ever holds. */
const NO_AREA_ROUTER = '\u0000router-without-area';

const NOT_FOUND = /^(No task found|Ambiguous ID prefix)/;

type ScopedTask = Pick<Task, 'id'> & { router_area_id?: string | null; org_role?: string | null };
type ScopedSession = Pick<SessionRecord, 'profile' | 'taskId' | 'legacyTaskId'>;

export interface SourceReaderDeps {
  readAreas(): Promise<RouterAreasFile>;
  session(sid: string): Promise<ScopedSession | null>;
  // Undefined only for "no such task": any other failure must fail the reader closed.
  task(id: string): Promise<ScopedTask | undefined>;
  sessionsForTask(taskId: string): Promise<Array<Pick<SessionRecord, 'profile'>>>;
  // Live confirmed inbound rules; absent with bindings present, every bound area restricts.
  readPendingRules?(file: RouterAreasFile): Promise<ReadonlyArray<PendingRuleMatch>>;
}

export type SourceCaller = { kind: 'person' } | { kind: 'session'; sid: string } | { kind: 'agent' };

export interface SourceRef {
  kind: RouterSourceKind;
  account: string;
  message: string;
  version?: string;
  // Cache-derived identity restricts copied items, never authorizes another body's exact source.
  canonicalKey?: string;
  // Cache metadata a pending inbound rule matches against; it only restricts.
  sender?: string;
  subject?: string;
}

export interface ScopedSourceReader {
  kind: 'scoped';
  /** Every area that restricts the item: its exact row, confirmed copies by canonical key, and live rules matching its metadata. */
  itemAreas(ref: SourceRef): Set<string>;
  /** Only the exact registry row's areas: the one thing that grants an area caller the item. */
  exactAreas(ref: SourceRef): Set<string>;
  allowsScopes(target: ReadonlySet<string>): boolean;
  /** No area caller and an unassigned item, or an item exactly confirmed in the caller's one area and restricted by no other. */
  allowsItem(restriction: ReadonlySet<string>, exact: ReadonlySet<string>): boolean;
  allows(ref: SourceRef): boolean;
  areaIds: readonly string[];
}

export type SourceReader = { kind: 'open' } | { kind: 'unverifiable' } | ScopedSourceReader;

const defaultDeps: SourceReaderDeps = {
  readAreas: () => readRouterAreas(WALNUT_HOME),
  readPendingRules: (file) => readPendingRuleMatches(file),
  async session(sid) {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    return getSessionByClaudeId(sid);
  },
  async task(id) {
    const { getTask } = await import('../task-manager.js');
    try {
      const task = await getTask(id);
      return task.id === id ? task : undefined;
    } catch (error) {
      if (error instanceof Error && NOT_FOUND.test(error.message)) return undefined;
      throw error;
    }
  },
  async sessionsForTask(taskId) {
    const { getSessionsForTask } = await import('../session-tracker.js');
    return getSessionsForTask(taskId);
  },
};

const profileArea = (record: Pick<SessionRecord, 'profile'> | null | undefined): string =>
  typeof record?.profile?.areaId === 'string' ? record.profile.areaId.trim() : '';

export function sourceScopeAllows(caller: ReadonlySet<string>, target: ReadonlySet<string>): boolean {
  if (target.size === 0) return true;
  if (caller.size !== 1 || target.size !== 1) return false;
  const [c] = caller;
  const [t] = target;
  return c === t && c !== NO_AREA_ROUTER;
}

async function taskIdScopes(id: string, file: RouterAreasFile, deps: SourceReaderDeps, out: Set<string>): Promise<void> {
  const task = (await deps.task(id)) ?? { id };
  let found = false;
  const add = (s: string | undefined) => { if (s) { out.add(s); found = true; } };
  add(typeof task.router_area_id === 'string' ? task.router_area_id.trim() : '');
  add(taskArea(file, id)?.id);
  for (const r of file.routers) if (r.taskId === id) add(r.areaId);
  if (!found && task.org_role === 'router') out.add(NO_AREA_ROUTER);
  for (const record of await deps.sessionsForTask(id)) {
    const area = profileArea(record);
    if (area) out.add(area);
  }
}

async function callerScopes(sid: string, file: RouterAreasFile, deps: SourceReaderDeps): Promise<Set<string>> {
  const out = new Set<string>();
  const record = await deps.session(sid);
  // An unknown id is an outside caller: no area of its own.
  if (!record) return out;
  const own = profileArea(record);
  if (own) out.add(own);
  for (const id of new Set([record.taskId, record.legacyTaskId].filter((v): v is string => !!v))) {
    await taskIdScopes(id, file, deps, out);
  }
  return out;
}

const itemKey = (kind: string, account: string, message: string, version?: string) => JSON.stringify([kind, account, message, version ?? '']);

function addTo(map: Map<string, Set<string>>, key: string, areaId: string): void {
  let set = map.get(key);
  if (!set) map.set(key, set = new Set());
  set.add(areaId);
}

// An area gone, or not listing the account, still holds its item: a broken row never reads as unassigned.
function itemScopes(file: RouterAreasFile): { exact: Map<string, Set<string>>; handles: Map<string, Set<string>>; canonical: Map<string, Set<string>> } {
  const exact = new Map<string, Set<string>>();
  const handles = new Map<string, Set<string>>();
  const canonical = new Map<string, Set<string>>();
  for (const item of file.items) {
    addTo(exact, itemKey(item.source.kind, item.source.account, item.source.message, item.source.version), item.areaId);
    addTo(handles, JSON.stringify([item.source.kind, item.source.account, item.source.message]), item.areaId);
    if (item.canonicalKey) addTo(canonical, canonicalItemKey(item.source.kind, item.source.account, item.canonicalKey), item.areaId);
  }
  return { exact, handles, canonical };
}

export async function sourceReaderFor(caller: SourceCaller, deps: SourceReaderDeps = defaultDeps): Promise<SourceReader> {
  if (caller.kind === 'person') return { kind: 'open' };
  const sid = caller.kind === 'session' ? caller.sid.trim() : '';
  // A session record with no id is broken; an agent with no sid is an outside caller (no area).
  if (caller.kind === 'session' && !sid) return { kind: 'unverifiable' };
  let scopes: Set<string>;
  let items: ReturnType<typeof itemScopes>;
  let areaIds: string[];
  let pending: ReadonlyArray<PendingRuleMatch> = [];
  try {
    const file = await deps.readAreas();
    items = itemScopes(file);
    areaIds = file.areas.map((area) => area.id);
    if (file.ruleBindings?.length) {
      pending = deps.readPendingRules ? await deps.readPendingRules(file) : file.ruleBindings.map((b) => ({ areaId: b.areaId, match: {} }));
    }
    scopes = sid ? await callerScopes(sid, file, deps) : new Set();
  } catch {
    return { kind: 'unverifiable' };
  }
  const unknownRules = pending.length > 0 && !deps.readPendingRules;
  // The union of the exact item and its confirmed copies: two areas in it allow no scoped caller.
  const itemAreas = (ref: SourceRef) => {
    const out = new Set(items.exact.get(itemKey(ref.kind, ref.account, ref.message, ref.version)) ?? []);
    if (ref.version === undefined) for (const area of items.handles.get(JSON.stringify([ref.kind, ref.account, ref.message])) ?? []) out.add(area);
    else for (const area of items.exact.get(itemKey(ref.kind, ref.account, ref.message)) ?? []) out.add(area);
    if (ref.canonicalKey) for (const area of items.canonical.get(canonicalItemKey(ref.kind, ref.account, ref.canonicalKey)) ?? []) out.add(area);
    // An item a rule would capture is restricted before (or without) its confirm: no exact row, no grant.
    const meta = unknownRules ? { kind: ref.kind } : { kind: ref.kind, sender: ref.sender, subject: ref.subject };
    for (const area of pendingRuleAreas(pending, meta)) out.add(area);
    return out;
  };
  const exactAreas = (ref: SourceRef) => new Set(items.exact.get(itemKey(ref.kind, ref.account, ref.message, ref.version)) ?? []);
  const allowsScopes = (target: ReadonlySet<string>) => sourceScopeAllows(scopes, target);
  // Both ways per item: an area caller reads only what was confirmed for its area, never unassigned
  // mail; a copy (same canonical key, another exact source) only restricts, its body is a new item.
  const allowsItem = (restriction: ReadonlySet<string>, exact: ReadonlySet<string>) =>
    restriction.size === 0 ? scopes.size === 0 : exact.size > 0 && allowsScopes(restriction);
  return {
    kind: 'scoped', itemAreas, exactAreas, allowsScopes, allowsItem,
    allows: (ref) => allowsItem(itemAreas(ref), exactAreas(ref)), areaIds,
  };
}

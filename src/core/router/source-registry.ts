import { ROUTER_SOURCE_KINDS, type RouterItem, type RouterSource } from './types.js';
// The areas registry's ROUTER_CANONICAL_KEY_MAX, kept here so plugin bundles never load the registry module.
const SCOPE_KEY_MAX = 2048;
/** A reference is one line the receiver runs or opens: a tool call or a permalink. */
const REFERENCE_MAX = 500;

/** A plugin's item keeps its exact source, and a scope key it gives is a short plain string. */
function checkedItem(item: RouterItem, source: RouterSource): RouterItem {
  if (item.source.version !== undefined && (typeof item.source.version !== 'string' || !item.source.version || item.source.version.length > 200 || /[\u0000-\u001f\u007f]/.test(item.source.version))) {
    throw new Error('Routing source gave an unusable delivery version.');
  }
  if (item.source.kind !== source.kind || item.source.account !== source.account || item.source.message !== source.message
    || (source.version !== undefined && item.source.version !== source.version)) {
    throw new Error('Routing source identity does not match the requested item.');
  }
  const reference: unknown = item.reference;
  if (reference !== undefined && (typeof reference !== 'string' || !reference || reference.length > REFERENCE_MAX || /[\u0000-\u001f\u007f]/.test(reference))) {
    throw new Error('Routing source gave an unusable reference for this item.');
  }
  const scope: unknown = item.scopeKey;
  if (scope !== undefined && (typeof scope !== 'string' || !scope || scope.length > SCOPE_KEY_MAX || /[\u0000-\u001f\u007f]/.test(scope))) {
    throw new Error('Routing source gave an unusable scope key for this item.');
  }
  return item;
}

export interface RouterItemContent {
  item: RouterItem;
  body: { text?: string; html?: string } | null;
  bodyAvailable: boolean;
  /** Cache-only evidence, never a routing verdict or authority to act. */
  headers?: {
    listUnsubscribe?: { https?: string[]; mailto?: string[]; oneClick?: boolean; listId?: string };
    bulkHeaders?: { precedence?: string; autoSubmitted?: string };
  };
  bodyUnavailableReason?: string;
  bodyTruncated?: boolean;
  attachments: Array<{ filename?: string; mimeType?: string; bytes?: number }>;
  attachmentsAvailable: false;
}

export class RouterSourceError extends Error {
  constructor(readonly code: 'source_missing' | 'source_unavailable' | 'source_changed', message: string) { super(message); }
}

export interface RouterSourceAdapter {
  resolve(source: RouterSource): Promise<RouterItem>;
  read?(source: RouterSource): Promise<RouterItemContent>;
  /**
   * The delivery's read: as `read`, but a body the cache does not hold yet is fetched first (read
   * only, never marking the item read), and the copy that gained it is accepted when nothing else of
   * the delivery changed. The owner gets the original, not only its reference.
   */
  readForDelivery?(source: RouterSource): Promise<RouterItemContent>;
  /** Cache-only batch check: the given sources that are still the cached current delivery. */
  currentSources?(sources: readonly RouterSource[]): Promise<RouterSource[]>;
  /**
   * Cache-only: the current copy of the item a scope key names (a filter moved it, or its cached
   * delivery changed), or null when the cache holds no copy of it any more.
   */
  relocate?(source: RouterSource, scopeKey: string): Promise<RouterItem | null | undefined>;
  /**
   * The router judged this item noise: tidy it the reversible way the source allows (mail: mark it
   * read, then move it from the inbox to the archive). Never deletes and never sends anything.
   */
  noise?(source: RouterSource): Promise<RouterNoiseOutcome>;
  /**
   * What the source itself saw arrive for one account between two times, with the labels its intake
   * gives each, from its own record (never a
   * fetch that marks anything read): the router's hourly check compares it with what reached the
   * router, and enters what is missing (reconcile.ts). Unset: that source is not checked.
   */
  recent?(account: string, sinceMs: number, untilMs: number): Promise<Array<RouterSource & { labels?: string[] }>>;
}

/** What a source did with an item its router judged noise; `note` says why a step was not taken. */
export interface RouterNoiseOutcome {
  read: boolean;
  archived: boolean;
  note?: string;
}

const host = globalThis as typeof globalThis & { __walnutRouterSources?: Map<RouterSource['kind'], RouterSourceAdapter> };
// Built-in plugins are separate bundles, but their registrations belong to this server process.
const adapters = host.__walnutRouterSources ??= new Map<RouterSource['kind'], RouterSourceAdapter>();

const ADAPTER_KEYS = new Set(['resolve', 'read', 'readForDelivery', 'currentSources', 'relocate', 'noise', 'recent']);

/** Plugins cross this boundary untyped, so unknown hooks are refused. */
export function assertRouterSource(kind: unknown, adapter: unknown): asserts adapter is RouterSourceAdapter {
  if (typeof kind !== 'string' || !(ROUTER_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`Unknown routing source kind: ${String(kind)}. Expected one of ${ROUTER_SOURCE_KINDS.join(', ')}.`);
  }
  if (!adapter || typeof adapter !== 'object') throw new TypeError('A routing source adapter must be an object with resolve() and an optional read().');
  for (const key of Object.keys(adapter)) {
    if (!ADAPTER_KEYS.has(key)) {
      throw new TypeError(`A routing source adapter takes only resolve(), read(), readForDelivery(), currentSources(), relocate(), noise() and recent(), not "${key}".`);
    }
  }
  const { resolve, read, currentSources, relocate, noise, readForDelivery, recent } = adapter as Record<string, unknown>;
  if (recent !== undefined && typeof recent !== 'function') throw new TypeError('A routing source adapter\'s recent must be a function when given.');
  if (readForDelivery !== undefined && typeof readForDelivery !== 'function') throw new TypeError('A routing source adapter\'s readForDelivery must be a function when given.');
  if (relocate !== undefined && typeof relocate !== 'function') throw new TypeError('A routing source adapter\'s relocate must be a function when given.');
  if (noise !== undefined && typeof noise !== 'function') throw new TypeError('A routing source adapter\'s noise must be a function when given.');
  if (typeof resolve !== 'function') throw new TypeError('A routing source adapter needs a resolve() function.');
  if (read !== undefined && typeof read !== 'function') throw new TypeError('A routing source adapter\'s read must be a function when given.');
  if (currentSources !== undefined && typeof currentSources !== 'function') {
    throw new TypeError('A routing source adapter\'s currentSources must be a function when given.');
  }
}

export function registerRouterSource(kind: RouterSource['kind'], adapter: RouterSourceAdapter): () => void {
  assertRouterSource(kind, adapter);
  adapters.set(kind, adapter);
  return () => { if (adapters.get(kind) === adapter) adapters.delete(kind); };
}

export async function resolveRouterItem(source: RouterSource): Promise<RouterItem> {
  const adapter = adapters.get(source.kind);
  if (!adapter) throw new RouterSourceError('source_unavailable', `The ${source.kind} integration is not available for routing.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const item = await Promise.race([
      adapter.resolve(source),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routing source lookup timed out.')), 3000); }),
    ]);
    return checkedItem(item, source);
  } catch (error) {
    if (['source_missing', 'source_changed'].includes((error as { code?: string })?.code ?? '')) throw error;
    throw new RouterSourceError('source_unavailable', error instanceof Error ? error.message : String(error));
  } finally { if (timer) clearTimeout(timer); }
}

export async function readRouterItem(source: RouterSource): Promise<RouterItemContent> {
  const adapter = adapters.get(source.kind);
  if (!adapter?.read) throw new RouterSourceError('source_unavailable', `The ${source.kind} integration has no cache-only content reader.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = await Promise.race([
      adapter.read(source),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routing content lookup timed out.')), 3000); }),
    ]);
    checkedItem(content.item, source);
    return content;
  } catch (error) {
    if (['source_missing', 'source_changed'].includes((error as { code?: string })?.code ?? '')) throw error;
    throw new RouterSourceError('source_unavailable', error instanceof Error ? error.message : String(error));
  } finally { if (timer) clearTimeout(timer); }
}

/** How long a delivery waits for a body fetch: it runs once per routed item, never in a wake's batch. */
export const ROUTER_DELIVERY_READ_MS = 20_000;

/** The original as the owner gets it: with its body fetched when the cache had none (readForDelivery), else the cached read. */
export async function readRouterItemForDelivery(source: RouterSource): Promise<RouterItemContent> {
  const adapter = adapters.get(source.kind);
  if (!adapter?.readForDelivery) return readRouterItem(source);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = await Promise.race([
      adapter.readForDelivery(source),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routing content fetch timed out.')), ROUTER_DELIVERY_READ_MS); }),
    ]);
    if (content.item.source.kind !== source.kind || content.item.source.account !== source.account || content.item.source.message !== source.message) {
      throw new RouterSourceError('source_changed', 'The delivery read answered another item.');
    }
    return content;
  } catch {
    // A fetch that failed or ran long leaves the cached read: the reference still reads the rest.
    return readRouterItem(source);
  } finally { if (timer) clearTimeout(timer); }
}

const identityOf = (one: RouterSource) => JSON.stringify([one.kind, one.account, one.message, one.version ?? null]);

/** The adapter's answer as a subset of what was asked, in asked order; anything else is refused whole. */
function checkedCurrent(asked: readonly RouterSource[], answer: unknown): RouterSource[] {
  if (!Array.isArray(answer)) throw new Error('Routing source gave no list of current items.');
  const byIdentity = new Map(asked.map((one) => [identityOf(one), one]));
  const kept = new Set<string>();
  for (const one of answer as unknown[]) {
    const raw = (one && typeof one === 'object' ? one : {}) as Record<string, unknown>;
    if (typeof raw.kind !== 'string' || typeof raw.account !== 'string' || typeof raw.message !== 'string'
      || (raw.version !== undefined && (typeof raw.version !== 'string' || !raw.version))) {
      throw new Error('Routing source gave an unusable current item.');
    }
    const identity = identityOf(raw as unknown as RouterSource);
    if (!byIdentity.has(identity) || kept.has(identity)) throw new Error('Routing source named a current item it was not asked about.');
    kept.add(identity);
  }
  return asked.filter((one) => kept.has(identityOf(one)));
}

/** Mail must answer: a later reply or body change replaces a confirmed snapshot, which no ledger row ever settles. */
export async function currentRouterSources(sources: readonly RouterSource[]): Promise<RouterSource[]> {
  const byKind = new Map<RouterSource['kind'], RouterSource[]>();
  for (const one of sources) {
    const group = byKind.get(one.kind);
    if (group) group.push(one); else byKind.set(one.kind, [one]);
  }
  const current = new Set<RouterSource>();
  for (const [kind, asked] of byKind) {
    const adapter = adapters.get(kind);
    if (!adapter?.currentSources) {
      if (kind === 'mail') throw new RouterSourceError('source_unavailable', 'The mail integration cannot check which confirmed emails are still current.');
      asked.forEach((one) => current.add(one));
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The adapter gets copies, so it cannot rewrite what its answer is checked against.
      const answer = await Promise.race([
        adapter.currentSources(asked.map((one) => Object.freeze({ ...one }))),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routing source current check timed out.')), 3000); }),
      ]);
      checkedCurrent(asked, answer).forEach((one) => current.add(one));
    } catch (error) {
      if (error instanceof RouterSourceError) throw error;
      throw new RouterSourceError('source_unavailable', error instanceof Error ? error.message : String(error));
    } finally { if (timer) clearTimeout(timer); }
  }
  return sources.filter((one) => current.has(one));
}

/**
 * The current copy of an item by its scope key, from the cache only: undefined when nothing is known
 * (no relocate hook, or the source cannot tell), null when the cache holds no copy any more.
 */
export async function relocateRouterItem(source: RouterSource, scopeKey: string): Promise<RouterItem | null | undefined> {
  const adapter = adapters.get(source.kind);
  if (!adapter?.relocate) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const item = await Promise.race([
      adapter.relocate(Object.freeze({ ...source }), scopeKey),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routing source relocate timed out.')), 3000); }),
    ]);
    if (item === null || item === undefined) return item;
    if ( item.source.kind !== source.kind || item.source.account !== source.account || item.scopeKey !== scopeKey
      || typeof item.source.version !== 'string' || !item.source.version) {
      throw new Error('Routing source relocated an item to another identity.');
    }
    return checkedItem(item, item.source);
  } catch (error) {
    throw new RouterSourceError('source_unavailable', error instanceof Error ? error.message : String(error));
  } finally { if (timer) clearTimeout(timer); }
}

/** Whether this kind's source can tidy noise at all (asked before the person's choice is read). */
export function hasRouterNoise(kind: RouterSource['kind']): boolean {
  return typeof adapters.get(kind)?.noise === 'function';
}

/**
 * How long a source may take to tidy one noise item, queue included (mail tidies one account's items
 * one at a time); it runs after the router's answer. Not tracked across a restart: a tidy cut short
 * leaves the mail where it was (read, perhaps), and the reason without its prefix.
 */
export const ROUTER_NOISE_MS = 30 * 60_000;

/**
 * Tidies one item its router judged noise, through its source's hook. Undefined when the source has
 * none; never throws, so a mail server that refuses leaves the decision as it was recorded.
 */
export async function handleRouterNoise(source: RouterSource, timeoutMs = ROUTER_NOISE_MS): Promise<RouterNoiseOutcome | undefined> {
  const adapter = adapters.get(source.kind);
  if (!adapter?.noise) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw: unknown = await Promise.race([
      adapter.noise(Object.freeze({ ...source })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The source took too long to tidy the item.')), timeoutMs); }),
    ]);
    const answer = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      read: answer.read === true, archived: answer.archived === true,
      ...(typeof answer.note === 'string' && answer.note ? { note: answer.note.slice(0, 200) } : {}),
    };
  } catch (error) {
    return { read: false, archived: false, note: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  } finally { if (timer) clearTimeout(timer); }
}

/** Whether this kind's source can say what it saw arrive (the hourly missed-message check). */
export function hasRouterRecent(kind: RouterSource['kind']): boolean {
  return typeof adapters.get(kind)?.recent === 'function';
}

/** One arrival a source saw, with the labels a router's filter reads (plugin-intake.ts). */
export interface RouterRecentArrival { source: RouterSource; labels: string[] }

/** The most items one recent() answer may name; more is refused whole. */
export const ROUTER_RECENT_MAX = 1000;

/**
 * What one account's source saw arrive since `sinceMs`, checked: only that kind and account, each
 * message once. Throws RouterSourceError when the source cannot answer (the check then says it
 * could not count, never that nothing was missed).
 */
export async function recentRouterSources(kind: RouterSource['kind'], account: string, sinceMs: number, untilMs: number): Promise<RouterRecentArrival[]> {
  const adapter = adapters.get(kind);
  if (!adapter?.recent) throw new RouterSourceError('source_unavailable', `The ${kind} integration cannot say what arrived.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer: unknown = await Promise.race([
      adapter.recent(account, sinceMs, untilMs),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Routing source recent check timed out.')), 20_000); }),
    ]);
    if (!Array.isArray(answer) || answer.length > ROUTER_RECENT_MAX) throw new Error('Routing source gave no usable list of recent items.');
    const seen = new Set<string>();
    const out: RouterRecentArrival[] = [];
    for (const one of answer as unknown[]) {
      const raw = (one && typeof one === 'object' ? one : {}) as Record<string, unknown>;
      if (raw.kind !== kind || raw.account !== account || typeof raw.message !== 'string' || !raw.message
        || (raw.version !== undefined && (typeof raw.version !== 'string' || !raw.version))) {
        throw new Error('Routing source named a recent item of another account or with no message id.');
      }
      const source: RouterSource = { kind, account, message: raw.message, ...(raw.version !== undefined ? { version: raw.version as string } : {}) };
      const labels = raw.labels === undefined ? [] : raw.labels;
      if (!Array.isArray(labels) || labels.length > 20 || !labels.every((label) => typeof label === 'string' && !!label && label.length <= 200)) {
        throw new Error('Routing source gave a recent item with unusable labels.');
      }
      const id = identityOf(source);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ source, labels: labels as string[] });
    }
    return out;
  } catch (error) {
    if (error instanceof RouterSourceError) throw error;
    throw new RouterSourceError('source_unavailable', error instanceof Error ? error.message : String(error));
  } finally { if (timer) clearTimeout(timer); }
}

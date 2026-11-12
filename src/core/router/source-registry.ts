import { ROUTER_SOURCE_KINDS, type RouterItem, type RouterSource } from './types.js';
// The areas registry's ROUTER_CANONICAL_KEY_MAX, kept here so plugin bundles never load the registry module.
const SCOPE_KEY_MAX = 2048;

/** A plugin's item keeps its exact source, and a scope key it gives is a short plain string. */
function checkedItem(item: RouterItem, source: RouterSource): RouterItem {
  if (item.source.version !== undefined && (typeof item.source.version !== 'string' || !item.source.version || item.source.version.length > 200 || /[\u0000-\u001f\u007f]/.test(item.source.version))) {
    throw new Error('Routing source gave an unusable delivery version.');
  }
  if (item.source.kind !== source.kind || item.source.account !== source.account || item.source.message !== source.message
    || (source.version !== undefined && item.source.version !== source.version)) {
    throw new Error('Routing source identity does not match the requested item.');
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
  attachments: Array<{ filename?: string; mimeType?: string; bytes?: number }>;
  attachmentsAvailable: false;
}

export class RouterSourceError extends Error {
  constructor(readonly code: 'source_missing' | 'source_unavailable' | 'source_changed', message: string) { super(message); }
}

export interface RouterSourceAdapter {
  resolve(source: RouterSource): Promise<RouterItem>;
  read?(source: RouterSource): Promise<RouterItemContent>;
  /** Cache-only batch check: the given sources that are still the cached current delivery. */
  currentSources?(sources: readonly RouterSource[]): Promise<RouterSource[]>;
  /**
   * Cache-only: the current copy of the item a scope key names (a filter moved it, or its cached
   * delivery changed), or null when the cache holds no copy of it any more.
   */
  relocate?(source: RouterSource, scopeKey: string): Promise<RouterItem | null | undefined>;
}

const host = globalThis as typeof globalThis & { __walnutRouterSources?: Map<RouterSource['kind'], RouterSourceAdapter> };
// Built-in plugins are separate bundles, but their registrations belong to this server process.
const adapters = host.__walnutRouterSources ??= new Map<RouterSource['kind'], RouterSourceAdapter>();

/** Plugins cross this boundary untyped, so unknown hooks are refused. */
export function assertRouterSource(kind: unknown, adapter: unknown): asserts adapter is RouterSourceAdapter {
  if (typeof kind !== 'string' || !(ROUTER_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`Unknown routing source kind: ${String(kind)}. Expected one of ${ROUTER_SOURCE_KINDS.join(', ')}.`);
  }
  if (!adapter || typeof adapter !== 'object') throw new TypeError('A routing source adapter must be an object with resolve() and an optional read().');
  for (const key of Object.keys(adapter)) {
    if (key !== 'resolve' && key !== 'read' && key !== 'currentSources' && key !== 'relocate') {
      throw new TypeError(`A routing source adapter takes only resolve(), read(), currentSources() and relocate(), not "${key}".`);
    }
  }
  const { resolve, read, currentSources, relocate } = adapter as Record<string, unknown>;
  if (relocate !== undefined && typeof relocate !== 'function') throw new TypeError('A routing source adapter\'s relocate must be a function when given.');
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

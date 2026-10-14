import { setImmediate } from 'node:timers/promises';
import { normalizeUsageModel, type CanonicalUsageRecord } from './usage-scan-core.js';
import { reconcileUsageAsync, type ProxyUsageRecord, type UsageReconciliation } from './usage-reconcile-core.js';

type Reconciled = UsageReconciliation['records'][number];
const COUNTERS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
interface Entry {
  id: string; order: number; group: string; start: number; end: number;
  canonical?: CanonicalUsageRecord; proxy?: ProxyUsageRecord; result?: Reconciled;
  component?: Component; residual: boolean;
}
interface Component { start: number; end: number; entries: Set<Entry> }
interface Node { value: Component; priority: number; left?: Node; right?: Node }
export interface BudgetIndexResult {
  changed: Reconciled[];
  /** Unconsumed proxy observations for the configured session; unattributed observations do not claim it. */
  hasSessionResidual: boolean;
  /** Live immutable view. Keys are JSON.stringify([normalizedModel, responseId]). */
  pendingIdentities: ReadonlySet<string>;
  /** Matching counts plus index materialization/sort visits. A giant connected component is deliberately not capped. */
  work: { canonical: number; proxy: number; components: number; entryVisits: number };
}

function merge(left?: Node, right?: Node): Node | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.priority < right.priority) { left.right = merge(left.right, right); return left; }
  right.left = merge(left, right.left); return right;
}
function split(root: Node | undefined, key: number): [Node | undefined, Node | undefined] {
  if (!root) return [undefined, undefined];
  if (root.value.start < key) {
    const [a, b] = split(root.right, key); root.right = a; return [root, b];
  }
  const [a, b] = split(root.left, key); root.left = b; return [a, root];
}
function remove(root: Node | undefined, key: number): Node | undefined {
  if (!root) return;
  if (key === root.value.start) return merge(root.left, root.right);
  if (key < root.value.start) root.left = remove(root.left, key); else root.right = remove(root.right, key);
  return root;
}
function predecessor(root: Node | undefined, key: number): Component | undefined {
  let found: Component | undefined;
  while (root) { if (root.value.start <= key) { found = root.value; root = root.right; } else root = root.left; }
  return found;
}
function successor(root: Node | undefined, key: number): Component | undefined {
  let found: Component | undefined;
  while (root) { if (root.value.start >= key) { found = root.value; root = root.left; } else root = root.right; }
  return found;
}
function signature(record: CanonicalUsageRecord | ProxyUsageRecord): string | undefined {
  const model = normalizeUsageModel(record.model);
  if (!record.sessionId || !record.model || model === 'unknown' || COUNTERS.some(key =>
    typeof record[key] !== 'number' || !Number.isSafeInteger(record[key]) || record[key]! < 0)) return;
  return JSON.stringify([record.sessionId, model, ...COUNTERS.map(key => record[key])]);
}
function canonicalKey(record: CanonicalUsageRecord): string { return JSON.stringify([normalizeUsageModel(record.model), record.responseId]); }
function proxyKey(record: ProxyUsageRecord): string { return record.evidenceId ?? JSON.stringify([record.requestId, record.startedMs]); }
function location(record: CanonicalUsageRecord | ProxyUsageRecord, id: string): Pick<Entry, 'group' | 'start' | 'end'> {
  const key = signature(record);
  if ('responseId' in record) {
    const ms = Date.parse(record.timestamp);
    return record.complete && key && Number.isFinite(ms) && ms >= 0
      ? { group: key, start: ms, end: ms } : { group: `invalid:${id}`, start: 0, end: 0 };
  }
  const finish = record.finishedMs ?? record.startedMs;
  return record.complete && record.usagePresent && key && Number.isFinite(record.startedMs) && record.startedMs >= 0
    && Number.isFinite(finish) && finish >= record.startedMs && Number.isFinite(finish + 5_000)
    ? { group: key, start: record.startedMs - 5_000, end: finish + 5_000 }
    : { group: `invalid:${id}`, start: 0, end: 0 };
}
function mergeProxy(previous: ProxyUsageRecord, next: ProxyUsageRecord): ProxyUsageRecord {
  const conflict = previous.model !== next.model || previous.sessionId !== next.sessionId
    || previous.forwardedModel !== next.forwardedModel || previous.finishedMs !== next.finishedMs
    || COUNTERS.some(key => previous[key] !== next[key]);
  if (!conflict && next.complete && previous.complete) return previous;
  const result = { ...previous, complete: false };
  for (const key of COUNTERS) if (previous[key] !== next[key]) result[key] = null;
  return result;
}

/** Components are disjoint closed intervals within a signature. Only touched components are rebuilt. */
export function createUsageBudgetIndex(options: { sessionId?: string } = {}) {
  const canonicals = new Map<string, Entry>(), proxies = new Map<string, Entry>(), roots = new Map<string, Node | undefined>();
  const pending = new Set<string>();
  let residualCount = 0, order = 0, random = 0x9e3779b9;
  let queue: Promise<unknown> = Promise.resolve();
  const view: ReadonlySet<string> = Object.freeze({
    get size() { return pending.size; }, has: (key: string) => pending.has(key),
    entries: () => pending.entries(), keys: () => pending.keys(), values: () => pending.values(),
    [Symbol.iterator]: () => pending.values(),
    forEach(callback: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown) {
      pending.forEach(key => callback.call(thisArg, key, key, view));
    },
  });
  function priority() { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return random >>> 0; }
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const work = queue.then(action); queue = work.then(() => {}, () => {}); return work;
  }
  function context() {
    let cpu = process.cpuUsage(), ticks = 0;
    return () => {
      if (++ticks % 32) return;
      const elapsed = process.cpuUsage(cpu);
      if (elapsed.user + elapsed.system >= 5_000) return setImmediate().then(() => { cpu = process.cpuUsage(); });
    };
  }
  async function apply(canonicalDelta: readonly CanonicalUsageRecord[], proxyDelta: readonly ProxyUsageRecord[], baseline = false): Promise<BudgetIndexResult> {
    const pause = context(), affected = new Set<Entry>(), changed = new Map<string, Reconciled>();
    const work = { canonical: 0, proxy: 0, components: 0, entryVisits: 0 };
    const visit = () => { work.entryVisits++; };
    if (baseline) { canonicals.clear(); proxies.clear(); roots.clear(); pending.clear(); residualCount = 0; order = 0; }
    async function touch(entry: Entry) {
      if (entry.component) {
        const component = entry.component;
        roots.set(entry.group, remove(roots.get(entry.group), component.start));
        for (const member of component.entries) {
          visit(); affected.add(member); member.component = undefined;
          const wait = pause(); if (wait) await wait;
        }
      } else affected.add(entry);
    }
    for (const record of canonicalDelta) {
      visit();
      const key = canonicalKey(record), existing = canonicals.get(key);
      const canonical = existing && !baseline ? { ...record, sessionId: existing.canonical!.sessionId,
        timestamp: existing.canonical!.timestamp, agentId: existing.canonical!.agentId,
        complete: existing.canonical!.complete === false ? false : record.complete } : record;
      if (!existing || JSON.stringify(existing.canonical) !== JSON.stringify(canonical)) {
        const entry = existing ?? { id: `c:${key}`, order: order++, residual: false, ...location(canonical, `c:${key}`) };
        await touch(entry);
        entry.canonical = canonical; Object.assign(entry, location(canonical, entry.id)); canonicals.set(key, entry);
      }
      const wait = pause(); if (wait) await wait;
    }
    for (const record of proxyDelta) {
      visit();
      const key = proxyKey(record), existing = proxies.get(key), proxy = existing ? mergeProxy(existing.proxy!, record) : record;
      if (!existing || JSON.stringify(existing.proxy) !== JSON.stringify(proxy)) {
        const entry = existing ?? { id: `p:${key}`, order: order++, residual: false, ...location(proxy, `p:${key}`) };
        await touch(entry);
        entry.proxy = proxy; Object.assign(entry, location(proxy, entry.id)); proxies.set(key, entry);
      }
      const wait = pause(); if (wait) await wait;
    }
    const dirty = new Set<Component>();
    const additions = await orderedEntries(affected, pause,
      (a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : a.start - b.start || a.order - b.order, visit);
    let cursor = 0;
    while (cursor < additions.length) {
      visit();
      const entry = additions[cursor++], group = entry.group;
      const component: Component = { start: entry.start, end: entry.end, entries: new Set([entry]) };
      let root = roots.get(group);
      while (true) {
        const before = predecessor(root, component.start);
        const overlap = before && before.end >= component.start ? before : successor(root, component.start);
        if (overlap && overlap.start <= component.end) {
          root = remove(root, overlap.start);
          component.start = Math.min(component.start, overlap.start); component.end = Math.max(component.end, overlap.end);
          for (const member of overlap.entries) { visit(); component.entries.add(member); const wait = pause(); if (wait) await wait; }
          continue;
        }
        const next = additions[cursor];
        if (!next || next.group !== group || next.start > component.end) break;
        visit(); component.entries.add(next); component.end = Math.max(component.end, next.end); cursor++;
        const wait = pause(); if (wait) await wait;
      }
      for (const member of component.entries) { visit(); member.component = component; const wait = pause(); if (wait) await wait; }
      const [left, right] = split(root, component.start);
      roots.set(group, merge(merge(left, { value: component, priority: priority() }), right)); dirty.add(component);
      const wait = pause(); if (wait) await wait;
    }
    for (const entry of affected) {
      visit();
      if (entry.residual) { residualCount--; entry.residual = false; }
      const wait = pause(); if (wait) await wait;
    }
    for (const component of dirty) {
      work.components++;
      const canonical: CanonicalUsageRecord[] = [], upstream: ProxyUsageRecord[] = [];
      const byRecord = new Map<ProxyUsageRecord, Entry>();
      // Stable insertion-order traversal preserves the public matcher's tie behavior.
      const entries = await orderedEntries(component.entries, pause, undefined, visit);
      for (const entry of entries) {
        visit();
        if (entry.canonical) { canonical.push(entry.canonical); work.canonical++; }
        else { upstream.push(entry.proxy!); byRecord.set(entry.proxy!, entry); work.proxy++; }
        const wait = pause(); if (wait) await wait;
      }
      const result = await reconcileUsageAsync(canonical, upstream);
      const unused = new Set<string>();
      for (const record of result.upstreamUnmatched) { visit(); unused.add(proxyKey(record)); const wait = pause(); if (wait) await wait; }
      for (const record of result.records) {
        visit();
        const key = canonicalKey(record), entry = canonicals.get(key)!;
        if (!entry.result || JSON.stringify(entry.result) !== JSON.stringify(record)) changed.set(key, record);
        entry.result = record;
        if (record.verification === 'matched') pending.delete(key); else pending.add(key);
        const wait = pause(); if (wait) await wait;
      }
      for (const proxy of upstream) {
        visit();
        const entry = byRecord.get(proxy)!;
        const residual = unused.has(proxyKey(proxy)) && proxy.sessionId !== null && (!options.sessionId || proxy.sessionId === options.sessionId);
        residualCount += Number(residual) - Number(entry.residual); entry.residual = residual;
        const wait = pause(); if (wait) await wait;
      }
    }
    const output: Reconciled[] = [];
    for (const record of changed.values()) { visit(); output.push(record); const wait = pause(); if (wait) await wait; }
    return { changed: output, hasSessionResidual: residualCount > 0, pendingIdentities: view, work };
  }
  return {
    replaceBaseline(records: readonly (CanonicalUsageRecord | Reconciled)[], upstream: readonly ProxyUsageRecord[] = []) {
      return enqueue(async () => {
        const canonical: CanonicalUsageRecord[] = [], proxy: ProxyUsageRecord[] = [];
        const pause = context();
        // Full upstream order owns equal-interval ties; embedded evidence is only a fallback.
        for (const record of upstream) { proxy.push(record); const wait = pause(); if (wait) await wait; }
        for (const row of records) {
          const { verification: _v, upstream: evidence, ...record } = row as Reconciled;
          canonical.push(record); if (evidence) proxy.push(evidence);
          const wait = pause(); if (wait) await wait;
        }
        return apply(canonical, proxy, true);
      });
    },
    update(canonicalDelta: readonly CanonicalUsageRecord[], proxyDelta: readonly ProxyUsageRecord[]) {
      return enqueue(() => apply(canonicalDelta, proxyDelta));
    },
  };
}

/** Cooperative stable merge sort; no synchronous Array.sort on a large affected component. */
async function orderedEntries(
  values: Set<Entry>, pause: () => Promise<void> | undefined, compare: (a: Entry, b: Entry) => number = (a, b) => a.order - b.order,
  visit: () => void = () => {},
): Promise<Entry[]> {
  let source: Entry[] = [], target: Entry[];
  for (const entry of values) { visit(); source.push(entry); const wait = pause(); if (wait) await wait; }
  target = new Array(source.length);
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length);
      let left = start, right = middle;
      for (let out = start; out < end; out++) {
        visit();
        target[out] = left < middle && (right >= end || compare(source[left], source[right]) <= 0) ? source[left++] : source[right++];
        const wait = pause(); if (wait) await wait;
      }
    }
    [source, target] = [target, source];
  }
  return source;
}

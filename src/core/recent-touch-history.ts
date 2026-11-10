/** Recover known human messages from Walnut-owned records, never task update timestamps. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { mergeRecentOpened, type RecentOpen } from './recent-opened-list.js';

let cached: Promise<RecentOpen[]> | undefined;
export function resetRecentTouchHistoryForTest(): void { cached = undefined; }

/** Old versions did not record sends in Recent. Read that evidence once per server. */
export function recentTouchHistory(): Promise<RecentOpen[]> {
  return cached ??= readHistory();
}

type Stamped = { at?: unknown };
const human = (id: string, messages: readonly Stamped[] | undefined): RecentOpen[] =>
  (Array.isArray(messages) ? messages : []).filter((m) => typeof m?.at === 'string' && Number.isFinite(Date.parse(m.at)))
    .map((m) => ({ id, at: m.at as string, human: true as const }));

/** Bounded batches keep a busy account from opening thousands of files at once. */
async function inBatches(ids: readonly string[], read: (id: string) => Promise<RecentOpen[]>): Promise<RecentOpen[]> {
  let entries: RecentOpen[] = [];
  for (let i = 0; i < ids.length; i += 16) {
    const batch = await Promise.all(ids.slice(i, i + 16).map((id) => read(id).catch(() => [] as RecentOpen[])));
    entries = mergeRecentOpened(entries, batch.flat());
  }
  return entries;
}

async function readHistory(): Promise<RecentOpen[]> {
  // The user's own messages to tasks (sessions/user-asks.ts) and to Main and the VPs (their Threads).
  const asksDir = path.join(WALNUT_HOME, 'user-asks');
  const askIds = (await fs.readdir(asksDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  const { readUserAsks } = await import('./sessions/user-asks.js');
  const asks = await inBatches(askIds, async (id) => human(id, (await readUserAsks(id)).asks));
  const { threadTaskIds, readThreads } = await import('./org/threads-store.js');
  const threads = await inBatches(await threadTaskIds(), async (id) => human(id, (await readThreads(id)).threads.flatMap((t) => t.messages ?? [])));
  return mergeRecentOpened(asks, threads);
}

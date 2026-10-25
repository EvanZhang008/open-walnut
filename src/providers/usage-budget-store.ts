/**
 * Where the session daemon keeps its budgets: one JSON file per session under
 * `<dir>/v2/`, plus the price list the server last pushed. Writes to one file are
 * serialized, so a slow write can never land after a newer one. A file that
 * cannot be read locks only its own session (nothing is sent to it until a new
 * budget replaces it). Budgets of the first version (`<dir>/<sid>.json` marker
 * plus its `<sid>.jsonl` policy journal) carry over, and their files stay for a
 * daemon rolled back to that version. Every limit set here is also appended to
 * that journal (mirrorFirstVersion), so a rolled-back daemon still holds the
 * session: it cannot price this version's spend, so it reads the limit as
 * unverified and refuses sends until the user sets the budget there again.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBudgetPersistence } from './usage-budget-persistence.js';
import type { PriceSnapshot } from '../core/usage/price-data.js';
import type { UserPriceRates } from '../core/usage/price-resolve.js';

export type BudgetPauseReason = 'limit' | 'unpriced' | 'unreadable';

export interface BudgetState {
  limitUsd: number | null;
  /** What the session cost so far; null before the first check. */
  spentUsd: number | null;
  state: 'unlimited' | 'checking' | 'active' | 'paused';
  reason: BudgetPauseReason | null;
  revision: number;
  updatedAt: string | null;
  /** Requests the session made, and those with no price (any is a pause). */
  responses: number;
  unpricedResponses: number;
  /** The first model with no price, when that is why it paused. */
  unpricedModel?: string | null;
  /** Why the last check could not read the session's usage. */
  checkError?: string | null;
  pausedAt: string | null;
  /** One id per pause, so the server tells the user about each pause once. */
  pauseId: string | null;
  stopError: string | null;
  engine: string | null;
}

export interface BudgetPrices {
  snapshot?: PriceSnapshot;
  overrides?: Record<string, UserPriceRates>;
  /** The server's hash of what it pushed; an unchanged hash is not written again. */
  hash: string;
}

export interface StoredBudget extends BudgetState {
  version: 2;
  sid: string;
  /** The Walnut that set it (its data dir). */
  home?: string;
  cwd?: string;
  runtimeId?: string;
  /** Set when this daemon bound the worker id itself (at a start or a send); the server's view never overrides it. */
  runtimeBoundAt?: string;
  /** Earlier provider ids of the same session (an ACP thread that was started again), counted in its spend. */
  alsoSids?: string[];
  /** The stop of the current pause went through; false while it is still owed (also across a restart). */
  stopConfirmed?: boolean;
  /** This daemon saw the session answer (a stream line or an ACP turn end), so its usage must be readable. */
  answered?: boolean;
  unreadableSince?: string | null;
  checkedAt: string | null;
}

export const SID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function emptyBudget(sid: string, engine: string): StoredBudget {
  return { version: 2, sid, limitUsd: null, spentUsd: null, state: 'unlimited', reason: null, revision: 0, updatedAt: null,
    responses: 0, unpricedResponses: 0, unpricedModel: null, checkError: null, pausedAt: null, pauseId: null, stopError: null,
    engine, checkedAt: null };
}

export function createBudgetStore(options: { dir: string; now: () => number; log: (message: string, fields: Record<string, unknown>) => void }) {
  const dir = path.join(options.dir, 'v2');
  const persistence = createBudgetPersistence(fs, path);
  const writes = new Map<string, Promise<void>>();
  const file = (sid: string) => path.join(dir, `${sid}.json`);

  async function writeRaw(target: string, text: string, into = dir): Promise<void> {
    await persistence.ensureDirectory(into);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, target);
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  /** One write chain per file: each write takes the record as it is NOW, in call order. */
  function queue(key: string, target: string, text: string | null): Promise<void> {
    const work = (writes.get(key) ?? Promise.resolve()).catch(() => {})
      .then(() => text === null ? fs.unlink(target).catch(() => {}) : writeRaw(target, text));
    writes.set(key, work);
    void work.finally(() => { if (writes.get(key) === work) writes.delete(key); }).catch(() => {});
    return work;
  }

  return {
    save(record: StoredBudget): Promise<void> {
      record.updatedAt = new Date(options.now()).toISOString();
      return queue(record.sid, file(record.sid), JSON.stringify(record));
    },
    remove(sid: string): Promise<void> { return queue(sid, file(sid), null); },
    savePrices(prices: BudgetPrices): Promise<void> { return queue('\0prices', path.join(dir, 'prices.json'), JSON.stringify(prices)); },

    /** Every budget on disk; a file that cannot be read is named in `corrupt`. */
    async load(): Promise<{ budgets: StoredBudget[]; corrupt: Map<string, string>; prices?: BudgetPrices }> {
      const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return [] as string[]; throw error; });
      const budgets: StoredBudget[] = [];
      const corrupt = new Map<string, string>();
      let prices: BudgetPrices | undefined;
      if (names.includes('prices.json')) {
        try { prices = JSON.parse(await fs.readFile(path.join(dir, 'prices.json'), 'utf8')) as BudgetPrices; }
        catch (error) { options.log('budget prices could not be read', { error: String(error) }); }
      }
      for (const name of names) {
        const sid = name.slice(0, -5);
        if (!name.endsWith('.json') || name === 'prices.json' || !SID_RE.test(sid)) continue;
        try {
          const record = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as StoredBudget;
          if (record?.version !== 2 || record.sid !== sid) throw new Error('not a budget of this version');
          budgets.push(record);
        } catch (error) {
          corrupt.set(sid, String(error instanceof Error ? error.message : error));
          options.log('budget file could not be read; its session is held until a new budget is set', { sid, error: String(error) });
        }
      }
      const known = new Map<string, StoredBudget | null>([...budgets.map(b => [b.sid, b] as const), ...[...corrupt.keys()].map(sid => [sid, null] as const)]);
      for (const adopted of await this.firstVersion(known)) if (!known.has(adopted.sid)) budgets.push(adopted);
      return { budgets, corrupt, ...(prices ? { prices } : {}) };
    },

    /**
     * Budgets the first version holds and this one does not: carried over, checked
     * before anything is sent. A limit changed there after this version last wrote
     * it (a daemon rolled back, then forward again; its revision is higher) is
     * taken over by the budget here. Returns every record it added or changed.
     */
    async firstVersion(known: Map<string, StoredBudget | null>): Promise<StoredBudget[]> {
      const names = await fs.readdir(options.dir).catch(() => [] as string[]);
      const out: StoredBudget[] = [];
      for (const name of names) {
        const sid = name.slice(0, -6);
        const current = known.get(sid);
        if (!name.endsWith('.jsonl') || !SID_RE.test(sid) || current === null || !names.includes(`${sid}.json`)) continue;
        let policy: { limitUsd?: unknown; revision?: unknown } | undefined;
        try {
          for (const line of (await fs.readFile(path.join(options.dir, name), 'utf8')).split('\n')) {
            if (!line.includes('"policy"')) continue;
            try {
              const event = JSON.parse(line) as { kind?: string; policy?: typeof policy };
              if (event?.kind === 'policy' && event.policy && typeof event.policy === 'object') policy = event.policy;
            } catch { /* a torn line: the policies before it still hold */ }
          }
        } catch (error) { options.log('first-version budget could not be read', { sid, error: String(error) }); continue; }
        const revision = typeof policy?.revision === 'number' && Number.isSafeInteger(policy.revision) ? policy.revision : 0;
        const limitUsd = typeof policy?.limitUsd === 'number' && policy.limitUsd > 0 ? policy.limitUsd : null;
        if (current) {
          if (revision <= current.revision || !policy || (policy.limitUsd !== null && limitUsd === null)) continue;
          Object.assign(current, { limitUsd, revision },
            limitUsd === null
              ? { state: 'unlimited', reason: null, pausedAt: null, pauseId: null, stopError: null, stopConfirmed: undefined, checkError: null }
              : { state: 'checking' });
          await this.save(current);
          options.log('budget changed by the first budget version is taken over', { sid, limitUsd, revision });
          out.push(current);
          continue;
        }
        if (limitUsd === null) continue;
        const record: StoredBudget = { ...emptyBudget(sid, 'claude'), limitUsd, state: 'checking', revision };
        await this.save(record);
        options.log('budget carried over from the first budget version', { sid, limitUsd: record.limitUsd });
        out.push(record);
      }
      return out;
    },

    /**
     * Append this limit to the first version's journal, in its own format, so a
     * daemon rolled back to that version keeps a budget set here. Its sequence
     * follows the journal's last event; a journal that version could not read
     * anyway is left alone. Never throws: the budget here is already saved.
     */
    async mirrorFirstVersion(record: StoredBudget): Promise<void> {
      const marker = path.join(options.dir, `${record.sid}.json`);
      const journal = `${marker}l`;
      try {
        const text = await fs.readFile(journal, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (text === null && record.limitUsd === null) return;
        let sequence = 0;
        if (text) {
          if (!text.endsWith('\n')) throw new Error('the journal ends in a torn line');
          const last = JSON.parse(text.slice(0, -1).split('\n').pop() ?? '') as { sequence?: unknown };
          if (!Number.isSafeInteger(last?.sequence)) throw new Error('the journal\'s last event has no sequence');
          sequence = last.sequence as number;
        }
        await persistence.ensureDirectory(options.dir);
        const handle = await fs.open(journal, 'a', 0o600);
        try {
          const updatedAt = new Date(options.now()).toISOString();
          await handle.writeFile(`${JSON.stringify({ version: 2, kind: 'policy', updatedAt, sequence: sequence + 1,
            policy: { limitUsd: record.limitUsd, revision: record.revision, baselineComplete: false, unverifiedReason: null, stopError: null } })}\n`);
          await handle.sync();
        } finally { await handle.close(); }
        // That version finds a budget by its marker, written after the journal it names.
        if (!await fs.lstat(marker).then(() => true, () => false)) await writeRaw(marker, JSON.stringify({ version: 2, journal: path.basename(journal) }), options.dir);
      } catch (error) {
        options.log('budget was not mirrored for an older daemon', { sid: record.sid, error: String(error instanceof Error ? error.message : error) });
      }
    },

    /** Used only when the store itself could not be read: is there any budget file for this session? */
    async anyFile(sid: string): Promise<boolean> {
      for (const target of [file(sid), path.join(options.dir, `${sid}.json`)]) {
        try { await fs.lstat(target); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true; }
      }
      return false;
    },
  };
}

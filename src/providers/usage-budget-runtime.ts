import fs from 'node:fs/promises';
import path from 'node:path';
import { createUsageBudgets, type BudgetState } from './usage-budget-core.js';
import { scanHostUsage } from './usage-host-core.js';
import type { CanonicalUsageRecord } from './usage-scan-core.js';
import { scanProxyUsage, type ProxyUsageCheckpoint } from './usage-reconcile-core.js';
import { createBudgetTail } from './usage-budget-tail.js';
import { createUsageBudgetIndex } from './usage-budget-index.js';

export interface UsageBudgetRuntimeOptions {
  dir: string;
  projectsDir: string;
  pause: (sid: string) => Promise<void>;
  now?: () => number;
  log: (message: string, fields: Record<string, unknown>) => void;
}

export function createUsageBudgetRuntime(options: UsageBudgetRuntimeOptions) {
  const now = options.now ?? Date.now;
  const store = createUsageBudgets({ dir: options.dir });
  const tails = new Map<string, ReturnType<typeof createBudgetTail>>();
  function tailFor(sid: string) {
    let tail = tails.get(sid);
    if (!tail) { tail = createBudgetTail({ projectsDir: options.projectsDir }); tails.set(sid, tail); }
    return tail;
  }
  const configured = new Set<string>();
  const checks = new Map<string, Promise<void>>();
  const stopping = new Map<string, Promise<void>>();
  const proxyDirs = new Map<string, string>();
  const indices = new Map<string, ReturnType<typeof createUsageBudgetIndex>>();
  const checkpoints = new Map<string, Record<string, ProxyUsageCheckpoint>>();
  const settling = new Map<string, Promise<void>>();
  let sourceWrite: Promise<void> = Promise.resolve();
  let scanWork: Promise<void> = Promise.resolve();
  const sourceFile = path.join(options.dir, 'sources.map');
  const sourcesReady = fs.readFile(sourceFile, 'utf8').then(text => {
    const sources = JSON.parse(text) as Record<string, unknown>;
    for (const [sid, dir] of Object.entries(sources)) if (typeof dir === 'string') proxyDirs.set(sid, dir);
  }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const pending = new Map<string, Map<string, CanonicalUsageRecord>>();
  const durableChanges = new Map<string, Map<string, import('./usage-budget-core.js').BudgetUsageRecord>>();
  const canonicalHeld = new Set<string>();
  let polling: Promise<void> | undefined;
  let closed = false;
  async function poll() {
    if (polling || closed) return polling;
    const work = (async () => {
      await ready;
      if (initializationError) return;
      for (const sid of configured) {
        if (checks.has(sid)) continue;
        try {
          const scanned = await tailFor(sid).scan(sid);
          if (!scanned.complete) {
            canonicalHeld.add(sid);
            void pause(sid, await store.pauseUnverified(sid, 'canonical_unavailable')).catch(error => options.log('budget pause failed', { sid, error: String(error) }));
          } else if (canonicalHeld.has(sid)) {
            await store.clearCoverageHold(sid, 'canonical_unavailable');
            canonicalHeld.delete(sid);
          }
          for (const record of scanned.records) {
            const batch = pending.get(sid) ?? new Map<string, CanonicalUsageRecord>();
            batch.set(JSON.stringify([record.model, record.responseId]), record);
            pending.set(sid, batch);
          }
          await settle(sid);
        } catch (error) {
          canonicalHeld.add(sid);
          void pause(sid, await store.pauseUnverified(sid, 'canonical_unavailable')).catch(error => options.log('budget pause failed', { sid, error: String(error) }));
          options.log('budget canonical tail failed', { sid, error: String(error) });
        }
      }
    })();
    polling = work;
    try { await work; } finally { if (polling === work) polling = undefined; }
  }
  const pollTimer = setInterval(() => { void poll().catch(error => options.log('budget polling failed', { error: String(error) })); }, 500);
  pollTimer.unref();

  function held(budget: BudgetState) {
    return budget.state === 'paused' || budget.state === 'unverified';
  }
  async function pause(sid: string, budget: BudgetState) {
    if (!held(budget)) return;
    const existing = stopping.get(sid);
    if (existing) return existing;
    const work = options.pause(sid).then(() => store.markStopError(sid, null)).catch(async error => {
      await store.markStopError(sid, String(error));
      options.log('budget pause was not confirmed', { sid, error: String(error) });
    }).then(() => {});
    stopping.set(sid, work);
    try { await work; } finally { if (stopping.get(sid) === work) stopping.delete(sid); }
  }
  async function files(dir: string) {
    return (await fs.readdir(dir)).filter(name => name === 'proxy.log' || /^proxy\.log\.\d{4}-\d{2}-\d{2}$/.test(name))
      .map(name => path.join(dir, name));
  }
  async function recheck(sid: string) {
    const existing = checks.get(sid);
    if (existing) return existing;
    const work = scanWork.catch(() => {}).then(async () => {
      try {
        await polling;
        await pause(sid, await store.pauseUnverified(sid, 'checking_evidence'));
        const tail = createBudgetTail({ projectsDir: options.projectsDir });
        tails.set(sid, tail);
        const primed = await tail.scan(sid);
        const result = await scanHostUsage({ projectsDir: options.projectsDir, proxyLogDir: proxyDirs.get(sid),
          sessionIds: [sid], until: new Date(now()).toISOString(), lifetime: true });
        const complete = primed.complete && result.canonical.diagnostics.unreadable_files === 0
          && result.canonical.diagnostics.invalid_lines === 0 && result.canonical.diagnostics.missing_message_ids === 0
          && result.canonical.diagnostics.invalid_timestamps === 0 && result.upstream.coverage.allFilesRead
          && !result.reconciliation.upstreamUnmatched.some(record => record.sessionId === sid);
        const index = createUsageBudgetIndex({ sessionId: sid });
        await index.replaceBaseline(result.reconciliation.records, result.upstream.records);
        const budget = await store.replaceBaseline(sid, { records: result.reconciliation.records, complete });
        indices.set(sid, index);
        checkpoints.delete(sid);
        pending.delete(sid);
        durableChanges.delete(sid);
        if (complete) canonicalHeld.delete(sid);
        await pause(sid, budget);
      } catch (error) {
        const budget = await store.pauseUnverified(sid, 'collection_failed');
        await pause(sid, budget);
        options.log('budget evidence check failed', { sid, error: String(error) });
      }
    });
    scanWork = work.then(() => {}, () => {});
    checks.set(sid, work);
    try { await work; } finally { if (checks.get(sid) === work) checks.delete(sid); }
  }
  async function settle(sid: string) {
    const existing = settling.get(sid);
    if (existing) return existing;
    const work = settleNow(sid);
    settling.set(sid, work);
    try { await work; } finally { if (settling.get(sid) === work) settling.delete(sid); }
  }
  async function settleNow(sid: string) {
    const batch = pending.get(sid) ?? new Map<string, CanonicalUsageRecord>();
    try {
      const dir = proxyDirs.get(sid);
      const upstream = dir ? await scanProxyUsage({ files: await files(dir), sessionIds: [sid],
        offsets: checkpoints.get(sid) ?? {} }) : undefined;
      if (upstream && (!upstream.coverage.allFilesRead || upstream.diagnostics.length > 0)) {
        throw new Error('Upstream evidence could not be read completely');
      }
      if (upstream?.checkpoints) checkpoints.set(sid, upstream.checkpoints);
      if (!batch.size && !upstream?.records.length && !durableChanges.get(sid)?.size) return;
      const index = indices.get(sid);
      if (!index) throw new Error('Lifetime evidence must be checked before live matching');
      const captured = new Map(batch);
      const reconciled = await index.update([...captured.values()], upstream?.records ?? []);
      const changes = durableChanges.get(sid) ?? new Map();
      durableChanges.set(sid, changes);
      for (const record of reconciled.changed) changes.set(JSON.stringify([record.model, record.responseId]), record);
      if (reconciled.hasSessionResidual) await store.pauseUnverified(sid, 'canonical_response_missing');
      else await store.clearCoverageHold(sid, 'canonical_response_missing');
      for (const [key, record] of changes) {
        await store.observe(sid, { record });
        if (changes.get(key) === record) changes.delete(key);
      }
      await store.clearCoverageHold(sid, 'upstream_unavailable');
      for (const [key, record] of captured) if (batch.get(key) === record) batch.delete(key);
      void pause(sid, await store.read(sid)).catch(error => options.log('budget pause failed', { sid, error: String(error) }));
    } catch (error) {
      checkpoints.delete(sid);
      void pause(sid, await store.pauseUnverified(sid, 'upstream_unavailable')).catch(failure => options.log('budget pause failed', { sid, error: String(failure) }));
      options.log('budget live evidence check failed', { sid, error: String(error) });
    }
  }
  let initializationError: unknown;
  const ready = sourcesReady.then(() => store.listConfigured()).then(async ids => {
    for (const sid of ids) {
      configured.add(sid);
      const budget = await store.pauseUnverified(sid, 'restart_evidence_check');
      void pause(sid, budget).catch(error => options.log('budget recovery pause failed', { sid, error: String(error) }));
    }
  }).catch(error => {
    initializationError = error;
    options.log('budget initialization failed; delivery remains held', { error: String(error) });
  });
  async function snapshot(sid: string) {
    const result = await store.summaries(sid);
    return { budget: result.budget, usage: { verifiedCostUsd: result.budget.spentUsd,
      verifiedCalls: result.verifiedCalls, unverifiedCalls: result.unverifiedCalls,
      byModel: result.byModel.map(({ name, ...row }) => ({ model: name, ...row })),
      byAgent: result.byAgent.map(({ name, ...row }) => ({ agent: name, ...row })) },
      checkedAt: result.budget.updatedAt };
  }
  return {
    async read(sid: string) { await ready; if (initializationError) throw initializationError; return snapshot(sid); },
    async configure(sid: string, request: { limitUsd: number | null; revision: number; proxyLogDir?: string }) {
      await ready;
      if (initializationError) throw initializationError;
      const sourceChanged = request.proxyLogDir !== undefined && request.proxyLogDir !== proxyDirs.get(sid);
      if (request.proxyLogDir) {
        proxyDirs.set(sid, request.proxyLogDir);
        const work = sourceWrite.catch(() => {}).then(async () => {
          await fs.mkdir(options.dir, { recursive: true, mode: 0o700 });
          const temporary = `${sourceFile}.${process.pid}.tmp`;
          await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(proxyDirs)), { mode: 0o600 });
          await fs.rename(temporary, sourceFile);
        });
        sourceWrite = work;
        await work;
      }
      const policy = await store.configure(sid, request);
      const budget = sourceChanged && policy.limitUsd !== null
        ? await store.pauseUnverified(sid, 'source_changed') : policy;
      if (budget.limitUsd !== null) configured.add(sid);
      else {
        configured.delete(sid);
        await store.pauseUnverified(sid, 'tracking_paused');
      }
      await pause(sid, budget);
      if (budget.limitUsd !== null && budget.spentUsd === null) void recheck(sid).catch(error => options.log('budget evidence recheck failed', { sid, error: String(error) }));
      return snapshot(sid);
    },
    async allow(sid: string): Promise<boolean> {
      await ready;
      if (initializationError) {
        try { await fs.lstat(path.join(options.dir, `${sid}.json`)); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      }
      if (!configured.has(sid)) return !(await store.read(sid)).stopError;
      if (checks.has(sid) || stopping.has(sid)) return false;
      if (polling) await polling;
      if (checks.has(sid) || stopping.has(sid) || pending.get(sid)?.size || durableChanges.get(sid)?.size) return false;
      const budget = await store.read(sid);
      return !checks.has(sid) && !stopping.has(sid) && !held(budget);
    },
    observe(sid: string, parsed: Record<string, unknown>) {
      if (!configured.has(sid) || !['assistant', 'result'].includes(String(parsed.type))) return;
      void poll().catch(error => options.log('budget polling failed', { sid, error: String(error) }));
    },
    recheck,
    poll,
    async recover() {
      await ready;
      if (initializationError) {
        const files = await fs.readdir(options.dir).catch(() => [] as string[]);
        for (const name of files) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name)) continue;
          await options.pause(name.slice(0, -5)).catch(error => options.log('budget initialization pause failed', { sid: name.slice(0, -5), error: String(error) }));
        }
        return;
      }
      for (const sid of configured) {
        await pause(sid, await store.pauseUnverified(sid, 'restart_evidence_check'));
        await recheck(sid);
      }
    },
    close() { closed = true; clearInterval(pollTimer); },
  };
}

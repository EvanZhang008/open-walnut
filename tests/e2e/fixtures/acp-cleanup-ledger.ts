/**
 * What a budget E2E started, and the proof that it is gone (the ACP and the
 * Claude budget E2E both use it). Every runtime id the
 * test asked to start is entered before the call; a start that spawned a worker
 * must be backed by the adapter's witness line (its pid, and the worker as its
 * parent), each checked against the command the test started. A start whose
 * processes were never seen is unproven: its cleanup can never pass, so the
 * scratch root is kept. The daemon child is recorded the same way, and is
 * signalled only while ps still shows the very process the test spawned.
 */
import { processGone, processIdentity, type Identity } from './process-identity.js';

export interface OwnedProcess { pid: number; lstart: string; command: string; role: 'adapter' | 'worker' | 'daemon' | 'local-daemon' | 'session-host' | 'cli' }
type IdentityFn = (pid: number) => Identity;
type GoneFn = (p: { pid: number; lstart: string }) => boolean;

export function createCleanupLedger(deps: { identity?: IdentityFn; gone?: GoneFn } = {}) {
  const identity = deps.identity ?? (pid => processIdentity(pid));
  const gone = deps.gone ?? (p => processGone(p));
  const starts = new Map<string, { procs: OwnedProcess[]; unproven?: string }>();
  const daemons: OwnedProcess[] = [];
  const unprovenSingles: string[] = [];

  function own(pid: number, expected: string, role: OwnedProcess['role']): OwnedProcess {
    const seen = identity(pid);
    if (seen.state !== 'present' || !seen.command.includes(expected)) {
      throw new Error(`process ${pid} is not the ${role} this test started (${expected}): ${JSON.stringify(seen)}`);
    }
    return { pid, lstart: seen.lstart, command: seen.command, role };
  }

  /** A process the test (or the code under test, for itself) started and that runs now: its identity is pinned here. */
  function owned(pid: number, expected: string, role: OwnedProcess['role']): OwnedProcess {
    const p = own(pid, expected, role);
    daemons.push(p);
    return p;
  }

  return {
    /** Before asking for a start: the runtime id is the test's to clean up from now on. */
    created(sid: string): void { if (!starts.has(sid)) starts.set(sid, { procs: [] }); },
    /** The witness lines a start produced (adapter pid, worker = its parent). */
    spawned(sid: string, lines: Array<{ pid: number; ppid: number }>, expected: { adapter: string; worker: string }): void {
      const entry = starts.get(sid) ?? { procs: [] };
      starts.set(sid, entry);
      if (!lines.length) { entry.unproven = 'no witness line for a start that spawned a worker'; return; }
      try {
        for (const { pid, ppid } of lines) entry.procs.push(own(pid, expected.adapter, 'adapter'), own(ppid, expected.worker, 'worker'));
      } catch (error) { entry.unproven = (error as Error).message; throw error; }
    },
    /** A start whose outcome is unknown (its call failed or timed out): whatever it spawned is unproven. */
    unknown(sid: string, why: string): void { const e = starts.get(sid) ?? { procs: [] }; e.unproven = why; starts.set(sid, e); },
    sids(): string[] { return [...starts.keys()]; },
    /** Every process of this start proven gone; false while one runs or the start is unproven; throws when ps cannot tell. */
    allGone(sid: string): boolean {
      const entry = starts.get(sid);
      if (!entry) return true;
      if (entry.unproven) return false;
      return entry.procs.every(p => gone(p));
    },
    daemonSpawned(pid: number, expected: string): OwnedProcess {
      return owned(pid, expected, 'daemon');
    },
    owned,
    /**
     * A child known only from its own witness line, which may have exited before the
     * test looked: absent, or a pid whose command is no longer the child's, is gone;
     * still the child, it is pinned and must be gone by the verdict; ps unable to tell is unproven.
     */
    observed(pid: number, expected: string, role: OwnedProcess['role']): void {
      let seen: Identity;
      try { seen = identity(pid); } catch (error) { unprovenSingles.push(`${role} ${pid}: ${(error as Error).message}`); return; }
      if (seen.state === 'absent' || !seen.command.includes(expected)) return;
      if (!daemons.some(p => p.pid === pid && p.lstart === seen.lstart)) daemons.push({ pid, lstart: seen.lstart, command: seen.command, role });
    },
    /** May the test signal this daemon pid? Only while it is still the process it spawned. */
    stillOurs(p: OwnedProcess): boolean {
      const seen = identity(p.pid);
      return seen.state === 'present' && seen.lstart === p.lstart && seen.command === p.command;
    },
    /** Every reason the cleanup is not proven; empty when it is. */
    verdict(): string[] {
      const out: string[] = [];
      for (const [sid, entry] of starts) {
        if (entry.unproven) { out.push(`${sid}: ${entry.unproven}`); continue; }
        for (const p of entry.procs) {
          try { if (!gone(p)) out.push(`${sid}: ${p.role} ${p.pid} still runs (${p.command})`); }
          catch (error) { out.push(`${sid}: ${(error as Error).message}`); }
        }
      }
      for (const p of daemons) {
        try { if (!gone(p)) out.push(`${p.role} ${p.pid} still runs (${p.command})`); }
        catch (error) { out.push(`${p.role}: ${(error as Error).message}`); }
      }
      out.push(...unprovenSingles);
      return out;
    },
  };
}

/** Run cleanup work within a deadline; time running out is a failure, never a pass. */
export async function within<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

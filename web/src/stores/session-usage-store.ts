import type { SessionUsage } from '@/api/session-usage';

export interface SessionUsageSnapshot {
  data: SessionUsage | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** The HTTP status of the last failed read (400: this engine has no budget). */
  errorStatus?: number;
  /** The server said this session has no budget (null); the next turn's end asks again. */
  noBudget?: boolean;
}
interface UsageClient {
  fetch: (sessionId: string, signal: AbortSignal) => Promise<SessionUsage | null>;
  patch: (sessionId: string, limitUsd: number | null, revision: number) => Promise<SessionUsage>;
}
interface Entry {
  snapshot: SessionUsageSnapshot;
  listeners: Set<() => void>;
  generation: number;
  controller?: AbortController;
  pending?: Promise<SessionUsage | null>;
}
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** One read/write view for every panel of the same session in this browser. */
export class SessionUsageStore {
  private entries = new Map<string, Entry>();
  constructor(private client: UsageClient) {}
  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { snapshot: { data: null, loading: false, saving: false, error: null }, listeners: new Set(), generation: 0 };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }
  getSnapshot = (sessionId: string): SessionUsageSnapshot => this.entry(sessionId).snapshot;
  subscribe = (sessionId: string, listener: () => void): (() => void) => {
    const entry = this.entry(sessionId);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  };
  private publish(entry: Entry, patch: Partial<SessionUsageSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch };
    for (const listener of entry.listeners) listener();
  }
  private accept(sessionId: string, entry: Entry, data: SessionUsage): SessionUsage {
    if (data.sessionId !== sessionId) throw new Error('The usage response belongs to another session. Retry to refresh this session.');
    // A response begun before another writer's save cannot put its limit back.
    if (entry.snapshot.data && data.budget.revision < entry.snapshot.data.budget.revision) return entry.snapshot.data;
    return data;
  }
  refresh = (sessionId: string): Promise<SessionUsage | null> => {
    const entry = this.entry(sessionId);
    if (entry.snapshot.saving) return Promise.resolve(entry.snapshot.data);
    if (entry.pending) return entry.pending;
    const generation = ++entry.generation;
    const controller = new AbortController();
    entry.controller = controller;
    this.publish(entry, { loading: true });
    const pending = this.client.fetch(sessionId, controller.signal).then((data) => {
      if (generation !== entry.generation) return null;
      if (data === null) {
        // A budget it already showed stays: a host that has not adopted the session
        // after a restart says it does not know it (src/web/routes/usage.ts).
        if (entry.snapshot.data) {
          this.publish(entry, { error: null, errorStatus: undefined });
          return entry.snapshot.data;
        }
        this.publish(entry, { data: null, error: null, errorStatus: undefined, noBudget: true });
        return null;
      }
      const accepted = this.accept(sessionId, entry, data);
      this.publish(entry, { data: accepted, error: null, errorStatus: undefined, noBudget: false });
      return accepted;
    }).catch((error: unknown) => {
      if (generation === entry.generation) this.publish(entry, { error: messageOf(error), errorStatus: (error as { status?: number })?.status });
      return null;
    }).finally(() => {
      if (generation !== entry.generation) return;
      entry.pending = undefined;
      entry.controller = undefined;
      this.publish(entry, { loading: false });
    });
    entry.pending = pending;
    return pending;
  };
  save = async (sessionId: string, limitUsd: number | null, revision: number): Promise<SessionUsage> => {
    const entry = this.entry(sessionId);
    if (entry.snapshot.saving) throw new Error('A budget change is already saving. Wait for it to finish.');
    ++entry.generation;
    entry.controller?.abort();
    entry.controller = undefined;
    entry.pending = undefined;
    // Say Saving in the same frame, without pretending the daemon has applied it.
    this.publish(entry, { saving: true, loading: false });
    try {
      const data = this.accept(sessionId, entry, await this.client.patch(sessionId, limitUsd, revision));
      this.publish(entry, { data, error: null });
      return data;
    } finally {
      this.publish(entry, { saving: false });
    }
  };
}

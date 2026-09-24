import { fetchSessionSupervision, setSessionSupervision, terminateSession, type SessionSupervision } from '@/api/sessions';

export interface SupervisionSnapshot {
  value: SessionSupervision | null;
  error: string | null;
  loading: boolean;
  unavailable: boolean;
  writing: boolean;
  stopping: boolean;
  stopPending: boolean;
  requestedEnabled: boolean | null;
}

const EMPTY: SupervisionSnapshot = {
  value: null, error: null, loading: true, unavailable: false, writing: false,
  stopping: false, stopPending: false, requestedEnabled: null,
};

interface Entry {
  snapshot: SupervisionSnapshot;
  listeners: Set<() => void>;
  revision: number;
  read: Promise<void> | null;
  refreshAgain: boolean;
  actionError: string | null;
  timer: ReturnType<typeof setInterval> | null;
}

const entries = new Map<string, Entry>();

function entryFor(sid: string): Entry {
  let entry = entries.get(sid);
  if (!entry) {
    entry = { snapshot: EMPTY, listeners: new Set(), revision: 0, read: null, refreshAgain: false, actionError: null, timer: null };
    entries.set(sid, entry);
  }
  return entry;
}

function publish(entry: Entry, patch: Partial<SupervisionSnapshot>): void {
  entry.snapshot = { ...entry.snapshot, ...patch };
  for (const listener of entry.listeners) listener();
}

function release(sid: string, entry: Entry): void {
  if (!entry.listeners.size && !entry.read && !entry.snapshot.writing && entries.get(sid) === entry) entries.delete(sid);
}

export function getSessionSupervision(sid: string): SupervisionSnapshot {
  return entries.get(sid)?.snapshot ?? EMPTY;
}

export function subscribeSessionSupervision(sid: string, listener: () => void): () => void {
  const entry = entryFor(sid);
  entry.listeners.add(listener);
  if (!entry.timer) {
    entry.timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void refreshSessionSupervision(sid);
    }, 15_000);
    void refreshSessionSupervision(sid);
  }
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      if (entry.timer) clearInterval(entry.timer);
      entry.timer = null;
      release(sid, entry);
    }
  };
}

export function refreshSessionSupervision(sid: string): Promise<void> {
  const entry = entryFor(sid);
  if (entry.snapshot.writing || entry.read) {
    entry.refreshAgain = true;
    return entry.read ?? Promise.resolve();
  }
  const revision = entry.revision;
  entry.refreshAgain = false;
  entry.read = (async () => {
    try {
      const value = await fetchSessionSupervision(sid);
      if (entry.revision === revision) {
        publish(entry, { value, loading: false, unavailable: false, error: entry.actionError, stopPending: value.stopRequest?.state === 'pending' });
      }
    } catch (error) {
      if (entry.revision === revision) publish(entry, { loading: false, unavailable: true, error: entry.actionError ?? (error instanceof Error ? error.message : String(error)) });
    } finally {
      entry.read = null;
      if (entry.refreshAgain && entry.listeners.size && !entry.snapshot.writing) void refreshSessionSupervision(sid);
      release(sid, entry);
    }
  })();
  return entry.read;
}

export async function changeSessionSupervision(sid: string, enabled: boolean): Promise<void> {
  const entry = entryFor(sid);
  if (entry.snapshot.writing) return;
  entry.revision += 1;
  entry.actionError = null;
  publish(entry, { writing: true, requestedEnabled: enabled, error: null });
  try {
    const value = await setSessionSupervision(sid, enabled);
    publish(entry, { value, loading: false, unavailable: false, stopPending: value.stopRequest?.state === 'pending' });
  } catch (error) {
    entry.actionError = error instanceof Error ? error.message : String(error);
    publish(entry, { error: entry.actionError });
  } finally {
    publish(entry, { writing: false, requestedEnabled: null });
    if (entry.refreshAgain && entry.listeners.size) void refreshSessionSupervision(sid);
    release(sid, entry);
  }
}

export async function stopSupervisedSession(sid: string, force = false): Promise<void> {
  const entry = entryFor(sid);
  if (entry.snapshot.writing) return;
  entry.revision += 1;
  entry.actionError = null;
  publish(entry, { writing: true, stopping: true, error: null });
  try {
    const result = await terminateSession(sid, { force });
    publish(entry, { stopPending: result.status === 'pending' });
  } catch (error) {
    entry.actionError = error instanceof Error ? error.message : String(error);
    publish(entry, { error: entry.actionError });
    throw error;
  } finally {
    publish(entry, { writing: false, stopping: false });
    await refreshSessionSupervision(sid);
    release(sid, entry);
  }
}

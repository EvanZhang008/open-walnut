import { startHostFix, startSystemFix, type NotificationFixResult } from '@/api/notifications';

export type FixTarget = { host: string | string[] } | { system: 'backup' | 'search' };
export interface FixSnapshot { pending: boolean; error: string | null }
const EMPTY: FixSnapshot = { pending: false, error: null };
const states = new Map<string, FixSnapshot>();
const listeners = new Set<() => void>();

export function hostFixTargetKey(target: FixTarget): string {
  return 'host' in target
    ? `hosts:${JSON.stringify([...new Set(Array.isArray(target.host) ? target.host : [target.host])].sort())}`
    : `system:${target.system}`;
}
export function subscribeHostFix(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getHostFixSnapshot(target: FixTarget): FixSnapshot { return states.get(hostFixTargetKey(target)) ?? EMPTY; }
function publish(key: string, state: FixSnapshot): void {
  states.set(key, state);
  for (const listener of listeners) listener();
}

/** A credential group is one repair brief; only identical targets share failures. */
export async function runHostFix(target: FixTarget): Promise<NotificationFixResult | undefined> {
  const key = hostFixTargetKey(target);
  if (states.get(key)?.pending) return;
  publish(key, { pending: true, error: null });
  try {
    const result = 'host' in target ? await startHostFix(target.host) : await startSystemFix(target.system);
    if (typeof result?.taskId !== 'string' || !result.taskId.trim()
      || (result.sessionId !== undefined && (typeof result.sessionId !== 'string' || !result.sessionId.trim()))) {
      throw new Error('The repair did not return a valid task. Try again.');
    }
    // A later fault must ask the backend again, not inherit a stale repair pointer.
    publish(key, EMPTY);
    return result;
  } catch (error) {
    publish(key, { pending: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export function __resetHostFixStoreForTests(): void { states.clear(); listeners.clear(); }

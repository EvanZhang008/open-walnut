import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  fetchSessionControls,
  postSessionControl,
  type SessionControl,
} from '@/api/sessions';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useNotifications } from '@/contexts/notifications';
import { engineCaps } from '@/utils/engine-capabilities';
import { log } from '@/utils/log';

// ── One session, one controls snapshot ───────────────────────────────────────
//
// Provider-advertised controls belong to the SESSION, not to a mount: the same
// session routinely shows in a session column AND in the chat lane composer, and
// a per-mount `useState` copy meant a pick in one surface left the other on the
// old value with no delivery path (same anti-pattern as the mode pill's private
// record copy — see session-status-store's SessionSettingsPatch).
const controlsBySession = new Map<string, SessionControl[]>();
/** Per-session write/fetch counter: a response from an older request must not
 *  land on top of a newer one (the old per-mount `requestVersion` ref). */
const requestVersions = new Map<string, number>();
const listeners = new Set<() => void>();
/** Stable empty snapshot — a fresh [] per read is a useSyncExternalStore loop. */
const NO_CONTROLS: readonly SessionControl[] = [];

function nextRequestVersion(sessionId: string): number {
  const version = (requestVersions.get(sessionId) ?? 0) + 1;
  requestVersions.set(sessionId, version);
  return version;
}

function publishControls(sessionId: string, controls: readonly SessionControl[]): void {
  controlsBySession.set(sessionId, controls as SessionControl[]);
  for (const listener of listeners) listener();
}

export async function refreshSessionControls(sessionId: string): Promise<void> {
  const version = nextRequestVersion(sessionId);
  const response = await fetchSessionControls(sessionId);
  if (requestVersions.get(sessionId) === version) publishControls(sessionId, response.controls);
}

function subscribeControls(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Provider-advertised session controls (approval mode, plan mode, …). Only
 * engines whose permission surface IS a set of provider config options have
 * them; the native Claude mode set is a different channel (updateSession mode),
 * so for those engines this hook stays an empty no-op.
 */
export function useSessionControls(sessionId: string | undefined, engine: string | undefined) {
  const engineCatalog = useEngineCatalog();
  const { notify } = useNotifications();
  const hasControls = engineCaps(engine, engineCatalog).configModes;

  const getSnapshot = useCallback(
    (): readonly SessionControl[] => (sessionId && hasControls
      ? controlsBySession.get(sessionId) ?? NO_CONTROLS
      : NO_CONTROLS),
    [sessionId, hasControls],
  );
  const controls = useSyncExternalStore(subscribeControls, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!sessionId || !hasControls) return;
    const version = nextRequestVersion(sessionId);
    fetchSessionControls(sessionId)
      .then((response) => {
        if (requestVersions.get(sessionId) !== version) return;
        publishControls(sessionId, response.controls);
      })
      .catch((error) => {
        if (requestVersions.get(sessionId) !== version) return;
        publishControls(sessionId, NO_CONTROLS);
        log.warn('session-controls', 'failed to load session controls', {
          sessionId,
          error: String(error),
        });
      });
  }, [hasControls, sessionId]);

  const setControl = useCallback(async (id: string, value: string) => {
    if (!sessionId || !hasControls) return;
    const previous = controlsBySession.get(sessionId) ?? NO_CONTROLS;
    const version = nextRequestVersion(sessionId);
    // Optimistic on the SHARED snapshot: every surface showing this session
    // moves in the same frame, and the POST only confirms.
    publishControls(sessionId, previous.map((control) =>
      control.id === id ? { ...control, currentValue: value } : control));
    try {
      const response = await postSessionControl(sessionId, id, value);
      if (requestVersions.get(sessionId) === version) publishControls(sessionId, response.controls);
    } catch (error) {
      if (requestVersions.get(sessionId) === version) publishControls(sessionId, previous);
      log.warn('session-controls', 'failed to update session control', {
        sessionId,
        controlId: id,
        value,
        error: String(error),
      });
      notify({
        kind: 'operation-error',
        severity: 'error',
        title: 'Session setting could not be applied',
        body: error instanceof Error ? error.message : String(error),
        persistent: false,
        dedupKey: `session-control:${sessionId}:${id}`,
        sessionId,
      });
    }
  }, [hasControls, sessionId, notify]);

  return { controls: controls as SessionControl[], setControl };
}

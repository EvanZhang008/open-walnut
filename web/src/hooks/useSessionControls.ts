import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSessionControls,
  postSessionControl,
  type SessionControl,
} from '@/api/sessions';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { engineCaps } from '@/utils/engine-capabilities';
import { log } from '@/utils/log';

/**
 * Provider-advertised session controls (approval mode, plan mode, …). Only
 * engines whose permission surface IS a set of provider config options have
 * them; the native Claude mode set is a different channel (updateSession mode),
 * so for those engines this hook stays an empty no-op.
 */
export function useSessionControls(sessionId: string | undefined, engine: string | undefined) {
  const [controls, setControls] = useState<SessionControl[]>([]);
  const requestVersion = useRef(0);
  const engineCatalog = useEngineCatalog();
  const hasControls = engineCaps(engine, engineCatalog).configModes;

  useEffect(() => {
    const version = ++requestVersion.current;
    if (!sessionId || !hasControls) {
      setControls([]);
      return;
    }
    fetchSessionControls(sessionId)
      .then((response) => {
        if (requestVersion.current === version) setControls(response.controls);
      })
      .catch((error) => {
        if (requestVersion.current !== version) return;
        setControls([]);
        log.warn('session-controls', 'failed to load session controls', {
          sessionId,
          error: String(error),
        });
      });
  }, [hasControls, sessionId]);

  const setControl = useCallback(async (id: string, value: string) => {
    if (!sessionId || !hasControls) return;
    const version = requestVersion.current;
    let previous: SessionControl[] = [];
    setControls((current) => {
      previous = current;
      return current.map((control) =>
        control.id === id ? { ...control, currentValue: value } : control);
    });
    try {
      const response = await postSessionControl(sessionId, id, value);
      if (requestVersion.current === version) setControls(response.controls);
    } catch (error) {
      if (requestVersion.current === version) setControls(previous);
      log.warn('session-controls', 'failed to update session control', {
        sessionId,
        controlId: id,
        value,
        error: String(error),
      });
    }
  }, [hasControls, sessionId]);

  return { controls, setControl };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSessionControls,
  postSessionControl,
  type SessionControl,
} from '@/api/sessions';
import { log } from '@/utils/log';

export function useSessionControls(sessionId: string | undefined, engine: string | undefined) {
  const [controls, setControls] = useState<SessionControl[]>([]);
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    if (!sessionId || engine !== 'codex') {
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
  }, [engine, sessionId]);

  const setControl = useCallback(async (id: string, value: string) => {
    if (!sessionId || engine !== 'codex') return;
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
  }, [engine, sessionId]);

  return { controls, setControl };
}

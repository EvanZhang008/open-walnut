import { useEffect, useState, useRef, useCallback } from 'react';
import { wsClient, type ConnectionState } from '@/api/ws';

/** Initialize the singleton WS connection once on first use. */
let initialized = false;

export function useWebSocket() {
  const [connectionState, setConnectionState] = useState<ConnectionState>(wsClient.state);

  useEffect(() => {
    if (!initialized) {
      initialized = true;
      wsClient.connect();
    }

    const onStateChange = (state: ConnectionState) => setConnectionState(state);
    wsClient.onConnectionChange(onStateChange);
    // Sync initial state
    setConnectionState(wsClient.state);

    return () => {
      wsClient.offConnectionChange(onStateChange);
    };
  }, []);

  return { connectionState, sendRpc: wsClient.sendRpc.bind(wsClient) };
}

/**
 * Subscribe to a specific WebSocket event.
 * Callback is stable-reference safe (uses ref internally).
 */
export function useEvent(eventName: string, callback: (data: unknown) => void) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  const stableCallback = useCallback((data: unknown) => {
    cbRef.current(data);
  }, []);

  useEffect(() => {
    wsClient.onEvent(eventName, stableCallback);
    return () => {
      wsClient.offEvent(eventName, stableCallback);
    };
  }, [eventName, stableCallback]);
}

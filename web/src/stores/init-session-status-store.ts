import { wsClient } from '@/api/ws';
import { sessionStatusStore } from './session-status-store';

let initialized = false;

const handleStatusChanged = (data: unknown): void => {
  sessionStatusStore.ingestStatusEvent(data);
};

const handleSessionError = (data: unknown): void => {
  sessionStatusStore.ingestErrorEvent(data);
};

export function initSessionStatusStore(): void {
  if (initialized) return;
  initialized = true;
  wsClient.onEvent('session:status-changed', handleStatusChanged);
  // Older Claude-native servers may only carry error detail on session:error.
  // Versioned sessions reject this unversioned fallback automatically.
  wsClient.onEvent('session:error', handleSessionError);
}

import { VALID_SESSION_EFFORT_IDS } from '@open-walnut/core';
import type { SessionEffort } from '@open-walnut/core';
import { wsClient } from '@/api/ws';
import { sessionStatusStore, type SessionSettingsPatch } from './session-status-store';

function asEffort(value: unknown): SessionEffort | undefined {
  return typeof value === 'string' && VALID_SESSION_EFFORT_IDS.has(value)
    ? value as SessionEffort
    : undefined;
}

let initialized = false;

const handleStatusChanged = (data: unknown): void => {
  sessionStatusStore.ingestStatusEvent(data);
};

const handleSessionError = (data: unknown): void => {
  sessionStatusStore.ingestErrorEvent(data);
};

/**
 * Applied-settings read-back (the server pulled the CLI's get_settings). This is
 * the ONLY live delivery path for effectiveEffort, and it belongs in the shared
 * store rather than in one panel's private copy: the same session can be showing
 * in a session column AND in the chat lane composer, and only the surface that
 * happened to register a listener used to learn the truth.
 */
const handleSettingsApplied = (data: unknown): void => {
  if (!data || typeof data !== 'object') return;
  const d = data as {
    sessionId?: unknown;
    effectiveEffort?: unknown;
    requestedEffort?: unknown;
    model?: unknown;
  };
  if (typeof d.sessionId !== 'string' || !d.sessionId) return;
  const patch: SessionSettingsPatch = {};
  // `null` = "the CLI reports no effort set" — clear the stale reading rather
  // than leaving a dead value on the badge. Key present, value undefined.
  if ('effectiveEffort' in d) patch.effectiveEffort = asEffort(d.effectiveEffort);
  const requested = asEffort(d.requestedEffort);
  if (requested) patch.effort = requested;
  if (typeof d.model === 'string' && d.model) patch.model = d.model;
  if (Object.keys(patch).length === 0) return;
  sessionStatusStore.applySessionSettings(d.sessionId, patch);
};

export function initSessionStatusStore(): void {
  if (initialized) return;
  initialized = true;
  wsClient.onEvent('session:status-changed', handleStatusChanged);
  // Older Claude-native servers may only carry error detail on session:error.
  // Versioned sessions reject this unversioned fallback automatically.
  wsClient.onEvent('session:error', handleSessionError);
  wsClient.onEvent('session:settings-applied', handleSettingsApplied);
}

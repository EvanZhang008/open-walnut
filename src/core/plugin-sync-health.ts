/**
 * Per-plugin sync health: what the last ticks did, and what a failure means.
 *
 * Two readers, one writer. The sync loop in web/server.ts records every tick's
 * outcome here; the connection route (GET /api/integrations/:id/connection)
 * shows it next to the plugin's own account status, and the loop itself asks
 * `decideSyncFailureNotice` what to tell the human.
 *
 * The decision is the point of this module. Before it, every failure was "one
 * more consecutive failure" and the fifth one produced a card saying "run the
 * auth command", whether the cause was a revoked token or Microsoft's token
 * endpoint being down for twenty minutes (2026-09-11: eighteen such cards from a
 * transient outage, with a valid refresh token the whole time). A plugin that
 * classifies its errors (`authKind`, see PluginAuthFailure) now gets:
 *   - 'sign-in-required' → tell the human ONCE, immediately, with a Sign in
 *     button; retrying cannot fix a dead credential.
 *   - 'unreachable' / unclassified → stay quiet until the failure has repeated
 *     (REPEATING_THRESHOLD ticks in a row), then say the provider is not
 *     answering and that sync keeps retrying. No sign-in advice.
 *   - 'not-configured' → point at Settings, once.
 * Success clears the streak and the card lifecycle (publishRecovery) does the rest.
 */
import { pluginAuthFailureOf, type PluginAuthFailureKind, type PluginConnectionStatus } from './integration-types.js';

export interface PluginSyncHealth {
  /** ISO time of the last tick that completed. */
  lastOkAt?: string;
  /** ISO time of the last tick that threw. */
  lastFailureAt?: string;
  /** First line of the last failure, for the Settings panel. */
  lastError?: string;
  /** The auth class of the last failure, when the plugin said. */
  lastFailureKind?: PluginAuthFailureKind;
  consecutiveFailures: number;
}

/** How many failed ticks in a row before an UNCLASSIFIED failure becomes a card. */
export const REPEATING_THRESHOLD = 5;

const health = new Map<string, PluginSyncHealth>();

function entry(pluginId: string): PluginSyncHealth {
  let h = health.get(pluginId);
  if (!h) {
    h = { consecutiveFailures: 0 };
    health.set(pluginId, h);
  }
  return h;
}

export function recordSyncSuccess(pluginId: string, at: Date = new Date()): PluginSyncHealth {
  const h = entry(pluginId);
  h.lastOkAt = at.toISOString();
  h.consecutiveFailures = 0;
  delete h.lastFailureKind;
  return h;
}

export function recordSyncFailure(pluginId: string, err: unknown, at: Date = new Date()): PluginSyncHealth {
  const h = entry(pluginId);
  const auth = pluginAuthFailureOf(err);
  const message = err instanceof Error ? err.message : String(err);
  h.lastFailureAt = at.toISOString();
  h.lastError = message.split('\n')[0].slice(0, 300);
  h.consecutiveFailures += 1;
  if (auth) h.lastFailureKind = auth.authKind;
  else delete h.lastFailureKind;
  return h;
}

export function getSyncHealth(pluginId: string): PluginSyncHealth | undefined {
  const h = health.get(pluginId);
  return h ? { ...h } : undefined;
}

/** Test seam. */
export function _resetSyncHealthForTesting(): void {
  health.clear();
}

export type SyncFailureNoticeLevel = 'none' | 'sign-in' | 'not-configured' | 'repeating';

export interface SyncFailureNotice {
  level: SyncFailureNoticeLevel;
  /** Human title for the card. */
  title: string;
  /** One or two human sentences. */
  body: string;
  /** Button the card carries; the sign-in and config cases point at Settings. */
  action?: { label: string; to: string };
  /** The provider's own code, for the log line only. */
  code?: string;
}

/** Where the console shows a plugin's account link and config. */
export function pluginSettingsPath(_pluginId: string): string {
  return '/settings#plugin-store';
}

/**
 * What this failure should become for the human, given the streak so far.
 * Pure: the caller records the failure first (recordSyncFailure) and passes the
 * updated health in.
 */
export function decideSyncFailureNotice(
  pluginName: string,
  pluginId: string,
  err: unknown,
  health: Pick<PluginSyncHealth, 'consecutiveFailures'>,
): SyncFailureNotice {
  const auth = pluginAuthFailureOf(err);
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n')[0].slice(0, 300);
  const to = pluginSettingsPath(pluginId);

  if (auth?.authKind === 'sign-in-required') {
    return {
      level: 'sign-in',
      title: `${pluginName} needs you to sign in again`,
      body: `${pluginName} could not renew its credential${auth.authCode ? ` (${auth.authCode})` : ''}. `
        + 'Sync is paused until you sign in; retrying will not fix this.',
      action: { label: 'Sign in', to },
      ...(auth.authCode ? { code: auth.authCode } : {}),
    };
  }

  if (auth?.authKind === 'not-configured') {
    return {
      level: 'not-configured',
      title: `${pluginName} is not set up yet`,
      body: firstLine,
      action: { label: 'Open Settings', to },
    };
  }

  if (health.consecutiveFailures >= REPEATING_THRESHOLD) {
    const unreachable = auth?.authKind === 'unreachable';
    return {
      level: 'repeating',
      title: `${pluginName} sync keeps failing`,
      body: unreachable
        ? `${pluginName}'s provider has not answered for ${health.consecutiveFailures} attempts in a row. `
          + 'Your sign-in is fine; sync keeps retrying on its own.'
        : `${health.consecutiveFailures} sync attempts in a row have failed: ${firstLine}`,
      ...(auth?.authCode ? { code: auth.authCode } : {}),
    };
  }

  return { level: 'none', title: '', body: '' };
}

/** Per-plugin memory of whether the sign-in card is up (the loop owns one per plugin). */
export interface ConnectionWatch {
  noticed: boolean;
}

/**
 * The sign-in card can be due while sync still SUCCEEDS: the refresh token is
 * dead but the access token in hand has an hour left. The failure path above
 * never sees that. So after a good tick the loop asks the plugin's connection
 * status and this decides: raise the card once when the state says
 * sign-in-required, and retire it (recover) when the state leaves it again
 * (the human signed in). 'signing-in' is neither: the card stays up until the
 * flow completes.
 */
export function decideConnectionNotice(
  pluginName: string,
  pluginId: string,
  status: Pick<PluginConnectionStatus, 'state' | 'detail'> | null,
  watch: ConnectionWatch,
): { notice?: SyncFailureNotice; recovered: boolean } {
  if (!status) return { recovered: false };
  if (status.state === 'sign-in-required') {
    if (watch.noticed) return { recovered: false };
    watch.noticed = true;
    return {
      recovered: false,
      notice: {
        level: 'sign-in',
        title: `${pluginName} needs you to sign in again`,
        body: status.detail?.trim()
          || `${pluginName} could not renew its credential. Sign in again before sync stops.`,
        action: { label: 'Sign in', to: pluginSettingsPath(pluginId) },
      },
    };
  }
  if (status.state === 'signing-in') return { recovered: false };
  if (watch.noticed) {
    watch.noticed = false;
    return { recovered: true };
  }
  return { recovered: false };
}

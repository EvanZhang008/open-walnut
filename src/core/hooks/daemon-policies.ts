/**
 * Daemon policy descriptors — pure data, ZERO daemon code.
 *
 * These policies are enforced inside the session daemon (daemon-standalone.ts /
 * daemon-source.ts twins), configured via env AT SPAWN TIME. They appear in the
 * unified hook registry as runtime:'daemon' entries so every intervention
 * Walnut can perform is visible in one place — but the dispatcher never
 * executes them, and toggling one only takes effect after a daemon restart.
 */

import type { Config } from '../types.js';
import type { HookSettingDescriptor } from './settings.js';

export interface DaemonPolicyDescriptor {
  id: string;
  name: string;
  description: string;
  /** Pseudo hook points — daemon interception sites, not dispatcher points. */
  on: string[];
  /** Dot-path of the config key controlling it; null = always-on. */
  configPath: string | null;
  isEnabled: (config: Config) => boolean;
  /** Apply an enable/disable to a config patch. Absent = read-only. */
  setter?: (enabled: boolean) => Partial<Config>;
  /** Tunable knobs shown under the toggle in Settings → Hooks. Declared as
   *  data so the API/UI need no per-policy code (see hooks/settings.ts). */
  settings?: HookSettingDescriptor[];
  note: string;
}

const DAEMON_RESTART_NOTE = 'Read at daemon spawn — a change takes effect after the daemon restarts (next session start on that host after `npm run dev:prod`, or daemon idle-exit).';

export const DAEMON_POLICIES: DaemonPolicyDescriptor[] = [
  {
    id: 'session-only-cron-policy',
    name: 'Session-only cron enforcement',
    description: 'Denies durable CronCreate (persists to {cwd}/.claude/scheduled_tasks.json), injects a correction into bypass sessions, and strips a dying session\'s durable rows — guards against the CLI\'s directory-scoped scheduler-lock adoption, where another session sharing the directory executes a dead session\'s cron as if the user typed it.',
    on: ['daemon:cron-create', 'daemon:session-reap'],
    configPath: 'session.cron_policy',
    isEnabled: (c) => c.session?.cron_policy === 'session-only',
    setter: (enabled) => ({ session: { cron_policy: enabled ? 'session-only' : 'unrestricted' } } as Partial<Config>),
    note: DAEMON_RESTART_NOTE,
  },
  {
    id: 'foreign-cron-fire-marker',
    name: 'Foreign cron-fire provenance marker',
    description: 'When a cron created by ANOTHER session fires into this one (directory-lock adoption), the daemon appends a stream marker and a model-visible provenance warning. Observation only — never blocks the fire.',
    on: ['daemon:cron-fire'],
    configPath: null,
    isEnabled: () => true,
    note: 'Always on (observation, not intervention).',
  },
  {
    id: 'turn-error-auto-retry',
    name: 'Auto-retry turns killed by upstream errors',
    description: 'When a turn dies to a TRANSIENT upstream failure (API timeout, stalled stream, mid-response 5xx), the daemon resumes it with exponential backoff for up to the configured budget (default 12h). Runs ON the execution host, so it keeps retrying while this Mac is asleep or the SSH tunnel is down. Only errors positively identified as transient are retried: model refusals, auth failures, context overflow, user aborts, and anything unrecognized are treated as terminal and left for a human.',
    on: ['daemon:turn-result'],
    configPath: 'session.turn_retry.enabled',
    isEnabled: (c) => c.session?.turn_retry?.enabled === true,
    setter: (enabled) => ({ session: { turn_retry: { enabled } } } as Partial<Config>),
    // Defaults MUST match TURN_RETRY_DEFAULTS in providers/daemon-core.ts —
    // otherwise the UI shows one budget while the daemon enforces another.
    settings: [
      {
        key: 'budget_hours',
        label: 'Retry budget',
        path: 'session.turn_retry.budget_hours',
        type: 'number',
        unit: 'hours',
        default: 12,
        min: 0,
        max: 168,
        help: 'How long to keep retrying one outage. The clock starts at the first failure and resets after any successful turn. 0 disables retrying.',
      },
      {
        key: 'max_attempts',
        label: 'Max attempts',
        path: 'session.turn_retry.max_attempts',
        type: 'number',
        default: 200,
        min: 0,
        max: 10_000,
        help: 'Backstop for an error that fails instantly over and over.',
      },
      {
        key: 'backoff_seconds',
        label: 'First backoff',
        path: 'session.turn_retry.backoff_seconds',
        type: 'number',
        unit: 'seconds',
        default: 30,
        min: 1,
        max: 3_600,
        help: 'Wait before the first retry. It doubles on each attempt.',
      },
      {
        key: 'backoff_max_seconds',
        label: 'Max backoff',
        path: 'session.turn_retry.backoff_max_seconds',
        type: 'number',
        unit: 'seconds',
        default: 600,
        min: 1,
        max: 3_600,
        help: 'Ceiling for the doubling wait.',
      },
    ],
    note: DAEMON_RESTART_NOTE,
  },
  {
    id: 'permission-auto-respond-by-mode',
    name: 'Permission auto-respond (bypass mode)',
    description: 'In bypass mode with auto_approve_bypass, the daemon answers CLI permission control requests automatically instead of forwarding them to the UI.',
    on: ['daemon:permission-request'],
    configPath: 'session.auto_approve_bypass',
    isEnabled: (c) => c.session?.auto_approve_bypass !== false,
    setter: (enabled) => ({ session: { auto_approve_bypass: enabled } } as Partial<Config>),
    note: DAEMON_RESTART_NOTE,
  },
];

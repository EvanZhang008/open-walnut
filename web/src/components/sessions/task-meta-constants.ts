/**
 * Shared task-metadata constants (tier + priority options).
 * Used by TaskQuickActions kebab menu and SessionPathSelector meta footer.
 */

import type { TaskPriority } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import type { QuickStartTaskMeta } from './SessionPathSelector';

/** Quick-start defaults. Lives here (not in SessionPathSelector) so MetaFooter's
 *  "More · N" changed-from-default badge can import it without a runtime import
 *  cycle — both it and the picker share one definition of "default". */
export const DEFAULT_META: QuickStartTaskMeta = {
  unread: false,         // the phase machine marks it unread when the turn ends
  priority: 'none',
  // Satellite, not Focus: a launched session is "in flight", not necessarily
  // what the user is staring at right now — Focus filled up with every session
  // ever started. This is the tier EVERY fresh launcher opens on; see
  // freshLauncherMeta for why nothing is remembered across launches.
  pinTier: 'satellite',
  model: undefined,      // Auto — Claude/config default picks the model unless user overrides
  engine: undefined,     // Claude (native) unless the user picks Codex in the model picker
};

export const TIER_OPTIONS: { value: FocusTier; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'satellite', label: 'Satellite' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'wait', label: 'Wait' },
];

/** The launcher's RETIRED sticky-tier pref (see freshLauncherMeta for why the
 *  stickiness went away). Nothing reads it; MainPage's mount-time sweep deletes
 *  it, so a value mirrored by ui-prefs-sync can't linger as a dead synced pref. */
export const LEGACY_LAUNCHER_PIN_TIER_KEY = 'open-walnut-launcher-pin-tier';

/** Last cwd/host a session was launched on. Same `open-walnut-` prefix as the
 *  pin tier, so ui-prefs-sync mirrors it to the server and the memory follows
 *  the user across browsers. */
export const LAUNCHER_LAST_PATH_KEY = 'open-walnut-launcher-last-path';

export interface LastLaunchPath {
  cwd: string;
  /** null = local machine (matches the session record's own host convention). */
  host: string | null;
  /** Display alias for `host`, when the user picked it from a named host. */
  hostLabel?: string;
}

/** The cwd/host a new draft column opens on — read synchronously so the first
 *  paint needs zero network (the working-dirs cache is null until fetched).
 *  Returns null when nothing has been launched yet or the entry is unusable. */
export function readLastLaunchPath(): LastLaunchPath | null {
  try {
    const raw = localStorage.getItem(LAUNCHER_LAST_PATH_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { cwd, host, hostLabel } = parsed as Record<string, unknown>;
    if (typeof cwd !== 'string' || !cwd) return null;
    return {
      cwd,
      host: typeof host === 'string' && host ? host : null,
      ...(typeof hostLabel === 'string' && hostLabel ? { hostLabel } : {}),
    };
  } catch { /* storage disabled or corrupt JSON — behave like "never launched" */ }
  return null;
}

/** Remember where the user just launched. Written from exactly one place
 *  (launchQuickStart's tail) so the memory can't drift per entry point. */
export function rememberLaunchPath(path: LastLaunchPath): void {
  try { localStorage.setItem(LAUNCHER_LAST_PATH_KEY, JSON.stringify(path)); } catch { /* quota */ }
}

/**
 * Meta a freshly-opened launcher starts from — a plain copy of the defaults, so
 * EVERY new draft opens on Satellite.
 *
 * It used to apply the last tier the user picked (a mirrored `open-walnut-`
 * pref). That single pick then rode every later launch: one "Focus" on a genuinely
 * urgent session made months of ordinary sessions open on Focus, which is exactly
 * how the pinned working set filled up with things nobody was working on. Satellite
 * is the honest baseline for "in flight", and moving off it is a per-task judgement
 * — the background parse makes it (applyDraftParse writes pinTier while the human
 * hasn't touched the meta), and the human overrides in one click. Nothing is
 * remembered between launches on purpose.
 *
 * Still a function, not a const: callers mutate the object they get back.
 */
export function freshLauncherMeta(): QuickStartTaskMeta {
  return { ...DEFAULT_META };
}

// Keep in sync with TaskKebabMenu's TIER_COLORS: wait is amber (paused/blocked) —
// a grey wait was indistinguishable from Satellite's grey at a glance.
export const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  satellite: 'var(--tier-satellite, #5856d6)',
  backlog: 'var(--tier-backlog, #30b0c7)',
  wait: 'var(--tier-wait, #ff9f0a)',
};

/** Tier → color with a fallback for custom tier ids (all customs share one hue). */
export function tierColor(tier: FocusTier): string {
  return TIER_COLORS[tier] ?? 'var(--tier-custom)';
}

export const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

/** No PIN_CYCLE: the pin tier is picked directly in the shared PinTierPicker
 *  (all tiers visible as buttons), never cycled through by repeated clicks. */
export const PRIORITY_CYCLE: Array<TaskPriority | undefined> = [undefined, 'immediate', 'important', 'backlog'];

export function nextValue<T>(values: T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length];
}

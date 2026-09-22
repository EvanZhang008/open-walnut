/**
 * The ONE reader for `config.triage`.
 *
 * Every default and every clamp lives here, for the same reason the heartbeat's
 * do: config-manager spreads a parsed config.yaml OVER DEFAULT_CONFIG at the TOP
 * level, so a default seeded inside DEFAULT_CONFIG.triage would be dropped by any
 * file that has a `triage:` section at all. Readers also give one place to put
 * the "a typo must not be able to mint a session every 30 seconds" floor.
 *
 * Pure apart from the log lines: takes a config object, answers with resolved
 * numbers. No disk, no bus, no routine layer — bootstrap.ts turns this answer
 * into a routine.
 */

import { log } from '../../logging/index.js';
import { parseDuration, isWithinActiveHours } from '../../heartbeat/heartbeat-runner.js';
import {
  DEFAULT_TRIAGE_ACTIVE_HOURS,
  DEFAULT_TRIAGE_EVERY,
  DEFAULT_TRIAGE_EVERY_MESSAGES,
  DEFAULT_TRIAGE_MODE,
  DEFAULT_TRIAGE_SOURCES,
  MIN_TRIAGE_EVERY_MS,
  TRIAGE_MODES,
  TRIAGE_SOURCES,
  TRIAGE_WAKE_EVENTS,
  type TriageConfig,
  type TriageMode,
  type TriageSource,
} from './types.js';

/** Just the slice of config this reader needs (a whole `Config` satisfies it). */
export interface TriageConfigHolder {
  triage?: TriageConfig;
}

/** The resolved, clamped answer. What bootstrap.ts and the batch action read. */
export interface ResolvedTriageConfig {
  /**
   * Run triage at all. False when the user never enabled it AND when `every` is
   * "0" — "no interval" is how heartbeat spells "off", so triage spells it the
   * same way rather than inventing a second switch.
   */
  enabled: boolean;
  /** Why it is off, for the log line that explains an absent routine. */
  disabledReason?: 'config' | 'interval-zero';
  /** Batch interval in ms, never below MIN_TRIAGE_EVERY_MS. 0 only when off. */
  everyMs: number;
  /** Wake threshold. 0 = the clock is the only trigger. */
  everyMessages: number;
  /** Which inboxes feed a batch (may be empty = clock only). */
  sources: TriageSource[];
  /** The bus events those sources emit, in `sources` order. */
  wakeEvents: string[];
  mode: TriageMode;
  autoMarkRead: boolean;
  /** "HH:MM-HH:MM" local, or undefined for 24/7. */
  activeHours?: string;
}

function readEveryMs(raw: string | undefined): { everyMs: number; clamped: boolean } {
  const parsed = parseDuration(typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_TRIAGE_EVERY);
  if (parsed <= 0) return { everyMs: 0, clamped: false };
  if (parsed < MIN_TRIAGE_EVERY_MS) return { everyMs: MIN_TRIAGE_EVERY_MS, clamped: true };
  return { everyMs: parsed, clamped: false };
}

function readEveryMessages(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TRIAGE_EVERY_MESSAGES;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TRIAGE_EVERY_MESSAGES;
  return Math.max(0, Math.floor(n));
}

/**
 * An ABSENT key means both inboxes; a PRESENT array is filtered to the known
 * ones and may legitimately end up empty (the user asked for no event sources,
 * which leaves the clock as the only trigger). Unknown names are dropped rather
 * than failing the read — a config typo must not be able to stop triage dead.
 */
function readSources(raw: unknown): TriageSource[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TRIAGE_SOURCES];
  const known = new Set<string>(TRIAGE_SOURCES);
  const out: TriageSource[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().toLowerCase();
    if (known.has(name) && !out.includes(name as TriageSource)) out.push(name as TriageSource);
  }
  return out;
}

function readMode(raw: unknown): TriageMode {
  if (typeof raw === 'string') {
    const mode = raw.trim().toLowerCase();
    if ((TRIAGE_MODES as readonly string[]).includes(mode)) return mode as TriageMode;
  }
  return DEFAULT_TRIAGE_MODE;
}

/**
 * An ABSENT key takes the default window; an explicitly EMPTY string means 24/7.
 * Malformed windows are left as-is — isWithinActiveHours warns once and treats
 * them as "always active", which is the honest degradation for a clock filter.
 */
function readActiveHours(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return DEFAULT_TRIAGE_ACTIVE_HOURS;
  if (typeof raw !== 'string') return DEFAULT_TRIAGE_ACTIVE_HOURS;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve `config.triage` into the numbers every triage caller uses. */
export function readTriageConfig(config: TriageConfigHolder | null | undefined): ResolvedTriageConfig {
  const raw = config?.triage ?? {};
  const { everyMs, clamped } = readEveryMs(raw.every);
  if (clamped) {
    log.cron.info('triage: interval below the floor — using the minimum', {
      configured: raw.every, everyMs, minEveryMs: MIN_TRIAGE_EVERY_MS,
    });
  }
  const sources = readSources(raw.sources);
  const wantsEnabled = raw.enabled === true;
  const enabled = wantsEnabled && everyMs > 0;
  return {
    enabled,
    ...(enabled ? {} : { disabledReason: wantsEnabled ? 'interval-zero' as const : 'config' as const }),
    everyMs,
    everyMessages: readEveryMessages(raw.every_messages),
    sources,
    wakeEvents: sources.map((s) => TRIAGE_WAKE_EVENTS[s]),
    mode: readMode(raw.mode),
    autoMarkRead: raw.auto_mark_read === true,
    activeHours: readActiveHours(raw.active_hours),
  };
}

/**
 * Is NOW inside the configured window?
 *
 * WHERE THIS IS ENFORCED: not here and not in the routine. A routine has no
 * "skip this fire" hook, and teaching the generic `claude-code` executor about
 * triage's clock would make every other routine carry the concept. The batch
 * action (`inbox-triage-batch`, S13) runs BEFORE the executor and can already
 * decline a run with no batch, so it is the one place that both knows the clock
 * and can stop the run without a session being minted. S12 stores the window and
 * ships this helper; S13 calls it.
 */
export function isTriageWithinActiveHours(resolved: Pick<ResolvedTriageConfig, 'activeHours'>): boolean {
  return isWithinActiveHours(resolved.activeHours);
}

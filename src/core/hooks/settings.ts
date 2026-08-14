/**
 * Hook settings — the tunable knobs a hook exposes in Settings → Hooks.
 *
 * Before this, a hook could only be turned ON or OFF. Anything with a real
 * parameter (a retry budget, a backoff, a threshold) had to grow a hand-written
 * block in some other settings section, which split one feature across two
 * pages: the toggle lived under Hooks and its knobs lived somewhere else, and
 * every new knob meant new bespoke React state plus a new auto-save fingerprint.
 *
 * A hook now DECLARES its settings as data. The registry resolves each one's
 * current value from config, the API renders and writes them generically, and
 * the UI draws the right input from the descriptor — so adding a knob to any
 * hook is a few lines of data with no new plumbing.
 *
 * Everything here is pure (no I/O, no config import) so the whole
 * read-config → render → write-config round trip is unit-testable.
 */

/** One tunable knob. `path` is the dot-path into Config that stores it. */
export interface HookSettingDescriptor {
  /** Stable key, unique within the hook. Used as the PATCH payload key. */
  key: string;
  label: string;
  /** Dot-path into Config, e.g. 'session.turn_retry.budget_hours'. */
  path: string;
  type: 'number' | 'boolean';
  /** Shown next to a number input ('hours', 'seconds', …). */
  unit?: string;
  /** Value used when config holds nothing — MUST equal the runtime default,
   *  or the UI shows one number while the daemon uses another. */
  default: number | boolean;
  min?: number;
  max?: number;
  /** One line under the input explaining what the knob buys. */
  help?: string;
}

/** A descriptor plus its resolved current value (what GET /api/hooks returns). */
export interface HookSettingInfo extends HookSettingDescriptor {
  value: number | boolean;
}

/** Read a dot-path out of a nested object. Returns undefined for any missing
 *  link, so a half-written config never throws. */
export function getByPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Build the minimal nested patch that sets `path` to `value`.
 *
 * Deliberately minimal: it names ONLY the keys on the path, so the caller can
 * deep-merge it onto the live config without dragging along a stale copy of
 * everything else (two agents writing config concurrently is normal here).
 */
export function patchForPath(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const root: Record<string, unknown> = {};
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cur[keys[i]] = next;
    cur = next;
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Recursively merge `patch` into `current`, keeping every sibling key the patch
 * doesn't mention. Arrays and scalars replace wholesale — an array means the
 * exact list, not "append to what was there".
 */
export function deepMerge(current: unknown, patch: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(current[key], value);
  }
  return out;
}

/**
 * Fold a patch onto the current config, returning ONLY the top-level keys the
 * patch touches.
 *
 * updateConfig() replaces top-level keys wholesale, so each touched key must
 * arrive fully merged; and sending the WHOLE config back would make every
 * toggle rewrite unrelated sections (and clobber a concurrent writer).
 */
export function mergeTopLevel(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(current[key], value);
  }
  return out;
}

/** Resolve a descriptor against config: stored value when present and of the
 *  right type, else the declared default. */
export function resolveSetting(
  descriptor: HookSettingDescriptor,
  config: unknown,
): HookSettingInfo {
  const raw = getByPath(config, descriptor.path);
  let value = descriptor.default;
  if (descriptor.type === 'number' && typeof raw === 'number' && Number.isFinite(raw)) {
    value = raw;
  } else if (descriptor.type === 'boolean' && typeof raw === 'boolean') {
    value = raw;
  }
  return { ...descriptor, value };
}

export type SettingCoercion =
  | { ok: true; value: number | boolean }
  | { ok: false; error: string };

/**
 * Validate + coerce one incoming setting value.
 *
 * Rejects rather than silently clamps: a user who typed 999 hours should be told
 * the ceiling, not have it quietly rewritten (they'd never learn the real
 * limit). The daemon clamps again on read, because a hand-edited config.yaml
 * never passes through here at all.
 */
export function coerceSetting(
  descriptor: HookSettingDescriptor,
  raw: unknown,
): SettingCoercion {
  if (descriptor.type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, error: `${descriptor.key} must be a boolean` };
    return { ok: true, value: raw };
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (typeof raw !== 'number' || !Number.isFinite(n)) {
    return { ok: false, error: `${descriptor.key} must be a finite number` };
  }
  if (descriptor.min != null && n < descriptor.min) {
    return { ok: false, error: `${descriptor.key} must be >= ${descriptor.min}` };
  }
  if (descriptor.max != null && n > descriptor.max) {
    return { ok: false, error: `${descriptor.key} must be <= ${descriptor.max}` };
  }
  return { ok: true, value: n };
}

/**
 * Turn a `{ key: value }` settings payload into one merged config patch.
 *
 * All-or-nothing: one bad value rejects the whole payload, so a partially
 * applied write can never leave a hook half-configured.
 */
export function buildSettingsPatch(
  descriptors: HookSettingDescriptor[],
  payload: Record<string, unknown>,
  currentConfig: Record<string, unknown>,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  let merged: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(payload)) {
    const descriptor = descriptors.find((d) => d.key === key);
    if (!descriptor) return { ok: false, error: `Unknown setting "${key}"` };
    const coerced = coerceSetting(descriptor, raw);
    if (!coerced.ok) return { ok: false, error: coerced.error };
    merged = deepMerge(merged, patchForPath(descriptor.path, coerced.value)) as Record<string, unknown>;
  }
  return { ok: true, patch: mergeTopLevel(currentConfig, merged) };
}

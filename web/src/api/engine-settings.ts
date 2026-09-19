/**
 * Engine settings: the browser's client for "the settings a coding-agent engine
 * keeps in its OWN config files", read and written on the host where that
 * engine's sessions run.
 *
 * The shapes below MIRROR src/core/agents/engine-settings-service.ts. They are
 * copied rather than imported on purpose: the server module pulls node:crypto and
 * the engine registry, neither of which can enter a browser bundle. Keep the two
 * in step when the service grows a field.
 *
 * One rule this file encodes for its callers: every error body from these routes
 * is `{ error: string }` written for a person (a daemon that needs an upgrade
 * says so and says it self-heals; a lost write race says "try again"). ApiError
 * puts that text on `.message`, so a caller shows `error.message` VERBATIM and
 * never invents its own sentence for a status code.
 */
import { ApiError, apiGet, apiPatch } from './client';

/** The host value that means "this machine" everywhere in Walnut. */
export const LOCAL_HOST = '__local__';

export type EngineSettingType = 'boolean' | 'select' | 'text' | 'number';
export type EngineSettingValue = boolean | string | number;
/** Where the value being used comes from. `legacy` = an older file location the engine still falls back to. */
export type EngineSettingSource = 'file' | 'legacy' | 'default';
export type EngineSettingScope = 'sessions' | 'terminal' | 'updates';
export type EngineSettingsFileFormat = 'json' | 'toml-top-level';

export interface EngineSettingOption {
  value: string;
  label: string;
  help?: string;
}

export interface EngineSettingsFileView {
  id: string;
  /** Path as the engine resolves it on that host. */
  path: string;
  label: string;
  format: EngineSettingsFileFormat;
  exists: boolean;
  /** Parse error. The file's items read as unset and writes to it are refused. */
  error?: string;
}

export interface EngineSettingView {
  key: string;
  label: string;
  help: string;
  type: EngineSettingType;
  /** `select` only. */
  options?: EngineSettingOption[];
  /** `select` only: a value outside `options` is allowed. */
  allowCustom?: boolean;
  /** Engine behavior when the key is absent; null when it cannot be named. */
  default: EngineSettingValue | null;
  defaultLabel?: string;
  scope: EngineSettingScope;
  /** `text` only: completions, not an allowlist. */
  suggestions?: string[];
  placeholder?: string;
  /** `number` only. */
  min?: number;
  max?: number;
  /** `files[].id` this key is stored in. */
  file: string;
  /** What the engine will use right now. */
  value: EngineSettingValue | null;
  source: EngineSettingSource;
  /** An environment variable overrides the stored value. */
  envOverride?: { name: string; value: string };
  /** The file holds something the schema cannot represent, or the file is unreadable. */
  invalid?: string;
  /**
   * The older location a `legacy` value is being read from, when the server names
   * it. Optional: a server that does not send it leaves the row saying "an older
   * location the engine still reads" rather than guessing a path, because naming
   * the wrong file is worse than not naming one.
   */
  legacy?: { file: string; path: string };
}

export interface EngineSettingsGroupView {
  id: string;
  title: string;
  help: string;
  items: EngineSettingView[];
}

export interface EngineSettingsView {
  engine: string;
  displayName: string;
  host: string;
  /** One sentence about where these live and how the engine picks them up. */
  note?: string;
  /** Environment overrides were evaluated (the host's runtime env was known). */
  envChecked: boolean;
  files: EngineSettingsFileView[];
  groups: EngineSettingsGroupView[];
}

export interface EngineSettingsPatch {
  set?: Record<string, EngineSettingValue>;
  /** Remove the keys from the file, i.e. "reset to default". */
  unset?: string[];
}

/** A write answers with a FRESH read plus the keys it touched. Render this, never the optimistic value. */
export type EngineSettingsWriteResult = EngineSettingsView & { changed: string[] };

/**
 * Statuses these routes return BY DESIGN, so they are warned rather than logged
 * at error level (the error-log audit is how a real fault gets noticed):
 *   read: 404 the engine has no settings surface, 501 the host's daemon is too
 *           old, 502/504 the host could not be reached in time;
 *   write: 409 the engine rewrote the file while we were saving, plus the same
 *           host-side outcomes.
 */
const QUIET_READ_STATUSES = [404, 501, 502, 504];
const QUIET_WRITE_STATUSES = [409, 501, 502, 504];

/** Longer than the default 15s: the server has its own host deadline and answers
 *  504 within it, and its honest answer beats a client-side abort. */
const READ_TIMEOUT_MS = 20_000;
/** A write is a read-modify-write over the tunnel, with one retry on a lost race. */
const WRITE_TIMEOUT_MS = 30_000;

function settingsPath(engine: string): string {
  return `/api/engines/${encodeURIComponent(engine)}/settings`;
}

export function fetchEngineSettings(
  engine: string,
  host: string,
  opts?: { signal?: AbortSignal },
): Promise<EngineSettingsView> {
  return apiGet<EngineSettingsView>(settingsPath(engine), { host }, {
    signal: opts?.signal,
    timeoutMs: READ_TIMEOUT_MS,
    quietStatuses: QUIET_READ_STATUSES,
  });
}

export function patchEngineSettings(
  engine: string,
  host: string,
  patch: EngineSettingsPatch,
): Promise<EngineSettingsWriteResult> {
  // apiPatch takes no params bag, so the host rides the query string here.
  const url = `${settingsPath(engine)}?host=${encodeURIComponent(host)}`;
  return apiPatch<EngineSettingsWriteResult>(url, patch, {
    timeoutMs: WRITE_TIMEOUT_MS,
    quietStatuses: QUIET_WRITE_STATUSES,
  });
}

/**
 * The sentence to show a person. The server writes these for the user, so it is
 * used verbatim; only a failure with no message of its own gets words from here.
 */
export function engineSettingsErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : String(err ?? '').trim();
  return message || 'Could not reach the server.';
}

/**
 * What a failed write did to the file, as the server reports it in the error
 * body (`outcome`). Only 'not-written' licenses putting a control back where it
 * was: a deadline that fired after the daemon renamed the file, or a read-back
 * that failed after the write landed, both leave the NEW value on disk, and a
 * client-side timeout (no body at all) knows nothing either way.
 */
export type EngineSettingsWriteOutcome = 'not-written' | 'written' | 'unknown';

export function engineSettingsWriteOutcome(err: unknown): EngineSettingsWriteOutcome {
  if (err instanceof ApiError) {
    const outcome = (err.body as { outcome?: unknown } | undefined)?.outcome;
    if (outcome === 'not-written' || outcome === 'written' || outcome === 'unknown') return outcome;
    // A body without the field came from a server that predates it; its 4xx
    // statuses were all refusals.
    if (err.status >= 400 && err.status < 500) return 'not-written';
  }
  return 'unknown';
}

/** True for a request the UI itself cancelled (a switched host or engine). */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

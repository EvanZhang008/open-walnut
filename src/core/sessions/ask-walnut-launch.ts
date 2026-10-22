/**
 * "Ask Walnut" launch memory — the model + reasoning effort the user last
 * picked for a Personal-AI session, so the NEXT Ask Walnut starts on them.
 *
 * Why its own store: a folder's launch memory rides frequent-directories
 * (`lastLaunch`), which deliberately never records WALNUT_HOME (a server fact,
 * not a folder the user picked) and has no effort field. Ask Walnut's defaults
 * (Auto model, medium effort — see personal-ai-lane's buildLaneProfile) are the
 * first-run values only; every explicit pick made FOR an Ask Walnut session
 * moves them:
 *   - the draft's model pill at launch (quick-start route, walnutAgent)
 *   - the running session's picker: POST /:id/model, POST /:id/effort on a
 *     session whose task carries `walnut_agent`
 *
 * The SERVER applies the memory at spawn (quick-start): a launch that names no
 * model gets the remembered one, so a client that never saw the memory (a
 * retry, a draft opened before the pick, a non-web caller) can neither miss it
 * nor erase it. Only an explicit reset — the picker's Auto row, sent as
 * `'default'` — clears the model. `model` is the picker's RAW value
 * (host-catalog id or legacy alias), the same shape LaunchPrefs stores, so the
 * draft pill can re-select it verbatim.
 *
 * Every entry point is best-effort: a broken file reads as empty, a failed
 * write is logged and never fails the launch or the switch that triggered it.
 *
 * The cloud companion reads the Mac's pick from its personas copy (stage 4d,
 * replication/kinds/personas.ts `launchModel`/`launchEffort`) once it holds it,
 * unless its own file is newer than the copy (a pick made on the box itself).
 * The Mac's write starts a personas round (onAskWalnutLaunchWritten).
 */
import { ASK_WALNUT_LAUNCH_FILE } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { isCompanion } from '../server-role.js';
import {
  VALID_SESSION_EFFORT_IDS,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  type SessionEffort,
} from '../types.js';

export interface AskWalnutLaunchPrefs {
  /** Raw picker value. Absent = Auto (the CLI's own default). */
  model?: string;
  /** Absent = the lane default (config `agent.session_effort`, else medium). */
  effort?: SessionEffort;
}

interface AskWalnutLaunchStore extends AskWalnutLaunchPrefs {
  version: 1;
  updatedAt: string;
}

// Same in-process serialization as frequent-dirs: two writers in one tick
// (a model switch and an effort switch from one picker session) must not lose
// each other's field to a stale read-modify-write.
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release: () => void;
  writeLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release!());
}

/** A pick as stored, read back through the same rules as the file. */
function prefsOf(model: unknown, effort: unknown): AskWalnutLaunchPrefs {
  return {
    ...(typeof model === 'string' && model ? { model } : {}),
    ...(typeof effort === 'string' && VALID_SESSION_EFFORT_IDS.has(effort) ? { effort: effort as SessionEffort } : {}),
  };
}

async function readStoreWithTime(): Promise<{ prefs: AskWalnutLaunchPrefs; updatedAt: number }> {
  try {
    const parsed = await readJsonFile<Partial<AskWalnutLaunchStore> | null>(ASK_WALNUT_LAUNCH_FILE, null);
    if (!parsed || parsed.version !== 1) return { prefs: {}, updatedAt: 0 };
    return { prefs: prefsOf(parsed.model, parsed.effort), updatedAt: Date.parse(parsed.updatedAt ?? '') || 0 };
  } catch (err) {
    log.session.debug('ask-walnut-launch: failed to read store', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { prefs: {}, updatedAt: 0 };
  }
}

async function readStore(): Promise<AskWalnutLaunchPrefs> {
  return (await readStoreWithTime()).prefs;
}

/**
 * The companion's answer: the Mac's pick from the personas copy (any agent's row
 * carries it; the general agent's first), unless the box's own file was written
 * after the copy's rows were read. Null without a copy (the caller reads the file).
 */
async function companionLaunchPrefs(): Promise<AskWalnutLaunchPrefs | null> {
  try {
    const [{ copyKindAsOf }, { readPersonaCopy }] = await Promise.all([
      import('../replication/kinds/gate.js'), import('../replication/kinds/personas.js'),
    ]);
    const asOf = await copyKindAsOf('personas');
    if (asOf === null) return null;
    const row = await readPersonaCopy('general');
    if (!row) return null;
    const own = await readStoreWithTime();
    if (own.updatedAt > asOf) return own.prefs;
    return prefsOf(row.launchModel, row.launchEffort);
  } catch {
    return null;
  }
}

/** What the next Ask Walnut should start on. Empty object = first-run defaults. */
export async function getAskWalnutLaunchPrefs(): Promise<AskWalnutLaunchPrefs> {
  if (isCompanion()) {
    const fromCopy = await companionLaunchPrefs();
    if (fromCopy) return fromCopy;
  }
  return readStore();
}

/** Called after every write of the launch memory (the personas copy kind starts a round). */
const writeListeners = new Set<() => void>();
export function onAskWalnutLaunchWritten(cb: () => void): () => void {
  writeListeners.add(cb);
  return () => { writeListeners.delete(cb); };
}

/**
 * Record a pick. Each field is independent: `{ model: 'x' }` leaves the
 * remembered effort alone; an omitted key is untouched. `null`/`undefined`,
 * `''` or `'default'` for the model is an explicit reset to Auto and CLEARS it;
 * `null`/`undefined` clears the effort. A value that is not a known effort
 * level is ignored (callers validate upstream — garbage must not wipe a pick).
 * Nothing is written when the result equals what is stored: the file lives in
 * the synced data dir, and a launch that changes nothing must not feed a commit.
 */
export async function rememberAskWalnutLaunch(pick: {
  model?: string | null;
  effort?: SessionEffort | null;
}): Promise<void> {
  return withWriteLock(async () => {
    try {
      const prev = await readStore();
      const next: AskWalnutLaunchPrefs = { ...prev };
      if ('model' in pick) {
        const m = typeof pick.model === 'string' ? pick.model.trim() : '';
        if (m && m !== 'default') next.model = m;
        else delete next.model;
      }
      if ('effort' in pick) {
        if (pick.effort === null || pick.effort === undefined) delete next.effort;
        else if (VALID_SESSION_EFFORT_IDS.has(pick.effort)) next.effort = pick.effort;
      }
      if (next.model === prev.model && next.effort === prev.effort) return;
      const store: AskWalnutLaunchStore = { version: 1, updatedAt: new Date().toISOString(), ...next };
      await writeJsonFile(ASK_WALNUT_LAUNCH_FILE, store);
      for (const cb of writeListeners) { try { cb(); } catch { /* never fails the pick */ } }
    } catch (err) {
      log.session.warn('ask-walnut-launch: failed to record pick', {
        pick, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * The effort an Ask Walnut spawn should carry: the remembered one when the
 * model being launched can take it, else the lane default. Only an EXPLICIT
 * model is checked — Auto is resolved inside the CLI, and the static tables
 * know nothing about that resolution; if its default model can't take the
 * level, the CLI downgrades it (the picker's read-back shows the true value).
 */
export function resolveAskWalnutEffort(
  remembered: SessionEffort | undefined,
  model: string | undefined,
  fallback: SessionEffort,
): SessionEffort {
  if (!remembered) return fallback;
  if (!model) return remembered;
  const supported = remembered === 'max'
    ? modelSupportsMaxEffort(model)
    : remembered === 'xhigh'
      ? modelSupportsXhighEffort(model)
      : modelSupportsEffort(model);
  return supported ? remembered : fallback;
}

/**
 * Remember a running session's model/effort switch when — and only when — the
 * session is an Ask Walnut one (its task carries `walnut_agent`; never keyed on
 * the project name, same rule as the UI's amber title). Resolves once the
 * decision is made (memory written or deliberately not), so a caller may await
 * it or fire-and-forget it; it never throws.
 */
export async function rememberAskWalnutSessionPick(
  sessionId: string,
  pick: { model?: string | null; effort?: SessionEffort | null },
): Promise<void> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record?.taskId || record.lane) return;
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(record.taskId).catch(() => null);
    if (!task?.walnut_agent) return;
    await rememberAskWalnutLaunch(pick);
    log.session.info('Ask Walnut: launch memory updated from session pick', { sessionId, ...pick });
  } catch (err) {
    log.session.debug('ask-walnut-launch: session pick not recorded', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
 */
import { ASK_WALNUT_LAUNCH_FILE } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
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

async function readStore(): Promise<AskWalnutLaunchPrefs> {
  try {
    const parsed = await readJsonFile<Partial<AskWalnutLaunchStore> | null>(ASK_WALNUT_LAUNCH_FILE, null);
    if (!parsed || parsed.version !== 1) return {};
    return {
      ...(typeof parsed.model === 'string' && parsed.model ? { model: parsed.model } : {}),
      ...(typeof parsed.effort === 'string' && VALID_SESSION_EFFORT_IDS.has(parsed.effort)
        ? { effort: parsed.effort as SessionEffort } : {}),
    };
  } catch (err) {
    log.session.debug('ask-walnut-launch: failed to read store', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** What the next Ask Walnut should start on. Empty object = first-run defaults. */
export function getAskWalnutLaunchPrefs(): Promise<AskWalnutLaunchPrefs> {
  return readStore();
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

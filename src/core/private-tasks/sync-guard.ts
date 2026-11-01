/**
 * The last check before a task reaches a sync plugin: every plugin's `sync` is wrapped here when
 * it registers (integration-registry.ts), so no call site, today's or a future one, hands a
 * plugin a task Walnut keeps local.
 *
 *   - A task argument that is local, or held (`sync_hold`), is refused: nothing of it is sent.
 *   - Text about to go out (a create or full push: title, description, note, summary; a field
 *     update: that field) that matches one of the user's private words, or that the fast model
 *     judges private or cannot judge (push-check.ts), is refused, and the task is turned local
 *     (edit-stop.ts; sync-gate.ts tells the user and Main): the edit never leaves Walnut.
 *
 * A refusal throws PrivateTaskBlockedError, which the push paths read as "kept local", not as a
 * failed push.
 */
import { log } from '../../logging/index.js';
import type { IntegrationSync } from '../integration-types.js';
import type { Task } from '../types.js';
import { matchPrivateWords } from './private-words.js';
import { acceptedWords, checkPushText, isNeutralText, type PushText } from './push-check.js';

export class PrivateTaskBlockedError extends Error {
  readonly code = 'private_task';
  constructor(readonly taskId: string, readonly why: 'local' | 'words' | 'model', readonly entry?: string) {
    super(why === 'local'
      ? `Task ${taskId} is kept local: nothing of it is sent to an outside service`
      : why === 'words'
        ? `Task ${taskId} matches the private word "${entry}": it was kept local, nothing was sent`
        : `Task ${taskId} did not pass Walnut's check before the push: it was kept local, nothing was sent`);
    this.name = 'PrivateTaskBlockedError';
  }
}

/** True for the guard's refusal (a push path reads it as "kept local"). */
export function isPrivateTaskBlocked(err: unknown): err is PrivateTaskBlockedError {
  return err instanceof PrivateTaskBlockedError
    || (!!err && typeof err === 'object' && (err as { code?: unknown }).code === 'private_task');
}

const TEXT_FIELD_METHODS: Partial<Record<keyof IntegrationSync, true>> = {
  updateTitle: true, updateDescription: true, updateSummary: true, updateNote: true, updateConversationLog: true,
};
const FULL_TEXT_METHODS: Partial<Record<keyof IntegrationSync, true>> = { createTask: true, pushTask: true };
/** Methods whose arguments are tasks (associate/disassociate take two). */
export const TASK_ARG_METHODS = new Set<string>([
  'createTask', 'deleteTask', 'pushTask', 'prepareNewTask', 'associateSubtask', 'disassociateSubtask',
  'updateTitle', 'updateDescription', 'updateSummary', 'updateNote', 'updateConversationLog',
  'updatePriority', 'updatePhase', 'updateDueDate', 'updateProject', 'updateDependencies',
]);

/**
 * Methods that take a task but send nothing of it: each runs in Walnut, synchronously, on fields
 * Walnut already holds. A new method that takes a task goes in TASK_ARG_METHODS or here, with why
 * (tests/core/private-tasks/sync-guard-ratchet.test.ts).
 */
export const LOCAL_ONLY_TASK_METHODS: Readonly<Record<string, string>> = {
  validateContent: 'checks a value before it is written; synchronous, sends nothing',
  mergePulledTags: 'merges tags a pull brought in; synchronous, sends nothing',
  extractRemoteId: 'reads the remote id from ext; synchronous, sends nothing',
  extractRemoteIdAliases: 'reads remote id aliases from ext; synchronous, sends nothing',
};

/** A project deletion's task list: the tasks Walnut keeps local are left out (nothing of them is sent). */
export const TASK_LIST_METHODS = new Set<string>(['deleteProjectRemote']);

const isTask = (v: unknown): v is Task => !!v && typeof v === 'object' && typeof (v as Task).id === 'string' && 'source' in (v as object);

type WordsReader = () => Promise<readonly string[] | undefined>;
/** Why a push was stopped, as the task's hold records it. */
export interface PushStop {
  state: 'private' | 'unjudged';
  by: 'words' | 'model';
  reason: string;
  entry?: string;
}
type OnStop = (task: Task, stop: PushStop) => void;

const configWords: WordsReader = async () => (await (await import('../config-manager.js')).getConfig()).private_tasks?.words;
let readWords: WordsReader = configWords;
/** Stops started by a refused push, until they finish (edit-stop.ts settleEditStops waits on them). */
export const startingStops = new Set<Promise<unknown>>();
const defaultOnStop: OnStop = (task, stop) => {
  const p = import('./edit-stop.js').then((m) => m.stopSyncedTask(task.id, stop)).catch((err) =>
    log.task.warn('private tasks: edit stop failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) }));
  startingStops.add(p);
  void p.finally(() => startingStops.delete(p));
};
let onStop: OnStop = defaultOnStop;
let modelCheck = true;

/** Tests: replace where the words come from, what a refusal does, and whether the model check
 *  runs at all in the guard. */
export function setSyncGuardHooksForTest(hooks: { readWords?: WordsReader; onStop?: OnStop; modelCheck?: boolean } | null): void {
  if (!hooks) {
    readWords = configWords;
    onStop = defaultOnStop;
    modelCheck = true;
    return;
  }
  if (hooks.readWords) readWords = hooks.readWords;
  if (hooks.onStop) onStop = hooks.onStop;
  if (hooks.modelCheck !== undefined) modelCheck = hooks.modelCheck;
}

const FIELD_OF: Partial<Record<keyof IntegrationSync, keyof PushText>> = {
  updateTitle: 'title', updateDescription: 'description', updateSummary: 'summary', updateNote: 'note',
};

async function check(pluginId: string, method: string, args: unknown[]): Promise<void> {
  for (const arg of args) {
    if (isTask(arg) && (arg.source === 'local' || arg.sync_hold)) {
      log.task.warn('private tasks: a local task was refused before it reached a plugin', { pluginId, method, taskId: arg.id });
      throw new PrivateTaskBlockedError(arg.id, 'local');
    }
  }
  const task = args[0];
  if (!isTask(task)) return;
  const m = method as keyof IntegrationSync;
  const full = !!FULL_TEXT_METHODS[m];
  const fieldText = TEXT_FIELD_METHODS[m] && typeof args[1] === 'string' ? args[1] : null;
  if (!full && fieldText === null) return;
  // The text that goes out: the whole task, or the one field (an emptied or neutral field
  // carries nothing of the task).
  if (!full && isNeutralText(fieldText!)) return;
  const field = FIELD_OF[m];
  const outgoing: PushText = { title: task.title, description: task.description, note: task.note, summary: task.summary };
  if (field) (outgoing as unknown as Record<string, string>)[field] = fieldText!;
  const texts = full ? [outgoing.title, outgoing.description, outgoing.note, outgoing.summary] : [fieldText!];

  const accepted = new Set(await acceptedWords(task.id).catch(() => [] as readonly string[]));
  const words = (await readWords().catch(() => undefined))?.filter((w) => !accepted.has(w));
  const entry = matchPrivateWords(words, texts);
  if (entry) {
    log.task.warn('private tasks: a push matching a private word was stopped', { pluginId, method, taskId: task.id, entry });
    const { wordsReason } = await import('./birth.js');
    onStop(task, { state: 'private', by: 'words', reason: wordsReason(entry), entry });
    throw new PrivateTaskBlockedError(task.id, 'words', entry);
  }

  if (!modelCheck) return;
  const { getConfig } = await import('../config-manager.js');
  const { privacyJudgeAvailable, serviceName } = await import('./sync-gate.js');
  if (!privacyJudgeAvailable(await getConfig())) return;
  const verdict = await checkPushText(task, outgoing, {
    service: await serviceName(pluginId),
    ...(m === 'updateConversationLog' ? { log: fieldText! } : {}),
  });
  if (verdict.ok) return;
  onStop(task, { state: verdict.state, by: 'model', reason: verdict.reason });
  throw new PrivateTaskBlockedError(task.id, 'model');
}

const GUARDED = Symbol('private-task-guard');

/** The plugin's sync with every task-carrying method checked first. Idempotent. */
const views = new WeakMap<IntegrationSync, IntegrationSync>();

export function guardSync(pluginId: string, sync: IntegrationSync): IntegrationSync {
  if ((sync as unknown as Record<symbol, unknown>)[GUARDED]) return sync;
  const seen = views.get(sync);
  if (seen) return seen;
  const wrapped = new Proxy(sync, {
    get(target, prop, receiver) {
      if (prop === GUARDED) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      if (TASK_LIST_METHODS.has(prop)) {
        return async (args: { tasks?: unknown[] } & Record<string, unknown>, ...rest: unknown[]) => {
          const tasks = Array.isArray(args?.tasks) ? args.tasks.filter((t) => !(isTask(t) && (t.source === 'local' || t.sync_hold))) : args?.tasks;
          return (value as (...a: unknown[]) => unknown).apply(target, [{ ...args, tasks }, ...rest]);
        };
      }
      if (!TASK_ARG_METHODS.has(prop)) return value;
      return async (...args: unknown[]) => {
        await check(pluginId, prop, args);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  views.set(sync, wrapped);
  return wrapped;
}

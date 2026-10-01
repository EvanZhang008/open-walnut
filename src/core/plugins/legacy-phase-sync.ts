/**
 * Phase projection for sync plugins built before a phase existed.
 *
 * A plugin compiled against an older `TaskPhase` treats the set as closed: a
 * `Record<TaskPhase, RemoteStep>` lookup on a name it never heard of yields
 * undefined, pushes nothing, and the next pull maps the remote step back onto an
 * old phase, which would end a WAITING task behind the user's back. So a plugin
 * that has not declared the phase in its manifest (`"phases": ["WAITING"]`)
 * receives task copies with `legacyPhase()` applied (WAITING reads as TODO), on
 * every call that hands it a task: the push methods, the content hooks, and the
 * `getTasks()` snapshot its poll compares against. A plugin that declares the
 * phase gets the real one. The held-phase guard in task-manager is the other
 * half: whatever the plugin writes back, a sync pull can move WAITING only to
 * COMPLETE.
 */
import { HELD_PHASES, legacyPhase, deriveStatusFromPhase } from '../phase.js';
import type { IntegrationSync, SyncPollContext } from '../integration-types.js';
import type { Task } from '../types.js';

/** True when the plugin's manifest says it understands every phase a task can be in. */
export function manifestKnowsHeldPhases(manifest: { phases?: unknown }): boolean {
  const declared = Array.isArray(manifest.phases) ? manifest.phases.filter((p): p is string => typeof p === 'string') : [];
  for (const phase of HELD_PHASES) if (!declared.includes(phase)) return false;
  return true;
}

/** The task as an older plugin expects it: a held phase folded onto its legacy bucket. */
export function legacyTaskView(task: Task): Task {
  if (!HELD_PHASES.has(task.phase)) return task;
  const phase = legacyPhase(task.phase);
  return { ...task, phase, status: deriveStatusFromPhase(phase), wait_until: undefined };
}

/** wrapper → the sync the plugin registered, for identity checks (a registration's dispose). */
const innerSync = new WeakMap<IntegrationSync, IntegrationSync>();

/** The sync a plugin handed in, behind the wrapper the loader keeps; the object itself when unwrapped. */
export function registeredSyncOf(sync: IntegrationSync | null | undefined): IntegrationSync | null {
  if (!sync) return null;
  return innerSync.get(sync) ?? sync;
}

export function wrapSyncForLegacyPhases(sync: IntegrationSync): IntegrationSync {
  const view = legacyTaskView;
  const wrapped: IntegrationSync = {
    createTask: (task) => sync.createTask(view(task)),
    deleteTask: (task) => sync.deleteTask(view(task)),
    updateTitle: (task, title) => sync.updateTitle(view(task), title),
    updateDescription: (task, description) => sync.updateDescription(view(task), description),
    updateSummary: (task, summary) => sync.updateSummary(view(task), summary),
    updateNote: (task, note) => sync.updateNote(view(task), note),
    updateConversationLog: (task, log) => sync.updateConversationLog(view(task), log),
    updatePriority: (task, priority) => sync.updatePriority(view(task), priority),
    updatePhase: (task, phase) => sync.updatePhase(view(task), legacyPhase(phase)),
    updateDueDate: (task, date) => sync.updateDueDate(view(task), date),
    updateProject: (task, project) => sync.updateProject(view(task), project),
    updateDependencies: (task, dependsOn) => sync.updateDependencies(view(task), dependsOn),
    associateSubtask: (parent, child) => sync.associateSubtask(view(parent), view(child)),
    disassociateSubtask: (parent, child) => sync.disassociateSubtask(view(parent), view(child)),
    pushTask: (task) => sync.pushTask(view(task)),
    syncPoll: (ctx) => sync.syncPoll(legacyPollContext(ctx)),
  };
  if (sync.validateContent) wrapped.validateContent = (task, field, value) => sync.validateContent!(view(task), field, value);
  if (sync.contentRequirement) wrapped.contentRequirement = (field) => sync.contentRequirement!(field);
  if (sync.prepareNewTask) wrapped.prepareNewTask = (task, ctx) => sync.prepareNewTask!(view(task), ctx);
  // Everything else (project container hooks, optional extras) passes through untouched.
  for (const key of Object.keys(sync) as Array<keyof IntegrationSync>) {
    if (!(key in wrapped)) (wrapped as unknown as Record<string, unknown>)[key] = (sync as unknown as Record<string, unknown>)[key];
  }
  innerSync.set(wrapped, sync);
  return wrapped;
}

function legacyPollContext(ctx: SyncPollContext): SyncPollContext {
  return {
    ...ctx,
    getTasks: () => ctx.getTasks().map(legacyTaskView),
  };
}

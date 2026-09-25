/**
 * The draft behind an "ask about this object" drawer, before its first question goes out.
 *
 * The drawer's composer is the same draft panel a Home draft column shows, with the same fork: Ask
 * Walnut (the default here, since the person opened it from "Ask Walnut about this") or Start Task,
 * a coding session in a folder and host they pick. Either way the object's context rides the first
 * message, the task starts in Focus like every new task, and More edits its tier, priority and dates.
 * Asked for on 2026-09-25: "default should be Ask Walnut, but can select Start Task, which can have a
 * different path", then "the new task should start in Focus, and should have a More".
 *
 * This file is the pure half (the row it starts from, the launch it sends, the task "for later" it
 * files), so the rules are graded without a DOM. The drawer owns the state (useAskObjectDraft.ts).
 */
import type { CreateTaskInput } from '@/api/tasks';
import { ASK_WALNUT_PROJECT, type DraftColumn } from '@/components/sessions/draft-column';
import { enterWalnutDraft, launchMetaFor } from '@/components/sessions/draft-ownership';
import { freshLauncherMeta } from '@/components/sessions/task-meta-constants';
import type { ImageAttachment } from '@/api/chat';
import { launchEngineForHost, normalizeEngine, type EngineCatalog } from '@/utils/engines';
import type { AskSessionLaunch } from './ask-object-session';
import { GENERAL_AGENT_ID } from './ask-walnut-slot-model';

export type TierKnown = (id: string) => boolean | 'unknown';

/**
 * The row a drawer opens on: a fresh Start Task draft switched to Ask Walnut through the same
 * transition the tab uses, so switching to Start Task restores exactly what a Home draft would (no
 * folder, Inbox, Focus) and switching back re-seeds the Ask Walnut project.
 */
export function initialAskDraft(id: string): DraftColumn {
  return enterWalnutDraft({ id, cwd: '', host: null, meta: freshLauncherMeta() });
}

/** The task fields a launch carries. `pinTier: null`, not absent: an unpinned pick must say so, or
 *  the server applies its own default tier. */
function taskMetaOf(draft: DraftColumn, tierKnown: TierKnown): NonNullable<AskSessionLaunch['taskMeta']> {
  const meta = launchMetaFor(draft, tierKnown);
  return {
    unread: meta.unread,
    priority: meta.priority,
    pinTier: meta.pinTier ?? null,
    ...(meta.dueDate ? { due_date: meta.dueDate } : {}),
    ...(meta.startDate ? { start_date: meta.startDate } : {}),
    ...(meta.endDate ? { end_date: meta.endDate } : {}),
  };
}

/**
 * The quick-start body for the drawer's first message, in whichever mode the draft is in.
 *
 * Mirrors the Home draft column's launch (MainPage `launchQuickStart`): Ask Walnut owns its cwd and
 * forces the native engine; Start Task sends the picked folder and host, the engine the host can run,
 * and the model only when it was picked under that engine (catalogs do not overlap).
 */
export function askLaunchBody(input: {
  draft: DraftColumn;
  agentId: string;
  message: string;
  images?: ImageAttachment[];
  tierKnown: TierKnown;
  catalog: EngineCatalog;
}): AskSessionLaunch {
  const { draft, agentId, message, images, tierKnown, catalog } = input;
  const meta = draft.meta;
  const taskMeta = taskMetaOf(draft, tierKnown);
  const withImages = images?.length ? { images } : {};
  if (draft.walnut) {
    return {
      cwd: '',
      message,
      ...withImages,
      walnutAgent: true,
      ...(agentId === GENERAL_AGENT_ID ? { project: draft.project || ASK_WALNUT_PROJECT } : { agentId }),
      taskMeta,
      ...(meta.model ? { model: meta.model } : {}),
    };
  }
  const engine = launchEngineForHost(meta.engine, draft.host, catalog);
  const pickedUnder = normalizeEngine(meta.engine) ?? 'claude';
  const model = pickedUnder === (engine ?? 'claude') ? meta.model : undefined;
  return {
    cwd: draft.cwd,
    ...(draft.host ? { host: draft.host } : {}),
    message,
    ...withImages,
    taskMeta,
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
    ...(draft.project ? { project: draft.project } : {}),
    ...(draft.project && draft.projectSource === 'folder' ? { projectFromFolder: true } : {}),
    ...(draft.createCwd ? { createCwd: true } : {}),
  };
}

/**
 * "Create task for later" from the drawer: the first line is the title, the rest and then the object's
 * context are the description, so the task still says which mail it is about (the block carries the
 * Walnut link back to it). Null when there is no title to file.
 */
export function askTaskForLater(input: {
  draft: DraftColumn;
  text: string;
  contextBlock: string;
  tierKnown: TierKnown;
}): CreateTaskInput | null {
  const [first, ...rest] = input.text.split('\n');
  const title = first.trim();
  if (!title) return null;
  const meta = launchMetaFor(input.draft, input.tierKnown);
  const description = [rest.join('\n').trim(), input.contextBlock.trim()].filter(Boolean).join('\n\n');
  const tier = meta.pinTier;
  return {
    title,
    priority: meta.priority,
    ...(description ? { description } : {}),
    // Start Task only (the panel hides this exit in Ask Walnut mode), so the project is the person's.
    ...(input.draft.project ? { project: input.draft.project } : {}),
    ...(tier ? { pinned: true, ...(input.tierKnown(tier) !== false ? { focus_tier: tier } : {}) } : { pinned: false }),
    ...(meta.dueDate ? { due_date: meta.dueDate } : {}),
    ...(meta.startDate ? { start_date: meta.startDate } : {}),
    ...(meta.endDate ? { end_date: meta.endDate } : {}),
  };
}

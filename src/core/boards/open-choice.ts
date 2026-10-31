/**
 * The Board choice a task's status says waits on the user, with what it offers, so the Org page
 * can answer it where the task is listed (web/src/components/org/OrgInlineAnswer.tsx). The same
 * rule src/core/user-status-sync.ts counts by: every Board, its unanswered choices in page order,
 * a choice naming its task by id or an unambiguous id prefix (4+ characters) and one that names
 * none being its Board owner's. A lead's Board often asks about its project's tasks, which are not
 * its subtasks, so the task's own team Board is not enough.
 */
import { choiceSpecs, type BoardChoiceOption } from './board-html.js';
import { getBoard, listBoardTaskIds } from './board-store.js';

export interface OpenChoice {
  /** The Board's task: the answer is written there. */
  owner: string;
  id: string;
  title: string;
  options: BoardChoiceOption[];
  recommended?: string;
}

/** A choice's `task` ref as the task id it names, or undefined when it names none or several. */
export function resolveChoiceRef(ref: string, allIds: readonly string[]): string | undefined {
  if (allIds.includes(ref)) return ref;
  if (ref.length < 4) return undefined;
  const hits = allIds.filter((t) => t.startsWith(ref));
  return hits.length === 1 ? hits[0] : undefined;
}

export async function openChoiceFor(taskId: string, allIds: readonly string[]): Promise<OpenChoice | null> {
  for (const owner of await listBoardTaskIds()) {
    const board = await getBoard(owner).catch(() => null);
    if (!board?.html) continue;
    for (const [id, spec] of Object.entries(choiceSpecs(board.html))) {
      if (board.choices?.[id]) continue; // answered
      const ref = spec.task?.trim();
      if ((ref ? resolveChoiceRef(ref, allIds) : owner) !== taskId) continue;
      return {
        owner, id, title: spec.title?.trim() ?? '', options: spec.options,
        ...(spec.recommended ? { recommended: spec.recommended } : {}),
      };
    }
  }
  return null;
}

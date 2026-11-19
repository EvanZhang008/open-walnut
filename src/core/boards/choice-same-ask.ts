/**
 * A new Board choice is an ask of the user like a status question or a decision letter: one its
 * task's tree, or another team about the same matter, already asks is refused the same way
 * (same-ask-tree.ts refuseSameAsk), unless the write gives same_ask_reason. A choice already on the
 * Board, or one the user answered, is never checked again.
 */
import { choiceSpecs } from './board-html.js';
import { resolveChoiceRef } from './open-choice.js';

/** The choices `after` adds to `before`, with the task each asks for (its `task`, else the Board's). */
export function newChoices(boardTaskId: string, before: string | undefined, after: string, allIds: readonly string[]): Array<{ id: string; taskId: string; text: string }> {
  const old = before ? choiceSpecs(before) : {};
  const out: Array<{ id: string; taskId: string; text: string }> = [];
  for (const [id, spec] of Object.entries(choiceSpecs(after))) {
    if (Object.hasOwn(old, id)) continue;
    const title = spec.title?.trim();
    if (!title) continue;
    const ref = spec.task?.trim();
    const taskId = ref ? resolveChoiceRef(ref, allIds) : boardTaskId;
    if (!taskId) continue;
    out.push({ id, taskId, text: [title, ...spec.options.map((o) => o.label)].join('\n') });
  }
  return out;
}

/** Refuse a Board write whose new choice asks what the user is already asked (409 same_ask). */
export async function refuseSameAskChoices(boardTaskId: string, before: string | undefined, after: string, input?: { same_ask_reason?: unknown } | null): Promise<void> {
  const { listTasks } = await import('../task-manager.js');
  const ids = (await listTasks().catch(() => [])).map((t) => t.id);
  const { refuseSameAsk } = await import('../same-ask-tree.js');
  for (const c of newChoices(boardTaskId, before, after, ids)) {
    const [title, ...options] = c.text.split('\n');
    // A choice's decision is the choice itself (ask-decision.ts statusDecision).
    const id = `choice:${boardTaskId}/${c.id}`;
    await refuseSameAsk(c.taskId, title, 'choice', input, options, { id, key: id, more: options.join('\n') });
  }
}

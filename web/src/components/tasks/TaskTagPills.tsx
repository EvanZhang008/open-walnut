/**
 * TaskTagPills — a task's own tags, as pills on the Homepage task row and in its
 * detail pane (the /tasks card and table draw the same TagChip).
 *
 * Machine tags ("walnut:…") are types that have a pill of their own (Imported),
 * so they never show here. A row has room for one next to its title; the rest
 * fold into "+N", whose tooltip names them. The detail pane passes a larger max.
 */
import { TagChip } from './TagChip';

export function userTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).filter((tag) => !tag.startsWith('walnut:'));
}

export function TaskTagPills({ tags, max = 1 }: { tags?: readonly string[]; max?: number }) {
  const shown = userTags(tags);
  if (shown.length === 0) return null;
  const rest = shown.slice(max);
  return (
    <span className="task-tag-pills" data-testid="task-tag-pills">
      {shown.slice(0, max).map((tag) => (
        <TagChip key={tag} tag={tag} inline />
      ))}
      {rest.length > 0 && (
        <span className="tag-chip tag-chip-overflow" title={rest.join(', ')}>+{rest.length}</span>
      )}
    </span>
  );
}

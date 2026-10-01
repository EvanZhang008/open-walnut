/**
 * TaskTagPills — a task's own tags, as pills on the Homepage task row and in its
 * detail pane (the /tasks card and table draw the same TagChip).
 *
 * Only the tags the display rules show (src/core/tag-display-rules.ts): Walnut's
 * machine tags ("walnut:…") are types with a pill of their own (Imported), and
 * any tag or namespace the user or a plugin hid stays off. A row or a pinned card
 * shows two next to its title (an id and its severity read together); the rest fold
 * into "+N", whose tooltip names them. The detail pane passes a larger max.
 */
import { TagChip } from './TagChip';
import { useTagDisplay } from '@/stores/tag-display-store';
import { shownTags } from '../../../../src/core/tag-display-rules';

/** The tags a task shows, in order: every surface that draws tag pills filters through this. */
export function useShownTags(tags: readonly string[] | undefined): string[] {
  const { compiled } = useTagDisplay();
  return shownTags(tags, compiled);
}

/** Tags this short keep their whole text when the pills are squeezed; longer ones give way. */
const WHOLE_TAG_MAX = 8;

export function TaskTagPills({ tags, max = 2 }: { tags?: readonly string[]; max?: number }) {
  const shown = useShownTags(tags);
  if (shown.length === 0) return null;
  const rest = shown.slice(max);
  return (
    <span className="task-tag-pills" data-testid="task-tag-pills">
      {shown.slice(0, max).map((tag) => (
        <TagChip key={tag} tag={tag} inline whole={tag.length <= WHOLE_TAG_MAX} />
      ))}
      {rest.length > 0 && (
        <span className="tag-chip tag-chip-overflow" title={rest.join(', ')}>+{rest.length}</span>
      )}
    </span>
  );
}

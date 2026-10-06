/**
 * TaskTagPills: a task's own tags, as pills on the Homepage task row, its detail
 * pane and the session header (the /tasks card and table draw the same TagChip).
 *
 * Only the tags the display rules show (src/core/tag-display-rules.ts): Walnut's
 * machine tags ("walnut:…") are types with a pill of their own (Imported), and
 * any tag or key the user or a plugin hid stays off. A tag whose rule says value
 * reads as its value alone ("V1234567890", a label's word), the same on every row.
 * A row or a pinned card shows two next to its title (an id and its severity read
 * together); the rest fold into "+N", whose tooltip names them. The detail pane
 * passes a larger max.
 */
import { TagChip } from './TagChip';
import { useTagDisplay } from '@/stores/tag-display-store';
import { shownTags, tagValue, type CompiledTagDisplay } from '../../../../src/core/tag-display-rules';
import { effectiveTags } from '../../../../src/core/tag-model';

type TaggedTask = { tags?: readonly string[]; created_at?: string; updated_at?: string };

/** The tags a task shows, in order: every surface that draws tag pills filters through this.
 *  Given the task, its own dates (`created:` / `updated:`) count too, for a rule that shows them. */
export function useShownTags(tags: readonly string[] | undefined, task?: TaggedTask): string[] {
  const { compiled } = useTagDisplay();
  return shownTags(task ? effectiveTags(task) : tags, compiled);
}

/** Tags this short keep their whole text when the pills are squeezed; longer ones give way. */
const WHOLE_TAG_MAX = 8;

/** The text a tag's pill reads under the rules. */
export function pillText(tag: string, compiled: CompiledTagDisplay): string {
  return compiled.valueOnly(tag) ? tagValue(tag) : tag;
}

export function TaskTagPills({ tags, task, max = 2, className }: { tags?: readonly string[]; task?: TaggedTask; max?: number; className?: string }) {
  const { compiled } = useTagDisplay();
  const shown = shownTags(task ? effectiveTags(task) : tags, compiled);
  if (shown.length === 0) return null;
  const rest = shown.slice(max);
  return (
    <span className={className ? `task-tag-pills ${className}` : 'task-tag-pills'} data-testid="task-tag-pills">
      {shown.slice(0, max).map((tag) => {
        const text = pillText(tag, compiled);
        return <TagChip key={tag} tag={tag} inline valueOnly={compiled.valueOnly(tag)} whole={text.length <= WHOLE_TAG_MAX} href={compiled.linkFor(tag)} />;
      })}
      {rest.length > 0 && (
        <span className="tag-chip tag-chip-overflow" title={rest.map((tag) => pillText(tag, compiled)).join(', ')}>+{rest.length}</span>
      )}
    </span>
  );
}

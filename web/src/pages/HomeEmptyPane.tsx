/**
 * The room beside Home's task panel when nothing is open there (no Quick question,
 * no session column, no triage). It says what the room is for and offers the one
 * next step, the same New task draft the toolbar's button opens, so no blank two
 * thirds of the window is left (standard.md "Panes": an empty area says what it is for).
 * Its button has its own name ("Start a task"): the toolbar's New task stays the one
 * control by that name, which the shortcut hint and every finder of it rely on.
 * The words are the shared pane state's (standard.md "Empty, loading and unavailable states").
 */
import { EmptyState } from '@/components/common/EmptyState';
import { ICON_CHAT } from '@/components/common/Icons';

interface HomeEmptyPaneProps {
  onNewTask: () => void;
}

export function HomeEmptyPane({ onNewTask }: HomeEmptyPaneProps) {
  return (
    <section className="home-empty-pane" data-testid="home-empty-pane" aria-label="No session open">
      <EmptyState
        size="pane"
        icon={ICON_CHAT}
        title="No session open"
        hint="Pick a task on the left to open its session, or start a new one."
        action={{ label: 'Start a task', onClick: onNewTask, testId: 'home-empty-pane-start' }}
      />
    </section>
  );
}

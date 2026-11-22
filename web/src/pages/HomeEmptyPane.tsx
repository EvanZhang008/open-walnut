/**
 * The room beside Home's task panel when nothing is open there (no Quick question,
 * no session column, no triage). It says what the room is for and offers the one
 * next step, the same New task draft the toolbar's button opens, so no blank two
 * thirds of the window is left (standard.md "Panes": an empty area says what it is for).
 */
import { NewLauncherButton } from '@/components/tasks/NewLauncherButton';

interface HomeEmptyPaneProps {
  onNewTask: () => void;
}

export function HomeEmptyPane({ onNewTask }: HomeEmptyPaneProps) {
  return (
    <section className="home-empty-pane" data-testid="home-empty-pane" aria-labelledby="home-empty-pane-title">
      <div className="home-empty-pane-inner">
        <h2 className="home-empty-pane-title" id="home-empty-pane-title">No session open</h2>
        <p className="home-empty-pane-hint">Pick a task on the left to open its session, or start a new one.</p>
        {/* The toolbar's own button: one New task, one look, the same shortcut. */}
        <NewLauncherButton onOpen={onNewTask} />
      </div>
    </section>
  );
}

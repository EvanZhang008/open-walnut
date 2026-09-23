/**
 * ImportedPill — marks a task the external-session importer still owns.
 *
 * The task's type is its import tag (EXTERNAL_SESSION_IMPORT_TAG): while it is
 * there the import tick may auto-complete the task once its session has been
 * idle for a week, and the first message anyone sends to the session removes
 * the tag. The pill therefore disappears on its own once the task is adopted;
 * nothing here is clickable or stateful.
 */
import { isExternalImportTask } from '@open-walnut/core';

export const IMPORTED_PILL_TITLE =
  'Imported: this session was started outside Walnut. It is completed automatically after a week without activity. Send it a message to adopt it.';

export function ImportedPill({ task, className }: { task: { tags?: string[] }; className?: string }) {
  if (!isExternalImportTask(task)) return null;
  return (
    <span
      className={`todo-item-due-pill todo-item-imported-pill${className ? ` ${className}` : ''}`}
      title={IMPORTED_PILL_TITLE}
      data-testid="imported-pill"
    >
      Imported
    </span>
  );
}

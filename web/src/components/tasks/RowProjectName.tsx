/**
 * The project name a task row shows above its title. With `onFilter` it is a link: a click
 * filters the panel to that project (project-jump.ts) and never opens the row. Every task row
 * that names its project draws it through here; tests/web/row-project-name-guard.test.ts fails
 * on a row that renders the name another way.
 */
import { memo } from 'react';
import { projectDisplayName } from '../../utils/project-display';

export const RowProjectName = memo(function RowProjectName({ project, className, onFilter }: {
  /** `''` = Inbox. */
  project: string;
  className: string;
  onFilter?: (project: string) => void;
}) {
  // Shown name only: data-project and onFilter keep the stored project.
  const name = projectDisplayName(project);
  if (!onFilter) return <span className={className}>{name}</span>;
  return (
    <button
      type="button"
      className={`${className} row-project-link`}
      data-testid="row-project-link"
      // Part of the row's text: the row still expands with the pointer on it (utils/truncation-peek.ts).
      data-peek-through=""
      data-project={project}
      title={`Show every task in ${name}`}
      onClick={(e) => { e.stopPropagation(); onFilter(project); }}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >{name}</button>
  );
});

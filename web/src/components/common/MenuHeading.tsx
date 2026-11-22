/**
 * The name of one section of a big menu (standard.md, "Big menus"): the task menu's Session and
 * Task halves, the composer + menu's Shortcuts and This task, a ContextMenu `section` row. One
 * look (`.wn-menu-heading`, overlay-family.css) for every menu, so a section reads the same
 * wherever it is; a bare rule only sets the danger section apart.
 */
import type { ReactNode } from 'react';

export function MenuHeading({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={`wn-menu-heading${className ? ` ${className}` : ''}`} role="presentation" data-testid={testId}>
      {children}
    </div>
  );
}

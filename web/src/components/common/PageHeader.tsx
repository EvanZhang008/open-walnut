/**
 * A page's head, the one way (standard "Page heads"; look in styles/page-head.css): the page's
 * title (`.page-title`, 20 px), the sentence under it, and at most one main key on the title's
 * line at the right: the page's New key (`NewKey`).
 *
 * 2026-11-26, the UI audit: Routines, Agents and Commands each wrote this row by hand, Routines
 * with its New key a line below the title, Agents and Commands with a typed "+" in Title Case
 * ("+ New Agent"). tests/web/page-head-guard.test.ts keeps every page title on `.page-title`.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ICON_PLUS } from './Icons';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** The page's one main key (a `NewKey`), on the title's line at the right. */
  action?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, action, className }: PageHeaderProps) {
  return (
    // No header-fit attributes: the key never folds, so the title wraps beside it instead of
    // cutting (standard "Text that does not fit": titles wrap, only metadata cuts).
    <div className={className ? `page-header ${className}` : 'page-header'}>
      <div className="page-header-text">
        <h1 className="page-title page-name">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

interface NewKeyProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Sentence case, the thing it makes: "New agent", "New message". */
  label: string;
  /** A drawn icon in place of the plus (Mail's pencil); never a typed "+". */
  icon?: ReactNode;
  /** The key's words fold away in a narrow column (Mail's head); the name stays in aria-label. */
  labelClassName?: string;
}

/**
 * The key that makes a new thing: the main key (`.btn.btn-primary`), a drawn plus and its words
 * in sentence case. A key that opens a form shows `aria-pressed` while the form is open (the
 * family's on look), so a second press closes it; a key whose form takes its place leaves the
 * head while the form is open (Agents, Commands).
 */
export function NewKey({ label, icon, labelClassName, className, type, ...rest }: NewKeyProps) {
  const on = rest['aria-pressed'] === true || rest['aria-pressed'] === 'true';
  return (
    <button
      type={type ?? 'button'}
      className={`btn${on ? '' : ' btn-primary'} new-key${className ? ` ${className}` : ''}`}
      aria-label={labelClassName ? label : undefined}
      {...rest}
    >
      {icon ?? ICON_PLUS}
      <span className={labelClassName}>{label}</span>
    </button>
  );
}

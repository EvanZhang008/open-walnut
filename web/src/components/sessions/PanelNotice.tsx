/**
 * A notice inside a session panel: an error, an auto-stop, a session that returned
 * empty, a folder that is gone. Its words use the whole width of the box: the small
 * icon sits at the start of the first line, and the actions, when there are any, sit
 * on their own row under the words. Never a column beside the text, at any width
 * (2026-11-04, the user, on a notice whose Reconnect button kept its own column the
 * whole height of the box: "never shoudl be liek this, one button liek just use so
 * much sapce and in narro modek the textcan only use another col"; in a narrow column
 * its text got a strip one word wide and a host name broke letter by letter).
 *
 * tests/e2e/browser/session-panel-narrow.spec.ts holds every notice to this.
 */
import type { CSSProperties, ReactNode } from 'react';
import '@/styles/panel-notice.css';

export function PanelNotice({ className, icon, actions, style, testId, role, children }: {
  /** The box, tone and kind: `session-error-banner` (+ `--idle`, `--warning`, ...) */
  className?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
  testId?: string;
  role?: 'status' | 'alert';
  children: ReactNode;
}) {
  return (
    <div
      className={`panel-notice${className ? ` ${className}` : ''}`}
      data-panel-notice=""
      data-testid={testId}
      role={role}
      style={style}
    >
      <div className="panel-notice-body">
        {icon && <span className="panel-notice-icon" aria-hidden="true"><span className="panel-notice-glyph">{icon}</span></span>}
        {children}
      </div>
      {actions && <div className="panel-notice-actions">{actions}</div>}
    </div>
  );
}

/**
 * A host name or a path inside a notice's words: one line, cut with an ellipsis when it
 * is longer than the box, the whole of it on hover. Never broken letter by letter.
 * A path (`code`) is cut in its middle: its last folder, the part that tells one folder
 * from another, always shows ("/home/someone/wor…/build").
 */
export function NoticeToken({ text, code }: { text: string; code?: boolean }) {
  if (!code) return <span className="panel-notice-token">{text}</span>;
  const cut = text.replace(/\/+$/, '').lastIndexOf('/');
  if (cut <= 0) return <code className="panel-notice-token">{text}</code>;
  return (
    <code className="panel-notice-token panel-notice-token--path" title={text}>
      <span className="panel-notice-token-head">{text.slice(0, cut)}</span>
      <span className="panel-notice-token-tail">{text.slice(cut)}</span>
    </code>
  );
}

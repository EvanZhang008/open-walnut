/**
 * A script's command on one line, cut with an ellipsis when long: a click shows
 * all of it (wrapped) and a second click folds it again.
 */
import { useState } from 'react';

export function ScriptCommand({ command, className }: { command: string; className: string }) {
  const [open, setOpen] = useState(false);
  const long = command.length > 40 || command.includes('\n');
  if (!long) return <code className={className} title={command}>{command}</code>;
  return (
    <code
      className={`${className} script-command-toggle${open ? ' is-open' : ''}`}
      title={open ? 'Click to fold it' : `${command}\n(click to show all of it)`}
      role="button" tabIndex={0} aria-expanded={open}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); } }}
      data-testid="script-command"
    >
      {command}
    </code>
  );
}

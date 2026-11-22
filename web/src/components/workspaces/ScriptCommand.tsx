/**
 * A script's command on one line, cut with an ellipsis when long: a click shows
 * all of it (wrapped) and a second click folds it again. The long one is a real
 * disclosure button (Enter and Space come with it), the command inside it.
 */
import { useState } from 'react';
import { DisclosureButton } from '@/components/controls';

export function ScriptCommand({ command, className }: { command: string; className: string }) {
  const [open, setOpen] = useState(false);
  const long = command.length > 40 || command.includes('\n');
  if (!long) return <code className={className}>{command}</code>;
  return (
    <DisclosureButton
      expanded={open}
      className="script-command-toggle"
      title={open ? 'Click to fold it' : `${command}\n(click to show all of it)`}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
      data-testid="script-command"
    >
      <code className={className}>{command}</code>
    </DisclosureButton>
  );
}

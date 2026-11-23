/**
 * The command to copy for a host problem: commands[0] as a chip with a Copy
 * button, the alternatives behind 'Other ways' (the same list Settings shows).
 * Nothing at all when the server gave no command (it does not know how, e.g.
 * a Claude Code installed some other way): the UI never invents one.
 */
import { useRef, useState } from 'react';
import { CopyButton } from '@/components/common/CopyButton';
import { demoCommandCopy } from '@/utils/demo-generation';
import '@/styles/host-status.css';


/** Select the chip's text so the user can copy it by hand when the clipboard is unavailable. */
function selectText(el: HTMLElement | null): void {
  if (!el || typeof window === 'undefined') return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

function CommandChip({ command }: { command: string }) {
  const chipRef = useRef<HTMLElement>(null);
  return (
    <div className="hc-row">
      <code ref={chipRef} className="hc-chip">{command}</code>
      {/* On a failed copy the command is selected, so it can be copied by hand. */}
      <CopyButton text={command} className="setup-copy-btn" aria-label={`Copy ${command}`} onFailed={() => selectText(chipRef.current)} />
    </div>
  );
}

/** `wrap`: the box spans the text column and wraps a long command instead of scrolling it (host-status.css). */
export function HostCommands({ commands, testId, wrap }: { commands: readonly string[]; testId?: string; wrap?: boolean }) {
  const cls = wrap ? 'hc hc--wrap' : 'hc';
  const [open, setOpen] = useState(false);
  const list = commands.filter((c) => typeof c === 'string' && c.trim());
  if (list.length === 0) return null;
  const demo = demoCommandCopy(list);
  if (demo.kind !== 'normal') {
    return (
      <div className={cls} data-testid={testId} data-demo="note">
        <span className="text-sm text-muted" role="note">{demo.note}</span>
      </div>
    );
  }
  const rest = list.slice(1);
  return (
    <div className={cls} data-testid={testId}>
      <CommandChip command={list[0]} />
      {rest.length > 0 && (
        <button type="button" tabIndex={0} className="hc-other" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Other ways
        </button>
      )}
      {rest.length > 0 && open && (
        <ul className="hc-other-list">
          {rest.map((c) => <li key={c}><CommandChip command={c} /></li>)}
        </ul>
      )}
    </div>
  );
}

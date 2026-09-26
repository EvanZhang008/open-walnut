/**
 * The command to copy for a host problem: commands[0] as a chip with a Copy
 * button, the alternatives behind 'Other ways' (the same list Settings shows).
 * Nothing at all when the server gave no command (it does not know how, e.g.
 * a Claude Code installed some other way): the UI never invents one.
 */
import { useEffect, useRef, useState } from 'react';
import { log } from '@/utils/log';
import '@/styles/host-status.css';

type CopyState = 'idle' | 'copied' | 'failed';
const COPIED_MS = 1500;

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
  const [state, setState] = useState<CopyState>('idle');
  const chipRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state !== 'copied') return;
    const t = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setState('copied');
    } catch (err) {
      log.warn('host-commands', 'copy failed', { error: String(err) });
      setState('failed');
      selectText(chipRef.current);
    }
  };
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy';
  return (
    <div className="hc-row">
      <code ref={chipRef} className="hc-chip" title={command}>{command}</code>
      <button
        type="button"
        // WebKit only tabs to buttons with an explicit tabindex (the Mac app).
        tabIndex={0}
        className={`setup-copy-btn${state === 'failed' ? ' hc-copy-failed' : ''}`}
        onClick={() => { void copy(); }}
        aria-label={state === 'idle' ? `Copy ${command}` : label}
      >
        {/* Copy, Copied and Copy failed share one width (the flip happens under the pointer). */}
        <span className="hpb-btn-stack" data-r1="Copy failed" data-r2="Copied"><span>{label}</span></span>
      </button>
    </div>
  );
}

export function HostCommands({ commands, testId }: { commands: readonly string[]; testId?: string }) {
  const [open, setOpen] = useState(false);
  const list = commands.filter((c) => typeof c === 'string' && c.trim());
  if (list.length === 0) return null;
  const rest = list.slice(1);
  return (
    <div className="hc" data-testid={testId}>
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

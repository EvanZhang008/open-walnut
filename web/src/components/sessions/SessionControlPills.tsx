import { useEffect, useRef, useState } from 'react';
import type { SessionControl } from '@/api/sessions';

interface SessionControlPillsProps {
  controls: SessionControl[];
  setControl: (id: string, value: string) => Promise<void>;
  showModeShortcut?: boolean;
}

export function nextSessionControlValue(control: SessionControl | undefined): string | undefined {
  if (!control || control.options.length === 0) return undefined;
  const currentIndex = control.options.findIndex((option) => option.value === control.currentValue);
  return control.options[(currentIndex + 1) % control.options.length]?.value;
}

/** Line icons matching ChatGPT's approval menu (hand / shield / warning). */
function ModeIcon({ value }: { value: string }) {
  if (value === 'read-only') {
    // Raised hand — "ask for approval"
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-6.5v-1a1.5 1.5 0 0 1 3 0V12m0-5.5a1.5 1.5 0 0 1 3 0V13" />
        <path d="M17 12.5a1.5 1.5 0 0 1 3 .5c0 5-2.5 9-7.5 9S6 18 5 15.5c-.6-1.5-1-3-2-4.5a1.6 1.6 0 0 1 2.6-1.8L8 12.5" />
      </svg>
    );
  }
  if (value === 'agent-full-access') {
    // Warning circle — "full access"
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5V13" />
        <path d="M12 16.4h.01" />
      </svg>
    );
  }
  // Shield with prompt — "approve for me" / agent
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      <path d="M9.5 10.5l2 2-2 2" />
    </svg>
  );
}

function PlanIcon() {
  // Lightbulb — matches ChatGPT's plan-mode entry
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 1 3.6 10.8c-.7.6-1.1 1.3-1.3 2.2h-4.6c-.2-.9-.6-1.6-1.3-2.2A6 6 0 0 1 12 3z" />
    </svg>
  );
}

/**
 * ChatGPT-parity approval menu: ONE pill (current mode) opening a dropdown of
 * the provider's own options — icon + name + description, check on the RIGHT,
 * full-access row in warning orange. Plan mode rides as a toggle row at the
 * bottom (ChatGPT keeps it in the "+" menu; we have no such menu here), and
 * only surfaces as its own amber pill while ON, where clicking turns it off.
 */
export function SessionControlPills({
  controls,
  setControl,
  showModeShortcut = false,
}: SessionControlPillsProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const mode = controls.find((control) => control.id === 'mode');
  const collab = controls.find((control) => control.id === 'collaboration_mode');
  const planOn = collab?.currentValue === 'plan';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!mode) return null;
  const current = mode.options.find((option) => option.value === mode.currentValue);

  const apply = (id: string, value: string) => {
    setBusy(true);
    setControl(id, value)
      .catch(() => { /* owner surfaces the error */ })
      .finally(() => { setBusy(false); setOpen(false); });
  };

  return (
    <>
      <span className="session-control-picker" ref={rootRef}>
        <button
          type="button"
          className="mode-toggle-pill"
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`${mode.name}: ${current?.name ?? mode.currentValue}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="mode-toggle-pill-label">
            {current?.name ?? mode.currentValue}
          </span>
          {showModeShortcut && (
            <span className="mode-toggle-pill-shortcut">{'⇧'}Tab</span>
          )}
        </button>
        {open && (
          <span className="session-control-menu" role="listbox" aria-label={mode.name}>
            <span className="session-control-menu-title">
              How should Codex actions be approved?
            </span>
            {mode.options.map((option) => {
              const active = option.value === mode.currentValue;
              const danger = option.value === 'agent-full-access';
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`session-control-option${danger ? ' session-control-option-danger' : ''}`}
                  key={option.value}
                  disabled={busy}
                  onClick={() => {
                    if (active) { setOpen(false); return; }
                    apply(mode.id, option.value);
                  }}
                >
                  <span className="session-control-option-icon" aria-hidden>
                    <ModeIcon value={option.value} />
                  </span>
                  <span className="session-control-option-copy">
                    <span className="session-control-option-name">{option.name}</span>
                    {option.description && (
                      <span className="session-control-option-description">{option.description}</span>
                    )}
                  </span>
                  <span className="session-control-option-check" aria-hidden>{active ? '✓' : ''}</span>
                </button>
              );
            })}
            {collab && (
              <>
                <span className="session-control-menu-divider" aria-hidden />
                <button
                  type="button"
                  className="session-control-option"
                  disabled={busy}
                  onClick={() => apply(collab.id, planOn ? 'default' : 'plan')}
                >
                  <span className="session-control-option-icon" aria-hidden>
                    <PlanIcon />
                  </span>
                  <span className="session-control-option-copy">
                    <span className="session-control-option-name">Plan mode</span>
                    <span className="session-control-option-description">
                      {planOn ? 'Turn plan mode off.' : 'Turn plan mode on.'}
                    </span>
                  </span>
                  <span className="session-control-option-check" aria-hidden>{planOn ? '✓' : ''}</span>
                </button>
              </>
            )}
          </span>
        )}
      </span>
      {planOn && collab && (
        <button
          type="button"
          className="mode-toggle-pill plan-active"
          title="Plan mode on. Click to turn off"
          disabled={busy}
          onClick={() => apply(collab.id, 'default')}
        >
          <span className="mode-toggle-pill-label">Plan</span>
        </button>
      )}
    </>
  );
}

import type { SessionControl } from '@/api/sessions';

interface SessionControlPillsProps {
  controls: SessionControl[];
  setControl: (id: string, value: string) => Promise<void>;
  showModeShortcut?: boolean;
}

function controlIcon(control: SessionControl): string {
  if (control.id === 'collaboration_mode') {
    return control.currentValue === 'plan' ? '\uD83D\uDCCB' : '\u2699\uFE0F';
  }
  if (control.currentValue.includes('full-access')) return '\u26A1';
  if (control.currentValue.includes('read-only')) return '\uD83D\uDD12';
  return '\u2699\uFE0F';
}

export function nextSessionControlValue(control: SessionControl | undefined): string | undefined {
  if (!control || control.options.length === 0) return undefined;
  const currentIndex = control.options.findIndex((option) => option.value === control.currentValue);
  return control.options[(currentIndex + 1) % control.options.length]?.value;
}

export function SessionControlPills({
  controls,
  setControl,
  showModeShortcut = false,
}: SessionControlPillsProps) {
  return (
    <>
      {controls
        .filter((control) => control.id === 'mode' || control.id === 'collaboration_mode')
        .map((control) => {
          const current = control.options.find((option) => option.value === control.currentValue);
          const nextValue = nextSessionControlValue(control);
          const next = control.options.find((option) => option.value === nextValue);
          return (
            <button
              key={control.id}
              className={`mode-toggle-pill${control.currentValue === 'plan' ? ' plan-active' : ''}`}
              onClick={() => {
                if (nextValue) void setControl(control.id, nextValue);
              }}
              title={`${control.name}: ${current?.name ?? control.currentValue}. Click to cycle${next ? ` to ${next.name}` : ''}`}
            >
              <span className="mode-toggle-pill-label">
                {controlIcon(control)} {current?.name ?? control.currentValue}
              </span>
              {showModeShortcut && control.id === 'mode' && (
                <span className="mode-toggle-pill-shortcut">{'\u21E7'}Tab</span>
              )}
            </button>
          );
        })}
    </>
  );
}

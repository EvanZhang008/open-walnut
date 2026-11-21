/**
 * The model picker's fold bar: under the Model | Effort columns, one small toggle per fold
 * ("Cost $102", "Speed 239 tok/s", "Details"), and the open fold's content under them. One fold
 * open at a time; every fold starts closed, so an open picker shows only the choices and the two
 * numbers (the user, 2026-11-21: "把它放到一个 collapse 里面，不要显示那么多 information ...
 * cost 点开之后，它就可以显示具体的 ... token speed ... 点开之后再显示详细的"; design v2,
 * picked on thread th-17fc2b89c52c).
 *
 * A fold may carry a warning (context nearly full): a dot on its toggle, the reason as its title,
 * so what needs a look is visible without opening anything.
 */
import React from 'react';
import '@/styles/model-picker-folds.css';

export type PickerFoldId = 'cost' | 'speed' | 'details';

export interface PickerFold {
  id: PickerFoldId;
  /** The toggle's word: "Cost", "Speed", "Details". */
  label: string;
  /** The number beside it ("$102", "239 tok/s"); omitted for Details. */
  value?: React.ReactNode;
  /** What opens under the bar. */
  content: React.ReactNode;
  /** Something in this fold needs a look: a dot on the toggle, this sentence as its title. */
  warn?: string | null;
}

export function PickerFoldBar({ folds, status }: {
  folds: PickerFold[];
  /** A state line beside the toggles ("Not running"), not a control. */
  status?: React.ReactNode;
}) {
  // A popover's open fold is a passing thing: every open starts with all folds closed.
  const [fold, setFold] = React.useState<PickerFoldId | null>(null);
  // A fold whose content went away closes, so it never pops open by itself when it comes back.
  const ids = folds.map((f) => f.id).join(' ');
  React.useEffect(() => {
    if (fold && !ids.split(' ').includes(fold)) setFold(null);
  }, [fold, ids]);
  if (folds.length === 0 && !status) return null;
  const current = folds.find((f) => f.id === fold) ?? null;
  const main = folds.filter((f) => f.id !== 'details');
  const details = folds.find((f) => f.id === 'details');
  const toggle = (f: PickerFold) => (
    <button
      key={f.id}
      type="button"
      className="btn btn-sm"
      data-testid={`picker-fold-${f.id}`}
      aria-expanded={fold === f.id}
      aria-controls={fold === f.id ? `picker-fold-body-${f.id}` : undefined}
      title={f.warn ?? undefined}
      onClick={() => setFold((v) => (v === f.id ? null : f.id))}
    >
      {f.warn && <span className="model-picker-fold-dot" role="img" aria-label={f.warn} />}
      <span className="model-picker-fold-label">{f.label}</span>
      {f.value !== undefined && <strong className="model-picker-fold-value">{f.value}</strong>}
      <span className="model-picker-fold-caret" aria-hidden>{fold === f.id ? '▴' : '▾'}</span>
    </button>
  );
  return (
    <div className="model-picker-folds" data-testid="picker-folds">
      <div className="model-picker-folds-bar">
        {main.map(toggle)}
        {status && <span className="model-picker-folds-status" data-testid="picker-fold-status">{status}</span>}
        {details && <span className="model-picker-folds-end">{toggle(details)}</span>}
      </div>
      {current && (
        <div id={`picker-fold-body-${current.id}`} className={`model-picker-fold model-picker-fold-${current.id}`} data-testid={`picker-fold-body-${current.id}`}>
          {current.content}
        </div>
      )}
    </div>
  );
}

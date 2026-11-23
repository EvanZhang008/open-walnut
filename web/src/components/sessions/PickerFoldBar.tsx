/**
 * The model picker's fold bar: under the Model | Effort columns, one small toggle per fold
 * ("Cost $102", "Speed 239 tok/s", "Details"), and the open fold's content under them. One fold
 * open at a time; every fold starts closed, so an open picker shows only the choices and the two
 * numbers (the user, 2026-11-21: "把它放到一个 collapse 里面，不要显示那么多 information ...
 * cost 点开之后，它就可以显示具体的 ... token speed ... 点开之后再显示详细的"; design v2,
 * picked on thread th-17fc2b89c52c).
 *
 * The toggles are the button family's Tool role (standard.md: `.ask-card-tools .btn`, the quiet
 * "Snooze ▾" key): a muted word, its number in bold, a small caret; the open one takes the
 * family's pressed look (design A, 2026-11-21, after "the button is so ugly also the 2 bar below
 * is so bad"). Details always keeps its name; a state such as "Not running" is a muted word of
 * its own beside it, never in its place.
 *
 * A fold may carry a warning (context nearly full, budget reached): a dot on its toggle with the
 * reason as its accessible name and title, so what needs a look is visible without opening anything.
 */
import React from 'react';
import '@/components/actions/ask-card.css';
import '@/styles/model-picker-folds.css';
import { DisclosureChevron } from '@/components/controls';

export type PickerFoldId = 'cost' | 'speed' | 'details';

export interface PickerFold {
  id: PickerFoldId;
  /** The toggle's word: "Cost", "Speed", "Details". */
  label: string;
  /** The number beside it ("$102", "239 tok/s"); omitted for Details. */
  value?: React.ReactNode;
  /** What opens under the bar. */
  content: React.ReactNode;
  /** Something in this fold needs a look: a dot on the toggle, this sentence as its name and title. */
  warn?: string | null;
  /** What the number counts ("This session's cost so far"), the toggle's title when nothing warns. */
  title?: string;
}

/** The warning dot of a toggle or a row: an image whose name is the reason. */
export function FoldWarnDot({ reason, testId }: { reason: string; testId?: string }) {
  return <span className="model-picker-fold-dot" role="img" aria-label={reason} title={reason} data-testid={testId} />;
}

export function PickerFoldBar({ folds, status }: {
  folds: PickerFold[];
  /** A state word beside the toggles ("Not running"), not a control. */
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
      className="btn"
      data-testid={`picker-fold-${f.id}`}
      aria-expanded={fold === f.id}
      aria-controls={fold === f.id ? `picker-fold-body-${f.id}` : undefined}
      title={f.warn ?? f.title}
      onClick={() => setFold((v) => (v === f.id ? null : f.id))}
    >
      <DisclosureChevron open={fold === f.id} />
      {f.warn && <FoldWarnDot reason={f.warn} />}
      <span className="model-picker-fold-label">{f.label}</span>
      {f.value !== undefined && <strong className="model-picker-fold-value">{f.value}</strong>}
    </button>
  );
  return (
    <div className="model-picker-folds" data-testid="picker-folds">
      <div className="model-picker-folds-bar ask-card-tools">
        {main.map(toggle)}
        <span className="model-picker-folds-end">
          {status && <span className="model-picker-folds-status" data-testid="picker-fold-status">{status}</span>}
          {details && toggle(details)}
        </span>
      </div>
      {current && (
        <div id={`picker-fold-body-${current.id}`} className={`model-picker-fold model-picker-fold-${current.id}`} data-testid={`picker-fold-body-${current.id}`}>
          {current.content}
        </div>
      )}
    </div>
  );
}

/**
 * Fix Walnut in the v6 new task draft (experiment `project_first_start`): a session in Walnut's own
 * source, where this Walnut is installed (Evan, 2026-11-25: "a fix walnut button below recent").
 *
 *   ◷ Describe what to change or fix in Walnut. Paste a screenshot if you have one.    (repair only)
 *   [FIX WALNUT IN  ● This Mac › ~/code/walnut                                  ×]  (repair only)
 *   [ composer ............................................................. ↑ ]
 *   Recent [⑂ Walnut] [+75]                       Save as task   Task settings
 *   [≡ Fix Walnut]  in ~/code/walnut
 *
 * The key under Recent turns this draft into the repair draft (MainPage's repair seed: the source,
 * pinned, the fix-walnut intent) in place: the same layout and the same composer, so nothing typed
 * or attached is lost and nothing moves. The repair draft shows its target read-only where the
 * Where row was; the key (now pressed), the × and any place picked from Recent take it back to a
 * plain draft. In Quick chat the key's row keeps its slot, hidden, so the composer stays put.
 */
import * as ICONS from '@/components/common/Icons';
import { knownHomeOf, tildePath } from '@/utils/home-folder';
import type { WalnutRepairTarget } from '@/pages/repair-target';
import { fixWalnutWhere } from './draft-fix-walnut';
import '@/styles/draft-v6-fix-walnut.css';

/** The key under Recent. `on`: this draft is the repair draft; a click takes it back. */
export function DraftFixWalnutRow({ target, on, hidden, onClick }: {
  target: WalnutRepairTarget;
  on: boolean;
  /** Quick chat: the slot stays, empty, so the composer does not move. */
  hidden: boolean;
  onClick: () => void;
}) {
  return (
    <div className="draft-v6-fix" data-testid="draft-v6-fix-walnut-row" inert={hidden || undefined}>
      <button type="button" className="btn btn-sm draft-v6-place" data-testid="draft-v6-fix-walnut" aria-pressed={on}
        title={on ? 'Back to a new task' : `Fix Walnut: a session in Walnut's own code (${target.dir})`}
        onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
        <span className="draft-v6-place-ic" aria-hidden="true">{ICONS.ICON_SLIDERS}</span>Fix Walnut
      </button>
      <span className="wn-meta draft-v6-fix-where" title={target.dir}>{fixWalnutWhere(target, knownHomeOf(null))}</span>
    </div>
  );
}

/** The repair draft's target, read-only, in the Where row's slot (same size: nothing moves). */
export function DraftFixWalnutSlot({ target, hostName, startError, onLeave }: {
  target: WalnutRepairTarget;
  hostName: string;
  /** The server refused the last Start: its words take the line. */
  startError?: string;
  onLeave: () => void;
}) {
  const dir = tildePath(target.dir, knownHomeOf(null));
  return (
    <div className="draft-v6-row-slot" data-testid="draft-v6-fix-walnut-slot">
      <div className={`draft-v6-line draft-v6-fix-line${startError ? ' is-error' : ''}`} {...(startError ? { role: 'alert' } : {})}>
        <span className="draft-v6-line-text">
          {startError ?? (target.cloneNeeded
            ? "Walnut's source is not here yet: Start clones it first, then opens the session there."
            : 'A session in Walnut\'s own code. Paste a screenshot if you have one.')}
        </span>
      </div>
      <div className="draft-v6-row draft-v6-fix-row">
        <div className="draft-v6-field draft-v6-fix-target" role="group" aria-label={`Fix Walnut in ${target.dir} on ${hostName}`} title={target.dir}>
          <span className="draft-v6-field-key">Fix Walnut in</span>
          <span className="draft-v6-field-value draft-v6-crumbs">
            <span className="draft-v6-host-static">
              <span className="draft-v6-dot is-on" aria-hidden="true" />
              <span className="draft-v6-host-name wn-meta">{hostName}</span>
            </span>
            <span className="draft-v6-sep" aria-hidden="true">{ICONS.ICON_CHEVRON_RIGHT}</span>
            <span className="wn-meta draft-v6-fix-dir" data-testid="draft-v6-fix-walnut-dir">{dir}</span>
          </span>
          <button type="button" className="btn btn-icon btn-ghost btn-sm draft-v6-fix-leave" data-testid="draft-v6-fix-walnut-leave"
            aria-label="Back to a new task" title="Back to a new task" onMouseDown={(e) => e.preventDefault()} onClick={onLeave}>
            {ICONS.ICON_CLOSE}
          </button>
        </div>
      </div>
    </div>
  );
}

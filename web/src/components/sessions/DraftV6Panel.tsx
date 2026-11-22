/**
 * What DraftSessionPanel needs for the v6 new task draft (experiment `project_first_start`), kept
 * out of the panel so today's layout stays as it was: which drafts get the v6 layout, Start's
 * "why not" near the button, the nonce that opens the Where menu, and the send label.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useExperimental } from '@/hooks/useExperimental';

export interface DraftV6State {
  /** This draft uses the v6 layout. */
  v6: boolean;
  /** What the v6 row says Start cannot do as it stands (written by DraftV6Body every render). */
  blockedRef: MutableRefObject<string | null>;
  /** The same, as state: the send arrow reads off while it holds (a click still explains). */
  blocked: boolean;
  setBlocked: (blocked: boolean) => void;
  /** Start was pressed while blocked: the reason, shown near the button for 5 s. */
  startWhy: string | null;
  clearWhy: () => void;
  /** Bumped when a Start needs a place: DraftV6Body opens the Where menu. */
  whereNonce: number;
  /**
   * Start's v6 checks, before the panel's own: true when the start must not go (the reason is
   * shown, or the Where menu opens for a draft with no place).
   */
  holdsStart: (draft: { walnut?: boolean; cwd: string; fromProject?: boolean }, ownFolder: boolean) => boolean;
}

/**
 * A plain new draft with the two modes gets the v6 layout; every other draft, and all of them
 * with the experiment off, keep today's exactly.
 */
export function useDraftV6(eligible: boolean): DraftV6State {
  const on = useExperimental('project_first_start');
  const v6 = on && eligible;
  const blockedRef = useRef<string | null>(null);
  const [startWhy, setStartWhy] = useState<string | null>(null);
  const [whereNonce, setWhereNonce] = useState(0);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!startWhy) return;
    const t = setTimeout(() => setStartWhy(null), 5_000);
    return () => clearTimeout(t);
  }, [startWhy]);
  const holdsStart: DraftV6State['holdsStart'] = (draft, ownFolder) => {
    if (!v6 || draft.walnut) return false;
    // The row says why this place cannot run (a host that cannot make the workspace, a folder
    // on another host): Start explains near the button and keeps the text.
    if (blockedRef.current) { setStartWhy(blockedRef.current); return true; }
    // No place: the Where menu is the recovery (there is no folder picker under the composer).
    if (!draft.cwd && !ownFolder && !draft.fromProject) { setWhereNonce((n) => n + 1); return true; }
    return false;
  };
  return { v6, blockedRef, blocked: v6 && blocked, setBlocked, startWhy, clearWhy: () => setStartWhy(null), whereNonce, holdsStart };
}

/**
 * The send arrow's words ("Start task", "Ask Walnut"): the arrow by another name, so it is off
 * exactly when the arrow is (nothing to send). A click never falls back to an empty start.
 */
export function DraftV6SendLabel({ canSend, walnut, onClick }: { canSend: boolean; walnut: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`btn btn-ghost draft-v6-send-label${walnut ? ' is-walnut' : ''}`} data-testid="draft-v6-send-label"
      disabled={!canSend} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {walnut ? 'Ask Walnut' : 'Start task'}
    </button>
  );
}

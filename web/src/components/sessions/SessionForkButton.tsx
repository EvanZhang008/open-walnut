import { useCallback, useRef, useState } from 'react';
import type { SessionRecord } from '@/types/session';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { engineCaps } from '@/utils/engine-capabilities';
import { recordGateReason, TASK_SLOT_SPACER, type TaskControlSlot } from './header-record-gate';

/**
 * SessionForkButton — the standalone "Fork" action that stays OUTSIDE the
 * kebab dropdown (one of the four kept-visible session actions).
 *
 * One click opens a FORK DRAFT COLUMN (the same draft surface every "+" opens,
 * pre-bound to this session) — not a popover form. The draft's composer is
 * where the fork message (and images) are typed; folder/host/project arrive
 * preselected and IMMUTABLE (a fork resumes the source conversation in place),
 * the model arrives preselected from the source but changeable. The old
 * 320px popover duplicated a worse composer (2-row textarea, no slash palette,
 * no AI backfill) next to a better one.
 *
 * The "Copy CLI command" escape hatch moved into the draft's header kebab? No —
 * it lives HERE as a right-click on the button (title documents it), because
 * the draft column is client-only and the CLI command needs the SOURCE id.
 */
interface SessionForkButtonProps {
  sessionId: string;
  /** The loaded session record — cwd/host/project/model seed the fork draft. */
  session?: Pick<SessionRecord, 'cwd' | 'host' | 'project' | 'model' | 'engine' | 'taskId' | 'title'> | null;
  /** The record is still being fetched: the chip holds its place, disabled, until it lands. */
  loading?: boolean;
  /** How the row draws the chip on this frame (taskControlSlot). Fork creates a
   *  child task, so a session known to have none gets no chip ('absent'), or, where
   *  the panel had already drawn it, an inert spacer of its width ('spacer'). */
  slot: TaskControlSlot;
  /** Title shown as "fork of: <title>" in the draft header (task title wins). */
  sourceTitle?: string | null;
  /** Open the fork draft column. Provided by MainPage (openDraftColumn). */
  onOpenForkDraft?: (seed: {
    forkOf: { sessionId: string; title?: string };
    cwd: string; host: string | null; hostLabel?: string;
    project?: string; model?: string; cwdPinned: true;
  }) => void;
}

export function SessionForkButton({ sessionId, session, loading, slot, sourceTitle, onOpenForkDraft }: SessionForkButtonProps) {
  const [cliCopied, setCliCopied] = useState(false);
  const cliCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const engineCatalog = useEngineCatalog();
  const engineUi = engineCaps(session?.engine, engineCatalog);

  const handleForkClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!session?.cwd || !onOpenForkDraft) return;
    onOpenForkDraft({
      forkOf: { sessionId, ...(sourceTitle ? { title: sourceTitle } : {}) },
      cwd: session.cwd,
      host: session.host ?? null,
      ...(session.project ? { project: session.project } : {}),
      ...(session.model ? { model: session.model } : {}),
      cwdPinned: true,
    });
  }, [session, sessionId, sourceTitle, onOpenForkDraft]);

  // Right-click = copy the equivalent CLI command (the popover's old escape
  // hatch, kept for terminal users; the title advertises it).
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    // A disabled chip does nothing, a right-click included (Chromium and WebKit both deliver
    // contextmenu to a disabled button): before the record there is no cwd for the command,
    // and "CLI copied!" is wider than "Fork", so the row would move.
    if (e.currentTarget.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const cdPrefix = session?.cwd ? `cd ${session.cwd} && ` : '';
    navigator.clipboard.writeText(`${cdPrefix}claude --fork-session -r ${sessionId}`).then(() => {
      setCliCopied(true);
      clearTimeout(cliCopyTimerRef.current);
      cliCopyTimerRef.current = setTimeout(() => setCliCopied(false), 1500);
    }).catch(() => {});
  }, [session?.cwd, sessionId]);

  // Hide rather than render a dead button: a host with no draft-column surface
  // (no onOpenForkDraft: NotesPage's CC tabs), or a session known to have no
  // task. Both are known on the first frame, so hiding never moves the chips
  // after it.
  if (!sessionId || !onOpenForkDraft || slot === 'absent') return null;
  // The chip was on the row and the session turned out to have no task: its
  // place stays, empty, so Changed and Files stay where the person aimed.
  if (slot === 'spacer') {
    return <button type="button" className="session-action-chip" {...TASK_SLOT_SPACER}>Fork</button>;
  }
  // Forking resumes the source conversation in a second process, which the
  // engine itself has to support (claude --fork-session); ACP adapters have no
  // session/fork yet, so the button reports why instead of failing on click.
  // Wording is pinned by tests/e2e/browser/codex-parity-discovery.spec.ts —
  // only the engine name interpolates.
  const unsupportedReason = session && !engineUi.fork
    ? `Fork is unavailable because this ${engineUi.displayName} adapter does not support session forking`
    : null;
  // Everything else that keeps Fork from acting. The chip is drawn while it
  // waits: it sits in front of Changed and Files, and appearing once the record
  // landed pushed them right by its width, so a click aimed at Files opened
  // Changed (tests/e2e/browser/session-header-chips-hold-place.spec.ts).
  const waitingReason = recordGateReason('Fork', session, !!loading)
    ?? (session?.cwd ? null : 'Fork is unavailable because this session has no working folder');

  return (
    <button
      className="session-action-chip"
      onClick={handleForkClick}
      onContextMenu={handleContextMenu}
      disabled={!!unsupportedReason || !!waitingReason}
      title={unsupportedReason ?? waitingReason
        ?? 'Fork this session into a new draft — continue the conversation on a sibling task (right-click copies the CLI command)'}
      aria-label={unsupportedReason ?? 'Fork session into a child task'}
    >
      {cliCopied ? 'CLI copied!' : 'Fork'}
    </button>
  );
}

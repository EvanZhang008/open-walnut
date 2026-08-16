import { useCallback, useRef, useState } from 'react';
import type { SessionRecord } from '@/types/session';

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
  /** Title shown as "fork of: <title>" in the draft header (task title wins). */
  sourceTitle?: string | null;
  /** Open the fork draft column. Provided by MainPage (openDraftColumn). */
  onOpenForkDraft?: (seed: {
    forkOf: { sessionId: string; title?: string };
    cwd: string; host: string | null; hostLabel?: string;
    project?: string; model?: string; cwdPinned: true;
  }) => void;
}

export function SessionForkButton({ sessionId, session, sourceTitle, onOpenForkDraft }: SessionForkButtonProps) {
  const [cliCopied, setCliCopied] = useState(false);
  const cliCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cdPrefix = session?.cwd ? `cd ${session.cwd} && ` : '';
    navigator.clipboard.writeText(`${cdPrefix}claude --fork-session -r ${sessionId}`).then(() => {
      setCliCopied(true);
      clearTimeout(cliCopyTimerRef.current);
      cliCopyTimerRef.current = setTimeout(() => setCliCopied(false), 1500);
    }).catch(() => {});
  }, [session?.cwd, sessionId]);

  // Fork creates a child task — only meaningful when this session has a task.
  // No onOpenForkDraft = a host with no draft-column surface (NotesPage's CC
  // tabs): hide rather than render a dead button.
  if (!sessionId || !session?.taskId || !onOpenForkDraft) return null;
  const unsupportedReason = session.engine === 'codex'
    ? 'Fork is unavailable because this Codex adapter does not support session forking'
    : null;

  return (
    <button
      className="session-action-chip"
      onClick={handleForkClick}
      onContextMenu={handleContextMenu}
      disabled={!!unsupportedReason || !session.cwd}
      title={unsupportedReason
        ?? 'Fork this session into a new draft — continue the conversation on a sibling task (right-click copies the CLI command)'}
      aria-label={unsupportedReason ?? 'Fork session into a child task'}
    >
      {cliCopied ? 'CLI copied!' : 'Fork'}
    </button>
  );
}

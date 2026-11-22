/**
 * LetterReader — the notification center's letter surface: a large portalled
 * overlay (PlanPopup scale) wrapping the shared `LetterView`.
 *
 * This file owns ONLY what makes it an overlay: the portal, the dialog hook
 * (scroll lock, the layered Escape), and the file preview a body link opens. The
 * letter's own behavior (load, decide, thread, reply) lives in LetterView, which
 * the session panel's Inbox tab renders too — one implementation, two lenses.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay, hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { FileViewer } from '@/components/common/FileViewer';
import type { LetterEnvelope } from '@/api/human-inbox';
import { LetterView, type LetterFileTarget } from './LetterView';
import '@/styles/human-inbox.css';

interface LetterReaderProps {
  letterId: string;
  /** Envelope already in the rail — renders the header before the GET lands. */
  envelope?: LetterEnvelope;
  onClose: () => void;
  /** A fresher record for the rail list (read / answered / thread length). */
  onLetterUpdated: (letter: LetterEnvelope) => void;
  /** Read state goes through the parent so the rail + bell badge follow at once. */
  onMarkRead: (id: string) => void;
  onTogglePin: (letter: LetterEnvelope) => void;
  onToggleArchive: (letter: LetterEnvelope) => void;
  /** SPA navigation out of the panel (task pills, session refs). */
  onNavigate: (to: string) => void;
  /** Notification Inbox can host the same reader in its right column. */
  embedded?: boolean;
}

export function LetterReader({
  letterId, envelope, onClose, onLetterUpdated, onMarkRead, onTogglePin, onToggleArchive,
  onNavigate, embedded = false,
}: LetterReaderProps) {
  const [fileView, setFileView] = useState<LetterFileTarget | null>(null);
  const fileViewRef = useRef(false);
  fileViewRef.current = !!fileView;

  const onOpenFile = useCallback((target: LetterFileTarget) => setFileView(target), []);

  // Embedded in the Inbox column it is no overlay, yet Escape still closes the letter. Not while a
  // file preview is up: that preview (a dialog) takes the key. (The panel underneath also guards on
  // the reader being open, so one Escape never closes two layers.)
  useEffect(() => {
    if (!embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || fileViewRef.current || document.querySelector('.file-viewer-overlay') || hasActiveModalOverlay()) return;
      // An Esc a box inside already took (the reply's @ or / list closing) is that box's alone.
      if (e.defaultPrevented) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose, embedded]);

  const view = <LetterView
    key={letterId}
    letterId={letterId}
    {...(envelope ? { envelope } : {})}
    embedded={embedded}
    onClose={onClose}
    onLetterUpdated={onLetterUpdated}
    onMarkRead={onMarkRead}
    onTogglePin={onTogglePin}
    onToggleArchive={onToggleArchive}
    onNavigate={onNavigate}
    onOpenFile={onOpenFile}
  />;
  const filePreview = fileView && <FileViewer
    path={fileView.path}
    {...(fileView.line ? { line: fileView.line } : {})}
    {...(fileView.endLine ? { endLine: fileView.endLine } : {})}
    {...(fileView.host ? { host: fileView.host } : {})}
    {...(fileView.sourceOnly ? { sourceOnly: true } : {})}
    onClose={() => setFileView(null)}
  />;
  if (embedded) return <>{view}{filePreview}</>;

  return <>
    <ReaderOverlay label={envelope?.subject || 'Letter'} onClose={onClose}>{view}</ReaderOverlay>
    {filePreview}
  </>;
}

/** The overlay lens: a dialog (Escape, scroll lock and nesting through useModalOverlay, so the file
 *  preview opened over it takes the first Escape). */
function ReaderOverlay({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useModalOverlay(onClose);
  return createPortal(
    <div
      className="hib-reader-overlay wn-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Portalled overlay inside the panel's own portal: stop pointer events
          at the container so a drag sensor on an ancestor row can't see them
          (web/src/AGENTS.md — portals escape clipping, not bubbling). */}
      <div
        className="hib-reader wn-dialog"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

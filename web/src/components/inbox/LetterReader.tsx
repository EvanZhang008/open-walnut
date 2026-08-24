/**
 * LetterReader — the notification center's letter surface: a large portalled
 * overlay (PlanPopup scale) wrapping the shared `LetterView`.
 *
 * This file owns ONLY what makes it an overlay: the portal, the ref-counted
 * scroll lock, the layered Escape, and the file preview a body link opens. The
 * letter's own behavior (load, decide, thread, reply) lives in LetterView, which
 * the session panel's Inbox tab renders too — one implementation, two lenses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { lockScroll, unlockScroll } from '@/hooks/useModalOverlay';
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
}

export function LetterReader({
  letterId, envelope, onClose, onLetterUpdated, onMarkRead, onTogglePin, onToggleArchive,
  onNavigate,
}: LetterReaderProps) {
  const [fileView, setFileView] = useState<LetterFileTarget | null>(null);
  const fileViewRef = useRef(false);
  fileViewRef.current = !!fileView;

  const onOpenFile = useCallback((target: LetterFileTarget) => setFileView(target), []);

  // Escape closes the top-most layer only: with a file preview open it belongs
  // to that preview, which owns its own listener. (The panel underneath also
  // guards on the reader being open, so one Escape never closes three layers.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || fileViewRef.current) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    lockScroll();
    return () => { document.removeEventListener('keydown', onKey); unlockScroll(); };
  }, [onClose]);

  return createPortal(
    <>
      <div
        className="hib-reader-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={envelope?.subject || 'Letter'}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        {/* Portalled overlay inside the panel's own portal: stop pointer events
            at the container so a drag sensor on an ancestor row can't see them
            (web/src/AGENTS.md — portals escape clipping, not bubbling). */}
        <div
          className="hib-reader"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <LetterView
            letterId={letterId}
            {...(envelope ? { envelope } : {})}
            onClose={onClose}
            onLetterUpdated={onLetterUpdated}
            onMarkRead={onMarkRead}
            onTogglePin={onTogglePin}
            onToggleArchive={onToggleArchive}
            onNavigate={onNavigate}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>
      {fileView && (
        <FileViewer
          path={fileView.path}
          {...(fileView.line ? { line: fileView.line } : {})}
          {...(fileView.host ? { host: fileView.host } : {})}
          onClose={() => setFileView(null)}
        />
      )}
    </>,
    document.body,
  );
}

/**
 * One recording, opened: a dialog of the overlay family (`wn-dialog` over a `wn-scrim`, standard.md
 * "Overlays"; useModalOverlay: Escape and a click outside close it, the page behind stops scrolling)
 * in the legible glass (`wn-glass`), portalled to <body>, on the dialog layer (`--z-modal`, from the
 * scrim) above the phone's top bar, with its one close key always in view at the top (2026-11-22:
 * its scrim had no layer, so on a phone the top bar sat over the Close and took its clicks).
 * Everything the recording has lives in it
 * (VoiceAccuracyTakeDetail): Play recording, Recalculate estimated errors, the engine switch, the
 * engine's text with its differences from the AI's guess marked, the legend, and what was probably
 * sent. Texts show in full; only the dialog's body scrolls, never sideways. On a phone it is a
 * full-height sheet. The row it came from takes the focus back when it closes (VoiceAccuracyTakes).
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CompareEngineRow, CompareTake } from '@/api/stt-compare';
import { ModalOverlayOwner, useModalOverlay } from '@/hooks/useModalOverlay';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { ICON_CLOSE } from '@/components/common/Icons';
import { usageTime } from './UsageTables';
import { showEngineRow } from './VoiceAccuracyEngines';
import { VoiceAccuracyTakeDetail } from './VoiceAccuracyTakeDetail';

/** When a recording was made, how long it is, and where (the row's first line, the dialog's title). */
export function whenOf(take: CompareTake): string {
  const parts = [usageTime(take.at)];
  if (take.durationSec) parts.push(`${Math.round(take.durationSec)} s`);
  if (take.source === 'phone') parts.push('Phone');
  return parts.join(' · ');
}

interface Props {
  take: CompareTake;
  /** The engine columns, in order. */
  engines: CompareEngineRow[];
  judge: CompareEngineRow | undefined;
  /** Changes when the recording changed in the list (a run moved it), so the detail reads it again. */
  version: string;
  /** Why the last Retry on this recording could not start. */
  retryError?: string;
  onRetry(engineId: string): void;
  onJudge(): Promise<string | null>;
  /** `returnFocus: false` when the focus goes somewhere else (the AI judge's row). */
  onClose(returnFocus?: boolean): void;
}

export function VoiceAccuracyTakeDialog({ take, engines, judge, version, retryError, onRetry, onJudge, onClose }: Props) {
  const owner = useModalOverlay(() => onClose());
  const box = useRef<HTMLDivElement>(null);
  const sheet = usePhoneLayout();
  // The focus moves into the dialog when it opens, so Tab and a screen reader start there.
  useEffect(() => { box.current?.focus({ preventScroll: true }); }, []);
  const titleId = `va-take-dialog-title-${take.id}`;
  return createPortal(
    <ModalOverlayOwner.Provider value={owner}>
      <div className="app-modal-overlay va-take-overlay wn-scrim" data-sheet={sheet ? 'true' : undefined} onMouseDown={() => onClose()}>
        <div
          className="app-modal va-take-dialog wn-dialog wn-glass"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="va-take-dialog"
          data-take={take.id}
          data-sheet={sheet ? 'true' : undefined}
          ref={box}
          tabIndex={-1}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <header className="va-take-dialog-head wn-dialog-head" data-fit-header>
            <h2 className="va-take-dialog-title" id={titleId} data-fit-title>{`Recording of ${whenOf(take)}`}</h2>
            <button type="button" className="btn btn-icon wn-dialog-close" aria-label="Close" title="Close" data-testid="va-take-dialog-close" onClick={() => onClose()}>{ICON_CLOSE}</button>
          </header>
          <div className="va-take-dialog-body">
            <VoiceAccuracyTakeDetail
              takeId={take.id}
              engines={engines}
              judge={judge}
              version={version}
              retryError={retryError}
              onRetry={onRetry}
              onJudge={onJudge}
              onShowJudge={() => { onClose(false); requestAnimationFrame(() => showEngineRow('judge')); }}
            />
          </div>
        </div>
      </div>
    </ModalOverlayOwner.Provider>,
    document.body,
  );
}

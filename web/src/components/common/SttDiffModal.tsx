/**
 * A/B comparison popup for one voice recording: merged word-level diff of the
 * two engines' transcriptions, per-engine latency, and Insert for either text.
 * Opened from the mic dropdown's "Diff" button — the dropdown is too small to
 * read two full transcripts, this is the roomy view.
 */
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { diffSpeech, diffStats } from '@/utils/stt-diff';
import type { VoiceRecording } from '@/api/stt';

interface SttDiffModalProps {
  rec: VoiceRecording;
  onInsert: (text: string) => void;
  onClose: () => void;
}

const fmtLatency = (ms?: number) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—');

export function SttDiffModal({ rec, onInsert, onClose }: SttDiffModalProps) {
  useModalOverlay(onClose);

  const primaryText = rec.result?.text ?? '';
  const secondaryText = rec.secondary?.text ?? '';
  const segs = useMemo(() => diffSpeech(primaryText, secondaryText), [primaryText, secondaryText]);
  const stats = useMemo(() => diffStats(segs), [segs]);
  const identical = stats.aOnly === 0 && stats.bOnly === 0;
  const time = rec.timestamp
    ? new Date(rec.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return createPortal(
    <div className="app-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-modal stt-diff-modal" role="dialog" aria-label="Compare transcriptions">
        <div className="app-modal-title stt-diff-title">
          <span>Voice A/B · {time}</span>
          <button type="button" className="stt-diff-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        {/* Merged diff — the actual comparison. Trivial (punctuation-only)
            changes are dimmed so real word differences stand out. */}
        <div className="stt-diff-legend">
          <span className="stt-diff-chip stt-diff-chip-a">{rec.engine ?? 'primary'} · {fmtLatency(rec.result?.durationMs)}</span>
          <span className="stt-diff-chip stt-diff-chip-b">{rec.secondary?.engine ?? 'secondary'} · {fmtLatency(rec.secondary?.durationMs)}</span>
          <span className="stt-diff-note">
            {identical ? 'identical (ignoring punctuation)' : `differs: ${stats.aOnly + stats.bOnly} chars`}
          </span>
        </div>
        <div className="stt-diff-merged">
          {segs.map((s, i) => (
            <span
              key={i}
              className={
                s.kind === 'same' ? undefined
                : s.trivial ? 'stt-diff-trivial'
                : s.kind === 'a' ? 'stt-diff-a' : 'stt-diff-b'
              }
            >
              {s.text}
            </span>
          ))}
        </div>

        {/* Full texts, each insertable */}
        <div className="stt-diff-panels">
          <div className="stt-diff-panel">
            <div className="stt-diff-panel-head">
              <span className="stt-diff-chip stt-diff-chip-a">{rec.engine ?? 'primary'}</span>
              {primaryText && (
                <button type="button" className="mic-history-btn" onClick={() => onInsert(primaryText)}>Insert</button>
              )}
            </div>
            <div className="stt-diff-panel-text">{primaryText || (rec.error ? `Failed: ${rec.error}` : 'No transcription')}</div>
          </div>
          <div className="stt-diff-panel">
            <div className="stt-diff-panel-head">
              <span className="stt-diff-chip stt-diff-chip-b">{rec.secondary?.engine ?? 'secondary'}</span>
              {secondaryText && (
                <button type="button" className="mic-history-btn" onClick={() => onInsert(secondaryText)}>Insert</button>
              )}
            </div>
            <div className="stt-diff-panel-text">
              {secondaryText || (rec.secondary?.error ? `Failed: ${rec.secondary.error}` : 'Secondary engine still running…')}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

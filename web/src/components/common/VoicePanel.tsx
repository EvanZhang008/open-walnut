/**
 * Voice history panel — slide-out overlay from the sidebar (same portal
 * pattern as NotificationPanel).
 *
 * The ALWAYS-PRESENT recovery surface for voice input: every transcription is
 * persisted server-side (~/.open-walnut/stt-debug via /api/stt/recordings),
 * so even when the browser dropped the response (starvation/tab close), the
 * text is here. Each row: time + status + text preview, with
 *   Insert — put the text into the last-focused chat input (clipboard fallback)
 *   Copy   — copy text to clipboard
 *   Redo   — re-transcribe from the stored audio, server-side
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchRecordings, retranscribeRecording, type VoiceRecording } from '@/api/stt';
import { insertVoiceText, setVoiceStatus } from '@/utils/voice-status';
import { log } from '@/utils/log';

interface VoicePanelProps {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
}

const REFRESH_MS = 5_000;

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

export function VoicePanel({ open, onClose, sidebarCollapsed }: VoicePanelProps) {
  const [recordings, setRecordings] = useState<VoiceRecording[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ id: string; note: string } | null>(null);

  const refresh = useCallback(() => {
    fetchRecordings(20)
      .then(res => setRecordings(res.recordings))
      .catch(err => log.warn('stt', `Voice panel: failed to load recordings: ${err}`))
      .finally(() => setLoading(false));
  }, []);

  // Load on open; light poll while open so an in-flight transcription's result
  // appears without reopening.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  // Opening the panel acknowledges the failure badge.
  useEffect(() => {
    if (open) setVoiceStatus({ lastFailed: false });
  }, [open]);

  const showFlash = (id: string, note: string) => {
    setFlash({ id, note });
    setTimeout(() => setFlash(f => (f?.id === id ? null : f)), 2_000);
  };

  const handleInsert = useCallback((rec: VoiceRecording) => {
    const text = rec.result?.text;
    if (!text) return;
    if (insertVoiceText(text)) {
      showFlash(rec.id, 'Inserted');
    } else {
      navigator.clipboard.writeText(text).catch(() => {});
      showFlash(rec.id, 'Copied (no input focused)');
    }
  }, []);

  const handleCopy = useCallback((rec: VoiceRecording) => {
    const text = rec.result?.text;
    if (!text) return;
    navigator.clipboard.writeText(text).catch(() => {});
    showFlash(rec.id, 'Copied');
  }, []);

  const handleRedo = useCallback(async (rec: VoiceRecording) => {
    setBusyId(rec.id);
    try {
      const result = await retranscribeRecording(rec.id);
      if (result.text) {
        if (!insertVoiceText(result.text)) {
          navigator.clipboard.writeText(result.text).catch(() => {});
        }
        showFlash(rec.id, 'Re-transcribed');
      } else {
        showFlash(rec.id, 'Still empty');
      }
      refresh();
    } catch (err) {
      log.error('stt', `Voice panel redo failed: ${err}`);
      showFlash(rec.id, 'Redo failed');
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="notification-panel-backdrop" onClick={onClose} />
      <div className={`notification-panel voice-panel${sidebarCollapsed ? ' sidebar-collapsed' : ''}`} role="dialog" aria-label="Voice history">
        <div className="voice-panel-header">
          <span className="voice-panel-title">Voice history</span>
          <span className="voice-panel-hint">Every recording is saved — nothing is lost</span>
          <button className="voice-panel-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="voice-panel-list">
          {loading && recordings.length === 0 && (
            <div className="voice-panel-empty">Loading…</div>
          )}
          {!loading && recordings.length === 0 && (
            <div className="voice-panel-empty">
              No voice recordings yet. Use the mic button in any chat input.
            </div>
          )}
          {recordings.map(rec => {
            const text = rec.result?.text ?? '';
            const failed = !text;
            const time = rec.timestamp
              ? new Date(rec.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '';
            return (
              // Natural rows, matching the Notifications panel: the whole row is
              // clickable (insert — the overwhelmingly common action), icon
              // actions surface only on hover. No always-visible buttons.
              <div
                key={rec.id}
                className={`voice-panel-item${failed ? ' failed' : ''}`}
                onClick={() => (failed ? void handleRedo(rec) : handleInsert(rec))}
                role="button"
                tabIndex={0}
                title={failed ? 'Click to re-transcribe' : 'Click to insert'}
                onKeyDown={(e) => { if (e.key === 'Enter') (failed ? void handleRedo(rec) : handleInsert(rec)); }}
              >
                <div className="voice-panel-item-head">
                  <span className="voice-panel-time">{time}</span>
                  {failed && <span className="voice-panel-badge">failed</span>}
                  {flash?.id === rec.id && <span className="voice-panel-flash">{flash.note}</span>}
                  <span className="voice-panel-hover-actions" onClick={(e) => e.stopPropagation()}>
                    {text && (
                      <button type="button" className="voice-panel-icon-btn" title="Copy" onClick={() => handleCopy(rec)}>
                        <CopyIcon />
                      </button>
                    )}
                    <button
                      type="button"
                      className="voice-panel-icon-btn"
                      title="Re-transcribe from stored audio"
                      disabled={busyId === rec.id}
                      onClick={() => void handleRedo(rec)}
                    >
                      {busyId === rec.id ? <span className="voice-panel-busy">…</span> : <RedoIcon />}
                    </button>
                  </span>
                </div>
                <div className="voice-panel-text">
                  {failed ? (rec.error ? `${rec.error}` : 'No transcription') : text}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * Voice history: the recent recordings, in Settings > Voice (it was a sidebar
 * slide-out until 2026-10-26, when the user moved Voice into Settings).
 *
 * The ALWAYS-PRESENT recovery surface for voice input: every transcription is
 * persisted server-side (~/.open-walnut/tmp/stt-recordings via /api/stt/recordings),
 * so even when the browser dropped the response (starvation/tab close), the
 * text is here. Each row: time + status + text preview, with
 *   Insert — put the text into the last-focused chat input (clipboard fallback)
 *   Copy   — copy text to clipboard
 *   Redo   — re-transcribe from the stored audio, server-side
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchRecordings, retranscribeRecording, type VoiceRecording } from '@/api/stt';
import { insertVoiceText, setVoiceStatus } from '@/utils/voice-status';
import { visibleInterval } from '@/utils/page-visibility';
import { log } from '@/utils/log';
import '@/styles/voice-history.css';


const REFRESH_MS = 5_000;

/** The time alone for a take from today, the day before it otherwise. */
function recordedAt(timestamp: string | number): string {
  const d = new Date(timestamp);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

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

export function VoiceHistoryList() {
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

  // Load on mount; light poll while shown so an in-flight transcription's
  // result appears without reopening. visibleInterval: hidden tabs skip the poll.
  useEffect(() => {
    setLoading(true);
    refresh();
    return visibleInterval(refresh, REFRESH_MS);
  }, [refresh]);

  // Seeing the list acknowledges a failed take.
  useEffect(() => { setVoiceStatus({ lastFailed: false }); }, []);

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

  return (
    <div className="voice-history-list" data-testid="voice-history-list">
      {loading && recordings.length === 0 && (
        <div className="voice-panel-empty">Loading…</div>
      )}
      {!loading && recordings.length === 0 && (
        <div className="voice-panel-empty">
          No voice recordings yet. Use the mic in any text box.
        </div>
      )}
      {recordings.map(rec => {
        const text = rec.result?.text ?? '';
        const failed = !text;
        // Text AND an error: the final pass failed after the draft was kept,
        // so this is the start of what was said. Redo gets the rest.
        const partial = !failed && !!rec.error;
        const time = rec.timestamp ? recordedAt(rec.timestamp) : '';
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
              {partial && <span className="voice-panel-badge" title={rec.error}>partial</span>}
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
  );
}

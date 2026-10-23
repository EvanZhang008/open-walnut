import { useState, useEffect, useCallback, useRef } from 'react';
import { useEvent } from './useWebSocket';
import * as audioApi from '@/api/audio';
import { log } from '@/utils/log';
import { afterFirstScreen } from '@/utils/after-first-screen';

export interface AudioCaptureState {
  available: boolean | null;
  permissionGranted: boolean | null;
  recording: boolean;
  recordingId: string | null;
  source: 'system' | 'mic' | 'both' | null;
  totalDuration: number;
  currentChunkIndex: number;
}

export function useAudioCapture() {
  const [state, setState] = useState<AudioCaptureState>({
    available: null,
    permissionGranted: null,
    recording: false,
    recordingId: null,
    source: null,
    totalDuration: 0,
    currentChunkIndex: 0,
  });
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTime = useRef<number | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshAvailability = useCallback(() => {
    audioApi.fetchAudioAvailability().then((res) => {
      setState(s => ({
        ...s,
        available: res.available,
        permissionGranted: res.permissions?.granted ?? null,
      }));
    }).catch(() => {
      setState(s => ({ ...s, available: false }));
    });
  }, []);

  // Check availability on mount (on a phone, after the home rows: N19)
  useEffect(() => {
    afterFirstScreen(refreshAvailability);
  }, [refreshAvailability]);

  // Sync status on mount (on a phone, after the home rows: N19)
  useEffect(() => {
    let live = true;
    afterFirstScreen(() => { if (live) syncStatus(); });
    function syncStatus() {
      audioApi.fetchAudioStatus().then((status) => {
        if (!live) return;
        if (status.recording) {
          setState(s => ({
            ...s,
            recording: true,
            recordingId: status.recordingId,
            source: status.source,
            totalDuration: status.totalDuration,
            currentChunkIndex: status.currentChunkIndex,
          }));
          startTime.current = status.startedAt ? new Date(status.startedAt).getTime() : Date.now();
          startDurationTimer();
        }
      }).catch(() => { /* ignore */ });
    }
    return () => { live = false; stopDurationTimer(); };
  }, []);

  // Listen for audio events via WebSocket
  useEvent('audio:started', (data: unknown) => {
    const d = data as { recordingId: string; source: string };
    log.info('audio', 'recording started via WS', { recordingId: d.recordingId });
    setState(s => ({
      ...s,
      recording: true,
      recordingId: d.recordingId,
      source: (d.source as AudioCaptureState['source']) ?? 'system',
      totalDuration: 0,
      currentChunkIndex: 0,
    }));
    startTime.current = Date.now();
    startDurationTimer();
  });

  useEvent('audio:stopped', (data: unknown) => {
    const d = data as { recordingId: string; duration: number };
    log.info('audio', 'recording stopped via WS', { recordingId: d.recordingId });
    setState(s => ({
      ...s,
      recording: false,
      recordingId: null,
      source: null,
      totalDuration: d.duration,
    }));
    stopDurationTimer();
  });

  useEvent('audio:chunk-saved', (data: unknown) => {
    const d = data as { chunkIndex: number };
    setState(s => ({ ...s, currentChunkIndex: d.chunkIndex }));
  });

  useEvent('audio:transcription-complete', (data: unknown) => {
    const d = data as { recordingId: string; chunkIndex: number; text: string; durationMs: number };
    log.info('audio', 'transcription complete', { recordingId: d.recordingId, chunkIndex: d.chunkIndex, textLength: d.text.length, durationMs: d.durationMs });
  });

  useEvent('audio:error', (data: unknown) => {
    const d = data as { error: string };
    log.error('audio', 'capture error via WS', { error: d.error });
    // Show error to user, auto-clear after 6s
    const msg = d.error.includes('connection being interrupted')
      ? 'Screen Recording permission required. Grant access in System Settings → Privacy & Security → Screen & System Audio Recording, then restart your terminal.'
      : `Recording failed: ${d.error}`;
    setLastError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setLastError(null), 8000);
    // Reset to idle state — the backend auto-stops on stream error
    setState(s => ({
      ...s,
      recording: false,
      recordingId: null,
      source: null,
    }));
    stopDurationTimer();
  });

  function startDurationTimer() {
    stopDurationTimer();
    durationTimer.current = setInterval(() => {
      if (startTime.current) {
        setState(s => ({
          ...s,
          totalDuration: (Date.now() - startTime.current!) / 1000,
        }));
      }
    }, 1000);
  }

  function stopDurationTimer() {
    if (durationTimer.current) {
      clearInterval(durationTimer.current);
      durationTimer.current = null;
    }
  }

  const toggleRecording = useCallback(async () => {
    setLoading(true);
    try {
      if (state.recording) {
        await audioApi.stopRecording();
      } else {
        await audioApi.startRecording({ source: 'system', mode: 'continuous' });
      }
    } catch (err) {
      const msg = (err as Error).message;
      log.error('audio', 'toggle failed', { error: msg });
      setLastError(`Recording failed: ${msg}`);
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setLastError(null), 8000);
    } finally {
      setLoading(false);
    }
  }, [state.recording]);

  const startRecording = useCallback(async (options?: audioApi.StartRecordingOptions) => {
    setLoading(true);
    try {
      await audioApi.startRecording(options);
    } catch (err) {
      log.error('audio', 'start failed', { error: (err as Error).message });
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    setLoading(true);
    try {
      return await audioApi.stopRecording();
    } catch (err) {
      log.error('audio', 'stop failed', { error: (err as Error).message });
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearError = useCallback(() => {
    setLastError(null);
    if (errorTimer.current) { clearTimeout(errorTimer.current); errorTimer.current = null; }
  }, []);

  return {
    ...state,
    loading,
    lastError,
    clearError,
    toggleRecording,
    startRecording,
    stopRecording,
    /** Ask again, after the capture addon's download finished. */
    refreshAvailability,
  };
}

/**
 * React hook for browser-based speech-to-text.
 *
 * Uses MediaRecorder to capture mic audio, then sends to the server
 * for transcription via the configured STT engine.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { transcribeAudio } from '@/api/stt';
import { setVoiceStatus } from '@/utils/voice-status';
import { log } from '@/utils/log';

export interface UseSpeechToTextOptions {
  /** Called with transcribed text when transcription completes */
  onTranscribe: (text: string) => void;
  /** ISO 639-1 language hint */
  language?: string;
}

export interface UseSpeechToTextReturn {
  /** Whether the browser supports MediaRecorder */
  isSupported: boolean;
  /** Currently recording */
  isRecording: boolean;
  /** Waiting for server transcription response */
  isTranscribing: boolean;
  /** Error message (cleared on next toggle) */
  error: string | null;
  /** Start or stop recording */
  toggleRecording: () => void;
  /** Re-transcribe the last recording; pass a model for a one-shot whisper-cli retry */
  retryWithModel: (model?: string) => Promise<void>;
  /** Re-transcribe the last recording with the configured engine (after a failure) */
  retryLast: () => Promise<void>;
  /** Debug audio file path from the last transcription (server-side) */
  lastDebugPath: string | null;
  /** Whether we have a last recording available for retry */
  hasLastRecording: boolean;
  /** Live mic input level 0..1 (smoothed RMS) while recording — drives the waveform UI */
  level: number;
  /**
   * Non-destructive warning shown WHILE recording when the mic appears dead (silent
   * stream). Recording is never auto-stopped; this just nudges the user to check their
   * mic. Auto-clears as soon as sound is detected. null = no warning.
   */
  silenceWarning: string | null;
}

// Mic-silence detection tunables.
// We never auto-stop the recording — that would destroy what the user is saying on a
// false positive and helps nothing on a true one. Instead we surface a non-destructive
// WARNING while recording when the mic looks dead, and clear it the moment sound returns.
// "Dead" = a wedged browser capture (esp. Firefox) emitting pure zero samples (~ -91 dB).
// A real mic always has a noise floor (~ -50..-60 dB) even during a pause, so the
// dead-stream floor below (~ -62 dB) sits cleanly between the two and never trips on a
// user who simply hasn't spoken yet.
const DEAD_STREAM_RMS = 0.0008;      // RMS at/below this = dead-stream territory
// Counted in *sampled ticks*, not wall-clock: a backgrounded/blurred tab can pause our
// sampler, and wall-clock would expire while we captured nothing. Ticks only advance
// while we are actually sampling audio, so backgrounding never false-trips the warning.
const SAMPLE_INTERVAL_MS = 100;      // how often we sample RMS
const SILENCE_WARN_TICKS = 30;       // ~3s of actual sampling with no sound → show warning

const isMediaRecorderSupported =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

export function useSpeechToText({ onTranscribe, language }: UseSpeechToTextOptions): UseSpeechToTextReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDebugPath, setLastDebugPath] = useState<string | null>(null);
  const [hasLastRecording, setHasLastRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [silenceWarning, setSilenceWarning] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Web Audio analyser for live level + early silence detection
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // setInterval (NOT requestAnimationFrame) drives sampling — rAF is throttled/paused
  // when the tab is backgrounded or blurred, which previously broke silence detection.
  const sampleTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // True once the signal rose above the dead-stream floor (incl. a live mic's noise
  // floor). Distinguishes a truly dead stream from a quiet/short real recording so the
  // onstop guard never drops genuine audio. Reset on each start.
  const sawAnyNonDeadRef = useRef(false);
  // True when the analyser successfully attached this recording (so the dead-stream
  // guard in onstop only applies when we actually had working level data).
  const analyserAttachedRef = useRef(false);
  // Keep last audio for retry
  const lastAudioRef = useRef<{ base64: string; format: string } | null>(null);
  // Refs mirror props to avoid stale closures in MediaRecorder.onstop async callback
  const onTranscribeRef = useRef(onTranscribe);
  onTranscribeRef.current = onTranscribe;
  const languageRef = useRef(language);
  languageRef.current = language;
  const isMountedRef = useRef(true);
  // Reset on every mount, not just set-false on unmount: this component can be
  // unmounted+remounted while a recording's async onstop is still pending (parent
  // re-renders the chat input). A one-shot cleanup would leave isMounted=false
  // forever, silently dropping the transcription. Re-arm it on each mount.
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const stopStream = useCallback(() => {
    if (sampleTimerRef.current !== undefined) {
      clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = undefined;
    }
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setLevel(0);
    setSilenceWarning(null);
  }, []);

  const toggleRecording = useCallback(async () => {
    setError(null);

    // Stop recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      return;
    }

    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 16000 } },
      });
      streamRef.current = stream;

      // Set up Web Audio analyser for the live level meter + dead-mic warning.
      // Best-effort: if AudioContext is unavailable, recording still works (just no meter).
      sawAnyNonDeadRef.current = false;
      analyserAttachedRef.current = false;
      setSilenceWarning(null);
      try {
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioCtxRef.current = ctx;
          // An AudioContext can start `suspended` (no user-gesture autoplay). A suspended
          // context feeds the analyser flat silence → false dead-mic warning. resume() is
          // best-effort; the toggle click is itself the gesture.
          if (ctx.state === 'suspended') ctx.resume().catch(() => {});
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyserRef.current = analyser;
          analyserAttachedRef.current = true;

          const buf = new Uint8Array(analyser.fftSize);
          let consecutiveDeadTicks = 0;  // ticks in a row below the dead floor (background-tab safe)

          // setInterval, not rAF: rAF pauses when the tab is backgrounded/blurred, which
          // would freeze sampling. Counting ticks ties detection to real sampling progress.
          // We NEVER stop the recording here — only raise/clear a non-destructive warning.
          sampleTimerRef.current = setInterval(() => {
            const a = analyserRef.current;
            if (!a) return;
            a.getByteTimeDomainData(buf);
            // RMS around the 128 center (silence == flat 128)
            let sumSq = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = (buf[i] - 128) / 128;
              sumSq += v * v;
            }
            const rms = Math.sqrt(sumSq / buf.length);
            // Smooth + amplify a bit for a lively meter display
            setLevel((prev) => prev * 0.6 + Math.min(1, rms * 3) * 0.4);

            if (rms > DEAD_STREAM_RMS) {
              // Mic is alive (even just noise floor) → reset counter and clear any warning.
              sawAnyNonDeadRef.current = true;
              consecutiveDeadTicks = 0;
              setSilenceWarning((w) => (w ? null : w));
            } else {
              // Pure-zero territory: warn after a sustained run, but keep recording so the
              // user decides. The warning auto-clears the instant sound returns (above).
              consecutiveDeadTicks++;
              if (consecutiveDeadTicks >= SILENCE_WARN_TICKS) {
                setSilenceWarning((w) => w ??
                  'No sound from the mic — check your device or restart the browser. Still recording.');
              }
            }
          }, SAMPLE_INTERVAL_MS);
        }
      } catch {
        // Analyser is best-effort; ignore and record without level/silence detection.
      }

      // Prefer webm/opus, fall back to whatever is available
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Recording is only ever stopped by the user (or unmount) — we never auto-stop.
        const deadStream = analyserAttachedRef.current && !sawAnyNonDeadRef.current;
        stopStream();
        setIsRecording(false);

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

        if (blob.size === 0) return;

        // Don't transcribe a DEAD stream — Whisper hallucinates "you"/"thank you" on pure
        // silence. `deadStream` = the analyser ran the whole time and never saw the signal
        // rise above the dead-stream floor (pure-zero). We gate on the dead floor, NOT on
        // whether real speech was detected, so a quiet or very short genuine recording is
        // still transcribed.
        if (deadStream) {
          if (isMountedRef.current) {
            setError('No sound detected from the microphone. Check your mic device (or restart the browser) and try again.');
          }
          return;
        }

        // Convert blob to base64 using FileReader (avoids stack overflow on large audio)
        if (!isMountedRef.current) return;
        setIsTranscribing(true);
        setVoiceStatus({ transcribing: true });
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const dataUrl = reader.result as string;
              resolve(dataUrl.split(',')[1] ?? '');
            };
            reader.onerror = () => reject(new Error('Failed to read audio blob'));
            reader.readAsDataURL(blob);
          });

          // Determine format from mime type (Safari uses audio/mp4)
          const mime = recorder.mimeType;
          const format = mime.includes('webm') ? 'webm'
            : mime.includes('mp4') ? 'mp4'
            : mime.includes('ogg') ? 'ogg'
            : 'webm'; // fallback

          log.info('stt', `Sending ${(blob.size / 1024).toFixed(1)}KB ${format} for transcription`);

          // Save for retry
          lastAudioRef.current = { base64, format };
          if (isMountedRef.current) setHasLastRecording(true);

          const result = await transcribeAudio(base64, format, languageRef.current);

          if (isMountedRef.current && result.debugAudioPath) {
            setLastDebugPath(result.debugAudioPath);
          }

          if (result.text) {
            setVoiceStatus({ transcribing: false, lastFailed: false });
            if (!isMountedRef.current) return;
            onTranscribeRef.current(result.text);
            const preview = result.text.length > 50 ? result.text.slice(0, 50) + '...' : result.text;
            log.info('stt', `Transcribed: "${preview}" (${result.durationMs}ms)`);
          } else {
            // An empty transcription used to fail SILENTLY — spinner ends, nothing
            // appears, and the user thinks the recording was eaten. Surface it; the
            // audio is kept in lastAudioRef so Retry can still recover it.
            log.warn('stt', `Transcription returned empty text (${result.durationMs}ms)`);
            setVoiceStatus({ transcribing: false, lastFailed: true });
            if (isMountedRef.current) {
              setError('Transcription came back empty — the audio is kept, you can retry.');
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('stt', `Transcription failed: ${msg} — audio kept for retry`);
          setVoiceStatus({ transcribing: false, lastFailed: true });
          if (!isMountedRef.current) return;
          setError(msg);
        } finally {
          if (isMountedRef.current) setIsTranscribing(false);
        }
      };

      recorder.onerror = (e: Event) => {
        stopStream();
        setIsRecording(false);
        const errMsg = (e as MediaRecorderErrorEvent)?.error?.message ?? 'Recording error';
        setError(errMsg);
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      stopStream();
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        setError('Microphone permission denied');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    }
  }, [stopStream]);

  const retryWithModel = useCallback(async (model?: string) => {
    const last = lastAudioRef.current;
    if (!last) return;

    setError(null);
    setIsTranscribing(true);
    try {
      log.info('stt', `Retrying transcription${model ? ` with model: ${model}` : ' (configured engine)'}`);
      const result = await transcribeAudio(last.base64, last.format, languageRef.current, model);

      if (isMountedRef.current && result.debugAudioPath) {
        setLastDebugPath(result.debugAudioPath);
      }

      if (result.text && isMountedRef.current) {
        onTranscribeRef.current(result.text);
        const preview = result.text.length > 50 ? result.text.slice(0, 50) + '...' : result.text;
        log.info('stt', `Retry transcribed: "${preview}" (${result.durationMs}ms, model=${model ?? 'configured'})`);
      } else if (!result.text && isMountedRef.current) {
        setError('Transcription came back empty — the audio is kept, you can retry.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('stt', `Retry failed: ${msg}`);
      if (isMountedRef.current) setError(msg);
    } finally {
      if (isMountedRef.current) setIsTranscribing(false);
    }
  }, []);

  const retryLast = useCallback(() => retryWithModel(undefined), [retryWithModel]);

  return {
    isSupported: isMediaRecorderSupported,
    isRecording,
    isTranscribing,
    error,
    toggleRecording,
    retryWithModel,
    retryLast,
    lastDebugPath,
    hasLastRecording,
    level,
    silenceWarning,
  };
}

/**
 * React hook for browser-based speech-to-text.
 *
 * Uses MediaRecorder to capture mic audio, then sends to the server
 * for transcription via the configured STT engine.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  transcribeAudio, draftTranscribe, saveRecording, retranscribeRecording, warmupStt,
  isRetryableDraftFailure, sttFailureMessage,
} from '@/api/stt';
import { setVoiceStatus } from '@/utils/voice-status';
import { joinSegments } from '@/utils/stt-segments';
import { decideDraftTick } from '@/utils/stt-draft-window';
import { PcmCapture, type PcmSource } from '@/utils/pcm-stream';
import { RecorderPcm, browserDecoder } from '@/utils/recorder-pcm';
import { captureSeconds, describeShortSeconds, type CaptureSample } from '@/utils/capture-timeline';
import { DICTATION_AUDIO_CONSTRAINTS } from '@/utils/mic-constraints';
import { initialMicHealth, micHealthTick, micHealthTrackEnded, byteFrameRms, DEAD_STREAM_RMS, SAMPLE_INTERVAL_MS, type MicHealthState } from '@/utils/mic-health';
import { log } from '@/utils/log';

export interface UseSpeechToTextOptions {
  /** Called with transcribed text when transcription completes */
  onTranscribe: (text: string) => void;
  /**
   * Called with the running draft of what has been said so far, every couple of
   * seconds while recording. Each call supersedes the previous one, so the
   * consumer replaces the text it wrote last time rather than appending. When
   * provided, the final onTranscribe call replaces that same region, so the
   * words the user watched appear are the words they end up with.
   */
  onDraft?: (text: string) => void;
  /**
   * Called when the whole-clip pass finishes AFTER the newest draft was already
   * handed over at the stop (so the box is not empty while the clip is heard):
   * the whole-clip text replaces that draft wholesale.
   *
   * `provisional` is the exact text that was delivered, so the consumer can tell
   * whether its text box still holds that untouched and skip the swap if the user
   * has since edited, sent, or dictated over it. Without this the hook waits for
   * the server before showing anything, which is the delay users notice most.
   *
   * Return true when the text box now holds `finalText` where `provisional` was.
   * A Retry after a partial failure reads it: a swap that could not happen means
   * the complete words are inserted instead, never dropped.
   */
  onRefine?: (finalText: string, provisional: string) => boolean | void;
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
   * The mic is delivering sound this recording. False from the press until the
   * first sample above the dead floor: a Bluetooth headset (AirPods) opens its mic
   * up to 2 s after the stream does, and words said before that are not recorded.
   */
  micLive: boolean;
  /** Pressed, and the browser is still opening the mic (before recording starts). */
  micOpening: boolean;
  /**
   * Non-destructive warning shown WHILE recording when the mic appears dead (silent
   * stream). Recording is never auto-stopped; this just nudges the user to check their
   * mic. Auto-clears as soon as sound is detected. null = no warning.
   */
  silenceWarning: string | null;
  /** True while a live draft is being streamed into the consumer's text. */
  isDrafting: boolean;
  /**
   * Stop recording and throw the audio away without delivering any text. For when
   * the user has already acted on what they see (sending the message), so a
   * transcription landing afterwards would duplicate what they just sent.
   */
  discardRecording: () => void;
  /**
   * Stop a live recording (if any) and resolve once its words are in the
   * consumer's box: recording and transcribing are both over. Resolves at once
   * when nothing is recording or transcribing. `error` is the failure the
   * recording ended on (its words, if any, are still delivered), for a send that
   * waited on it (useSendAfterDictation) to stay unsent.
   */
  finishRecording: () => Promise<DictationOutcome>;
  /** Recording, or its words still on their way. */
  isBusy: () => boolean;
}

/** How a dictation a send waited on ended. */
export interface DictationOutcome {
  error: string | null;
}

/** A waiter left when its mic goes away mid-dictation: its words will not come. */
export const DICTATION_CLOSED_ERROR = 'The microphone closed before its words came back.';
/** A waiter whose recording was thrown away (the box switched to another target). */
export const DICTATION_DISCARDED_ERROR = 'The dictation was thrown away before its words came back.';

// Mic-silence detection lives in mic-health.ts (the rules and why). We never
// auto-stop the recording: the warning is non-destructive and clears itself the
// moment sound returns.

// Live-draft tunables. The draft normally works on a raw-PCM side capture
// (pcm-stream.ts) so each tick only transcribes the CURRENT segment: audio up
// to the last committed pause is frozen as text and never re-processed, which
// keeps ticks fast no matter how long the dictation runs. When PCM capture is
// unavailable the fallback re-transcribes the whole webm clip every tick (webm
// chunks only decode as a from-the-start concatenation). Drop-if-busy keeps at
// most one draft request in flight either way.
const DRAFT_INTERVAL_MS = 2000;
const DRAFT_MAX_BYTES = 4 * 1024 * 1024; // upload cap per draft request, EVERY path
// Belt to COMMIT_FORCE_AFTER_MS's braces. forceAfterMs only fires when the
// window contains speech and a cut point can be placed in it, so a window can
// stay open indefinitely (a user who leaves the mic on in silence: measured
// 4m19s on 2026-09-01, the draft dead and the upload growing the whole time).
// This bound needs no cooperation from the audio: past it, the window is clamped
// forward on the clock alone.
const DRAFT_MAX_WINDOW_MS = 20000;
// Past this much audio the recorder's WebM is no longer decoded every tick:
// each decode reads the whole take again, so its cost grows with the take.
// The draft stops and the stop hears the whole clip instead.
const RECORDER_DRAFT_MAX_MS = 5 * 60_000;
// A pause this long is a safe place to cut a segment: no word straddles it,
// and it is comfortably longer than an intra-sentence breath.
const COMMIT_SILENCE_MS = 800;
// Don't bother committing scraps — a segment shorter than this is cheap to
// keep re-drafting and committing it would just multiply requests.
const COMMIT_MIN_SEGMENT_MS = 3000;
// Continuous talkers never leave an 800ms gap, and without a commit every tick
// re-transcribes the whole open segment: a measured 27s dictation went from
// 0.6s to 4.4s per tick and never advanced. So past 5s of unbroken speech we
// accept shorter and shorter pauses, and past 12s we cut at the quietest point
// regardless. Those bounds keep the open window near 10s of audio, which the
// engine drafts in about a second — the ceiling this feature is held to.
const COMMIT_RELAX_AFTER_MS = 5000;
const COMMIT_SILENCE_FLOOR_MS = 260;
const COMMIT_FORCE_AFTER_MS = 12000;
// Timeslice handed to MediaRecorder.start(), so one chunk ≈ one second of audio.
// Chunk counts are how we compare "audio the newest draft saw" against "audio the
// user was still talking in" without decoding anything.
const CHUNK_MS = 1000;
// Speech-presence floor for that comparison. A mic's noise floor sits near 0.001
// RMS and ordinary speech well above 0.05, so this reads a pause as a pause while
// still counting a quiet talker as speech. Deliberately far above DEAD_STREAM_RMS,
// which only has to separate a wedged capture from a live one.
const VOICE_RMS = 0.012;

const isMediaRecorderSupported =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

export function useSpeechToText({ onTranscribe, onDraft, onRefine, language }: UseSpeechToTextOptions): UseSpeechToTextReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDebugPath, setLastDebugPath] = useState<string | null>(null);
  const [hasLastRecording, setHasLastRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [micLive, setMicLive] = useState(false);
  const [micOpening, setMicOpening] = useState(false);
  const [silenceWarning, setSilenceWarning] = useState<string | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);
  // Live-draft machinery: interval timer + in-flight guard (drop ticks while a
  // draft request is still running instead of queuing behind it).
  const draftTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const draftBusyRef = useRef(false);
  // Abort handle for the in-flight draft request. Stopping the recording aborts
  // it so the final pass isn't queued behind a draft that no longer matters.
  const draftAbortRef = useRef<AbortController | null>(null);
  // Raw-PCM side capture (segment-commit drafting). Null when the audio graph
  // could not be built — drafting then falls back to whole-clip webm.
  const pcmRef = useRef<PcmCapture | null>(null);
  // The recorder's own audio, decoded as it grows: what the live draft reads
  // whenever the browser can decode it (recorder-pcm.ts says why).
  const recPcmRef = useRef<RecorderPcm | null>(null);
  // Which audio this recording's drafts read, fixed at its first decodable
  // tick so sample positions never switch timelines mid-recording.
  const liveSourceRef = useRef<'recorder' | 'side' | 'webm' | null>(null);
  // Text committed at silence gaps this recording — frozen, never re-transcribed.
  const confirmedRef = useRef('');
  // Absolute sample offset where the still-open draft window begins.
  const windowStartRef = useRef(0);
  // A draft window that moved past audio nobody drafted repeats every tick, so
  // only the first one is logged.
  const draftSkipLoggedRef = useRef(false);
  // True once the draft lane has been retired for this recording.
  const draftRetiredRef = useRef(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // While the browser opens the mic there is no recorder yet, so a second press
  // would open a second stream and the first would never close (the mic stays
  // in use, a headset stays in its low-quality call mode). That press cancels.
  const openingRef = useRef(false);
  const cancelOpenRef = useRef(false);
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
  // The mic warning's state for this recording (mic-health.ts), and when the
  // recorder started, to tell at stop how much audio the capture delivered.
  const micHealthRef = useRef<MicHealthState>(initialMicHealth());
  const recordStartedAtRef = useRef(0);
  // One sample per level tick, for the stop-time "where did the audio go" line.
  const timelineRef = useRef<CaptureSample[]>([]);
  const recBytesRef = useRef(0);
  // True when the analyser successfully attached this recording (so the dead-stream
  // guard in onstop only applies when we actually had working level data).
  const analyserAttachedRef = useRef(false);
  // Keep last audio for retry
  const lastAudioRef = useRef<{ base64: string; format: string } | null>(null);
  // The history row this hook stored the last clip under (null: none, or
  // /transcribe stored it server-side). A Retry re-runs that row in place.
  const savedRecordingRef = useRef<Promise<string | null> | null>(null);
  // Text of the last recording already in the consumer's box when its final
  // pass failed: the words before the failure. A Retry replaces it.
  const retryReplacesRef = useRef<string | null>(null);
  // Refs mirror props to avoid stale closures in MediaRecorder.onstop async callback
  const onTranscribeRef = useRef(onTranscribe);
  onTranscribeRef.current = onTranscribe;
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const onRefineRef = useRef(onRefine);
  onRefineRef.current = onRefine;
  // Set when the user acts on the text themselves (sends the message) while a
  // recording is live: stop, and deliver nothing.
  const discardedRef = useRef(false);
  // Last draft handed to the consumer this recording. If the final pass fails or
  // comes back empty we deliver this instead, so the user keeps the words they
  // watched appear (and the consumer's draft span gets released either way).
  const lastDraftRef = useRef<string | null>(null);
  const languageRef = useRef(language);
  languageRef.current = language;
  // Sends waiting on this recording (finishRecording), told once it is over.
  const finishWaitersRef = useRef<Array<(outcome: DictationOutcome) => void>>([]);
  const [finishTick, setFinishTick] = useState(0);
  const busyRenderedRef = useRef(false);
  busyRenderedRef.current = isRecording || isTranscribing;
  const isMountedRef = useRef(true);
  // Reset on every mount, not just set-false on unmount: this component can be
  // unmounted+remounted while a recording's async onstop is still pending (parent
  // re-renders the chat input). A one-shot cleanup would leave isMounted=false
  // forever, silently dropping the transcription. Re-arm it on each mount.
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  /**
   * Final pass failed or came back empty, but the user already watched a draft
   * appear in their text box. Promote that draft to the final result rather than
   * yanking it away: the words are good enough to send or edit, the audio is
   * still in history for a Redo, and the consumer's draft span gets released.
   * Returns the promoted draft, or null when there was none.
   */
  const keepLastDraft = useCallback((): string | null => {
    const draft = lastDraftRef.current;
    if (!draft) return null;
    lastDraftRef.current = null;
    log.warn('stt', 'final transcription unusable — keeping the live draft text');
    onTranscribeRef.current(draft);
    return draft;
  }, []);

  /**
   * Stop drafting for the rest of this recording, keep recording.
   *
   * The draft is a PREVIEW: a preview that cannot succeed must stop asking. The
   * failures that land here are payload rejections (413/415/422), where the next
   * tick's request would be the same shape as the one just refused — retrying it
   * every 2s costs the whole server's event loop and buys nothing. The
   * authoritative text still comes from the pass on mic release, so retiring the
   * lane degrades the live preview and nothing else.
   */
  const retireDraftLane = useCallback((reason: string) => {
    if (draftTimerRef.current !== undefined) {
      clearInterval(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    if (draftRetiredRef.current) return;
    draftRetiredRef.current = true;
    log.warn('stt', `live draft stopped for this recording — ${reason}. Recording continues; the text you get on stop is unaffected.`);
  }, []);

  const stopStream = useCallback(() => {
    if (draftTimerRef.current !== undefined) {
      clearInterval(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    if (sampleTimerRef.current !== undefined) {
      clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = undefined;
    }
    analyserRef.current = null;
    // Detach (stop capturing); the object is replaced on the next start.
    pcmRef.current?.detach();
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setLevel(0);
    setSilenceWarning(null);
    setIsDrafting(false);
  }, []);

  const toggleRecording = useCallback(async () => {
    setError(null);

    // Stop recording. Abort the in-flight draft first: its result is about to
    // be superseded, and on a busy engine it would otherwise delay the
    // whole-clip pass by a whole request.
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      draftAbortRef.current?.abort();
      mediaRecorderRef.current.stop();
      return;
    }

    // Pressed again while the mic is still opening: cancel that start.
    if (openingRef.current) {
      cancelOpenRef.current = true;
      setMicOpening(false);
      return;
    }

    // Start recording
    try {
      // Load the engine while the user talks, not in front of the first draft.
      warmupStt();
      const clickAt = performance.now();
      openingRef.current = true;
      cancelOpenRef.current = false;
      setMicOpening(true);
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: DICTATION_AUDIO_CONSTRAINTS });
      } finally {
        openingRef.current = false;
      }
      if (cancelOpenRef.current || !isMountedRef.current) {
        cancelOpenRef.current = false;
        for (const track of stream.getTracks()) track.stop();
        setMicOpening(false);
        return;
      }
      const openedMs = Math.round(performance.now() - clickAt);
      streamRef.current = stream;

      // Set up Web Audio analyser for the live level meter + dead-mic warning.
      // Best-effort: if AudioContext is unavailable, recording still works (just no meter).
      sawAnyNonDeadRef.current = false;
      analyserAttachedRef.current = false;
      micHealthRef.current = initialMicHealth();
      setMicLive(false);
      timelineRef.current = [];
      recBytesRef.current = 0;
      setSilenceWarning(null);
      // What the capture track says about itself, for the log: a stall that
      // comes with a mute is the browser's, one without is the pipeline's.
      // `ended` is final (device unplugged, permission revoked), so it warns.
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener('mute', () => log.warn('stt', 'microphone track muted mid-recording'));
        track.addEventListener('unmute', () => log.info('stt', 'microphone track unmuted'));
        track.addEventListener('ended', () => {
          if (streamRef.current !== stream) return;
          log.warn('stt', 'microphone track ended mid-recording');
          const tick = micHealthTrackEnded(micHealthRef.current);
          micHealthRef.current = tick.state;
          setSilenceWarning(tick.warning);
        });
      }
      pcmRef.current = null;
      recPcmRef.current = null;
      liveSourceRef.current = null;
      confirmedRef.current = '';
      windowStartRef.current = 0;
      draftSkipLoggedRef.current = false;
      draftRetiredRef.current = false;
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
          // Raw-PCM side capture for segment-commit drafting (null on failure →
          // the draft loop falls back to whole-clip webm).
          pcmRef.current = PcmCapture.attach(ctx, stream);

          const buf = new Uint8Array(analyser.fftSize);
          const timelineT0 = performance.now();
          const ctxT0 = ctx.currentTime;
          // The first `running` is the start, and `closed` after stop is ours.
          let ctxRan = ctx.state === 'running';
          ctx.addEventListener('statechange', () => {
            if (streamRef.current !== stream) return;
            if (ctx.state === 'running' && !ctxRan) { ctxRan = true; return; }
            log.warn('stt', `audio context ${ctx.state} mid-recording`);
          });

          // setInterval, not rAF: rAF pauses when the tab is backgrounded/blurred, which
          // would freeze sampling. Counting ticks ties detection to real sampling progress.
          // We NEVER stop the recording here — only raise/clear a non-destructive warning.
          sampleTimerRef.current = setInterval(() => {
            const a = analyserRef.current;
            if (!a) return;
            a.getByteTimeDomainData(buf);
            const rms = byteFrameRms(buf);
            // Smooth + amplify a bit for a lively meter display
            setLevel((prev) => prev * 0.6 + Math.min(1, rms * 3) * 0.4);

            const pcmNow = pcmRef.current;
            if (timelineRef.current.length < 36_000) timelineRef.current.push({
              wallMs: performance.now() - timelineT0,
              pcmMs: pcmNow ? pcmNow.totalSamples / (pcmNow.sampleRate / 1000) : 0,
              ctxMs: (ctx.currentTime - ctxT0) * 1000,
              zero: rms <= DEAD_STREAM_RMS,
              recBytes: recBytesRef.current,
            });
            const tick = micHealthTick(micHealthRef.current, rms);
            if (tick.state.alive && !micHealthRef.current.alive) {
              setMicLive(true);
              // How long the user talked into nothing: the words said before
              // the first sample are not in the recording.
              const settings = stream.getAudioTracks()[0]?.getSettings();
              log.info('stt', `mic delivered sound ${Math.round(performance.now() - clickAt)}ms after the click (opened in ${openedMs}ms)`, {
                device: stream.getAudioTracks()[0]?.label ?? null,
                echoCancellation: settings?.echoCancellation ?? null,
                sampleRate: settings?.sampleRate ?? null,
              });
            }
            micHealthRef.current = tick.state;
            if (tick.state.alive) sawAnyNonDeadRef.current = true;
            if (tick.stallEndedTicks !== undefined) {
              log.warn('stt', `audio input went silent for ${tick.stallEndedTicks * SAMPLE_INTERVAL_MS}ms mid-recording, then came back (no warning shown)`, {
                contextState: ctx.state,
                trackMuted: stream.getAudioTracks()[0]?.muted ?? null,
              });
            }
            setSilenceWarning((w) => {
              if (w === tick.warning) return w;
              if (tick.warning) log.warn('stt', `mic warning shown: ${tick.warning}`, { deadTicks: tick.state.deadTicks, alive: tick.state.alive });
              return tick.warning;
            });
          }, SAMPLE_INTERVAL_MS);
        }
      } catch {
        // Analyser is best-effort; ignore and record without level/silence detection.
      }
      // No analyser, no way to hear the first sound: never hold the button in its
      // starting look.
      if (!analyserAttachedRef.current) setMicLive(true);

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
        recBytesRef.current += e.data.size;
      };

      recorder.onstop = async () => {
        // Recording is only ever stopped by the user (or unmount) — we never auto-stop.
        const deadStream = analyserAttachedRef.current && !sawAnyNonDeadRef.current;
        stopStream();
        setIsRecording(false);

        // The capture can hold less audio than the time it ran (2026-10-31 in
        // the Mac app: seconds of samples lost). Log it, so a "my words are
        // missing" report can be traced; the capture timeline below says which
        // clock fell behind.
        const capturedPcm = pcmRef.current;
        if (capturedPcm && recordStartedAtRef.current > 0) {
          const ranMs = Date.now() - recordStartedAtRef.current;
          const capturedMs = Math.round(capturedPcm.totalSamples / (capturedPcm.sampleRate / 1000));
          if (ranMs - capturedMs > 1500) {
            log.warn('stt', `audio fell behind: the side capture holds ${capturedMs}ms for ${ranMs}ms of recording (${ranMs - capturedMs}ms short)`);
          }
        }
        const shortSeconds = describeShortSeconds(captureSeconds(timelineRef.current));
        if (shortSeconds) log.warn('stt', `capture timeline (per second: sampler ticks, zero ticks, side-capture ms, audio-clock ms, recorder bytes): ${shortSeconds}`);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];
        // This recording's preview, read now: the mic can start the next
        // recording before the pass below returns, and that resets the refs.
        const live = {
          source: liveSourceRef.current,
          draft: lastDraftRef.current,
        };

        const discarded = discardedRef.current;
        if (discarded) discardedRef.current = false;

        if (blob.size === 0) return;

        // Don't transcribe a DEAD stream — Whisper hallucinates "you"/"thank you" on pure
        // silence. `deadStream` = the analyser ran the whole time and never saw the signal
        // rise above the dead-stream floor (pure-zero). We gate on the dead floor, NOT on
        // whether real speech was detected, so a quiet or very short genuine recording is
        // still transcribed.
        if (deadStream) {
          // Nothing to report when the text was already sent — the user is not
          // waiting on this recording, so an error would come out of nowhere.
          if (isMountedRef.current && !discarded) {
            setError('No sound detected from the microphone. Check your mic device (or restart the browser) and try again.');
          }
          return;
        }

        // Determine format from mime type (Safari uses audio/mp4)
        const mime = recorder.mimeType;
        const format = mime.includes('webm') ? 'webm'
          : mime.includes('mp4') ? 'mp4'
          : mime.includes('ogg') ? 'ogg'
          : 'webm'; // fallback

        // Convert blob to base64 using FileReader (avoids stack overflow on large audio)
        const readBlobBase64 = () => new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(',')[1] ?? '');
          };
          reader.onerror = () => reject(new Error('Failed to read audio blob'));
          reader.readAsDataURL(blob);
        });

        // Keep the full clip for Retry, then write it (plus the final text) to
        // the recordings history. Fire-and-forget: the text is already in the
        // user's hands by the time this runs, history must not delay it.
        const keepForRetry = async (): Promise<string> => {
          const base64 = await readBlobBase64();
          lastAudioRef.current = { base64, format };
          savedRecordingRef.current = null;
          retryReplacesRef.current = null;
          if (isMountedRef.current) setHasLastRecording(true);
          return base64;
        };
        const persistHistory = (base64: string, finalText: string, failure?: string) => {
          savedRecordingRef.current = saveRecording(base64, format, finalText, languageRef.current, failure)
            .then((saved) => {
              if (isMountedRef.current) setLastDebugPath(saved.debugAudioPath);
              return saved.recordingId;
            })
            .catch((e) => {
              log.warn('stt', `recording history write failed: ${e instanceof Error ? e.message : String(e)}`);
              return null;
            });
        };
        const persistRecording = async (finalText: string) => {
          try {
            persistHistory(await keepForRetry(), finalText);
          } catch { /* retry/history are best-effort */ }
        };
        // The user hit send while still recording, so they already have the text
        // they were looking at: delivering anything now would duplicate that
        // message. Only the DELIVERY is skipped though — the clip still goes to
        // the recordings history with the text as of the send, because dropping
        // it outright left no Retry and no audio to debug a bad dictation with
        // (a slow-dictation report had no recording for exactly this reason).
        if (discarded) {
          const sent = lastDraftRef.current ?? '';
          lastDraftRef.current = null;
          log.info('stt', `recording kept but not delivered — the text was already sent (${sent.length} chars)`);
          void persistRecording(sent);
          return;
        }

        // The text is the whole recording heard once, exactly as the engine
        // gives it (2026-11-09, the user: "just send full ... just what ever we
        // said it should send it, without modify"). The live drafts every 2 s
        // are only a preview: the newest one goes into the box at once, so the
        // user has something to look at while the clip is heard, and the
        // whole-clip text replaces it wholesale. Nothing here edits the text.
        const draft = live.draft;
        let provisional: string | null = null;
        if (draft) {
          if (lastDraftRef.current === draft) lastDraftRef.current = null;
          log.info('stt', `stop → whole clip (the newest preview, ${draft.length} chars, shows meanwhile; source ${live.source ?? 'none'})`);
          if (isMountedRef.current) onTranscribeRef.current(draft);
          provisional = draft;
        }

        if (!isMountedRef.current) return;
        setIsTranscribing(true);
        setVoiceStatus({ transcribing: true });
        // Set while the pass runs: a failure stores the clip itself with the
        // words the user has, or dismissing the error, or the next recording,
        // loses it.
        let unstoredClip: string | null = null;
        try {
          const base64 = await readBlobBase64();
          log.info('stt', `Sending ${(blob.size / 1024).toFixed(1)}KB ${format} for transcription`);
          lastAudioRef.current = { base64, format };
          savedRecordingRef.current = null;
          retryReplacesRef.current = null;
          if (isMountedRef.current) setHasLastRecording(true);
          unstoredClip = base64;
          // /transcribe stores this clip and its text server-side, so history
          // is not written again here.
          const result = await transcribeAudio(base64, format, languageRef.current);
          unstoredClip = null;
          if (isMountedRef.current && result.debugAudioPath) setLastDebugPath(result.debugAudioPath);
          const finalText = result.text;
          const tookMs = result.durationMs;
          const via = ', whole clip';

          if (finalText) {
            setVoiceStatus({ transcribing: false, lastFailed: false });
            if (!isMountedRef.current) return;
            lastDraftRef.current = null; // superseded by the whole-clip text
            if (provisional !== null) {
              // The draft is already in the user's text box. Let the consumer swap
              // it only if it is still sitting there untouched; identical text is a
              // no-op it can skip. Falls back to a plain write when the consumer
              // does not implement refining.
              if (onRefineRef.current) {
                // The user changed the preview meanwhile: their edit stands, and
                // the whole-clip text stays in the recordings history.
                if (onRefineRef.current(finalText, provisional) === false) {
                  log.warn('stt', `whole-clip text not swapped in: the preview was edited before it arrived (${provisional.length} preview chars, ${finalText.length} final chars)`);
                }
              } else if (finalText !== provisional) onTranscribeRef.current(finalText);
            } else {
              onTranscribeRef.current(finalText);
            }
            const preview = finalText.length > 50 ? finalText.slice(0, 50) + '...' : finalText;
            log.info('stt', `Transcribed: "${preview}" (${tookMs}ms${via})`);
          } else {
            // An empty transcription used to fail SILENTLY — spinner ends, nothing
            // appears, and the user thinks the recording was eaten. Surface it; the
            // audio is kept in lastAudioRef so Retry can still recover it.
            log.warn('stt', `Transcription returned empty text (${tookMs}ms)`);
            setVoiceStatus({ transcribing: false, lastFailed: true });
            if (isMountedRef.current) {
              // A preview is not the text: with it still in the box, this is an
              // error, so a Send waiting on the words holds and Retry can hear
              // the clip again in its place.
              const shown = provisional ?? keepLastDraft();
              retryReplacesRef.current = shown;
              setError(shown
                ? 'The whole recording came back with no words; the preview is kept, not sent. Retry hears it again.'
                : 'Transcription came back empty — the audio is kept, you can retry.');
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('stt', `Transcription failed: ${msg} — audio kept for retry`);
          setVoiceStatus({ transcribing: false, lastFailed: true });
          // Words the user already has: the draft handed over at stop, or the
          // newest draft promoted now. They are only the START of what was said
          // (the failed pass was the rest), so this is a partial result, and it
          // says so. It used to pass silently, and the end of the dictation was
          // gone with no Retry and no history row (2026-09-28).
          const partial = provisional ?? (isMountedRef.current ? keepLastDraft() : null);
          const reason = sttFailureMessage(err);
          if (unstoredClip) persistHistory(unstoredClip, partial ?? '', reason);
          if (!isMountedRef.current) return;
          retryReplacesRef.current = partial;
          setError(partial ? `Only part was transcribed. ${reason}` : reason);
        } finally {
          if (isMountedRef.current) setIsTranscribing(false);
        }
      };

      recorder.onerror = (e: Event) => {
        stopStream();
        setIsRecording(false);
        const recorderError = 'error' in e ? e.error : undefined;
        const errMsg = recorderError instanceof Error ? recorderError.message : 'Recording error';
        setError(errMsg);
      };

      // Timeslice so chunks accumulate during recording — the live draft below
      // needs decodable audio-so-far (a from-the-start concat of webm chunks).
      recorder.start(CHUNK_MS);
      const decode = browserDecoder();
      recPcmRef.current = decode ? new RecorderPcm(decode) : null;
      recordStartedAtRef.current = Date.now();
      setIsRecording(true);
      setMicOpening(false);
      setIsDrafting(false);
      lastDraftRef.current = null;
      discardedRef.current = false;
      if (!onDraftRef.current) return; // consumer takes final text only

      // Live draft: every couple of seconds transcribe what's been said so far
      // and hand it to the consumer, which writes it straight into its text box.
      // Best-effort — any failure just means no update this tick; the final
      // transcription on stop is untouched by this.
      const draftFormat = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'webm';
      draftBusyRef.current = false;

      // Records that [from, to) of the recording was abandoned by the draft
      // pipeline: the preview misses those words (the final text never does,
      // it is the whole clip).
      const noteAbandonedSpan = (pcm: PcmSource, from: number, to: number, why: string) => {
        if (to <= from) return;
        const lostSpeech = pcm.hasVoiceBetween(from, to, VOICE_RMS);
        if (!draftSkipLoggedRef.current) {
          draftSkipLoggedRef.current = true;
          const ms = Math.round((to - from) / (pcm.sampleRate / 1000));
          log.warn('stt', `draft window advanced without transcribing ${ms}ms of audio (${lostSpeech ? 'contained speech' : 'silence only'}) — ${why}`);
        }
      };

      // Segment-commit drafting on the raw-PCM capture. Each tick does ONE of
      // two things: if a qualifying pause exists, finalize the segment before it
      // (that text is frozen and its audio never touched again — this is what
      // keeps ticks fast forever); otherwise refresh the live preview of the
      // open segment. The visible text is always confirmed + current tail.
      // Whatever it does, the window position obeys decideDraftTick: every bound
      // that can stop an upload also moves the window forward, or the next tick
      // is bigger than this one and the loop never recovers.
      const pcmDraftTick = async (pcm: PcmSource) => {
        const abort = new AbortController();
        draftAbortRef.current = abort;
        try {
          const windowStart = windowStartRef.current;
          const commitAt = pcm.findCommitPoint(windowStart, {
            voiceRms: VOICE_RMS,
            minSilenceMs: COMMIT_SILENCE_MS,
            minSegmentMs: COMMIT_MIN_SEGMENT_MS,
            relaxAfterMs: COMMIT_RELAX_AFTER_MS,
            minSilenceFloorMs: COMMIT_SILENCE_FLOOR_MS,
            forceAfterMs: COMMIT_FORCE_AFTER_MS,
          });
          // Encode only when a decision can still need the bytes: a window past
          // the wall-clock bound is about to be abandoned, and base64-encoding
          // megabytes of it would burn the main thread for nothing.
          const openMs = (pcm.totalSamples - windowStart) / (pcm.sampleRate / 1000);
          const slice = (commitAt !== null || openMs <= DRAFT_MAX_WINDOW_MS)
            ? pcm.sliceWavBase64(windowStart, commitAt ?? undefined)
            : null;
          const decision = decideDraftTick({
            windowStart,
            totalSamples: pcm.totalSamples,
            sampleRate: pcm.sampleRate,
            commitAt,
            sliceBytes: slice?.base64.length ?? 0,
            maxBytes: DRAFT_MAX_BYTES,
            maxWindowMs: DRAFT_MAX_WINDOW_MS,
          });

          if (decision.action === 'commit-upload' && slice) {
            // A complete phrase with silence on both sides: this pass sees full
            // context, so its text is better than any mid-sentence preview was.
            try {
              const { text } = await draftTranscribe(slice.base64, 'wav', languageRef.current, abort.signal);
              // Stopped meanwhile → onstop owns everything from windowStart on;
              // adopting this result now would double-commit the segment.
              if (mediaRecorderRef.current !== recorder) return;
              confirmedRef.current = joinSegments(confirmedRef.current, text);
            } catch (err) {
              // Our own abort (stop/discard) leaves the window alone: onstop is
              // about to transcribe from exactly here.
              if (abort.signal.aborted || mediaRecorderRef.current !== recorder) return;
              const msg = err instanceof Error ? err.message : String(err);
              // The boundary is a POSITION, not a result. It advances even
              // though this segment's text was lost, because leaving it behind
              // is what made every following tick bigger than the last until
              // the request could not possibly succeed.
              noteAbandonedSpan(pcm, windowStart, decision.nextWindowStart, `commit transcribe failed (${msg})`);
              if (!isRetryableDraftFailure(err)) retireDraftLane(msg);
            }
            windowStartRef.current = decision.nextWindowStart;
            // Leave the visible draft alone: it still shows this segment's text
            // from the pre-commit preview, and the next tick repaints it as
            // confirmed + fresh tail. Repainting here would briefly drop words
            // spoken after the pause.
            return;
          }

          if (decision.action === 'preview-upload' && slice) {
            try {
              const { text } = await draftTranscribe(slice.base64, 'wav', languageRef.current, abort.signal);
              // Only show while THIS recording is still live (a stale draft
              // landing after stop must not flash over the final result).
              if (isMountedRef.current && mediaRecorderRef.current === recorder) {
                const display = joinSegments(confirmedRef.current, text);
                if (display) {
                  setIsDrafting(true);
                  lastDraftRef.current = display;
                  onDraftRef.current?.(display);
                }
              }
            } catch (err) {
              // A failed preview loses nothing: the audio is still inside the
              // open window and the next tick re-reads it.
              if (abort.signal.aborted) return;
              if (!isRetryableDraftFailure(err)) {
                retireDraftLane(err instanceof Error ? err.message : String(err));
              }
            }
            return;
          }

          // 'commit-skip' | 'preview-skip' | 'force-advance': no upload this
          // tick, but the window still moves wherever the bounds say it must.
          if (decision.nextWindowStart > windowStart) {
            noteAbandonedSpan(pcm, windowStart, decision.nextWindowStart,
              `${decision.action} (slice ${slice?.base64.length ?? 0}B, window ${Math.round(decision.windowMs)}ms)`);
          }
          windowStartRef.current = decision.nextWindowStart;
        } finally {
          draftAbortRef.current = null;
        }
      };

      // The audio this tick drafts from. The recorder's own audio when the
      // browser decodes it (decoded afresh each tick, so the draft hears what
      // the recording holds); else the side capture; else the whole webm.
      // Null: nothing to draft this tick.
      let recDecodeFailures = 0;
      let slowDecodeLogged = false;
      const liveDraftSource = async (): Promise<PcmSource | 'webm' | null> => {
        const rec = recPcmRef.current;
        if (rec && liveSourceRef.current !== 'side' && liveSourceRef.current !== 'webm') {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
          if (blob.size === 0) return null;                      // no chunk yet
          if (blob.size > DRAFT_MAX_BYTES) {
            retireDraftLane(`clip past the ${DRAFT_MAX_BYTES} byte draft cap`);
            return null;
          }
          try {
            const t0 = Date.now();
            await rec.refresh(blob);
            if (mediaRecorderRef.current !== recorder) return null;
            const decodeMs = Date.now() - t0;
            if (decodeMs > 1000 && !slowDecodeLogged) {
              slowDecodeLogged = true;
              log.warn('stt', `decoding the recorder's audio took ${decodeMs}ms for ${Math.round(rec.totalSamples / 16)}ms of audio`);
            }
            if (rec.totalSamples > RECORDER_DRAFT_MAX_MS * 16) {
              retireDraftLane(`take past ${RECORDER_DRAFT_MAX_MS / 60_000} minutes, the recorder's audio is no longer decoded every tick`);
              return null;
            }
            if (!liveSourceRef.current) {
              liveSourceRef.current = 'recorder';
              log.info('stt', 'live draft reads the recorder\'s own audio');
            }
            return rec;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Positions already taken on the recorder's timeline stay on it, and
            // the first chunks may hold too little to decode: skip this tick.
            if (liveSourceRef.current === 'recorder' || ++recDecodeFailures < 3) return null;
            liveSourceRef.current = pcmRef.current ? 'side' : 'webm';
            log.warn('stt', `live draft reads the ${liveSourceRef.current === 'side' ? 'side capture' : 'whole webm'}: the recorder's audio did not decode (${msg})`);
          }
        }
        if (liveSourceRef.current === 'webm') return 'webm';
        return pcmRef.current ?? 'webm';
      };

      // Fallback when the PCM capture failed: re-transcribe the whole webm clip
      // every tick (webm chunks only decode from the start, so no slicing).
      const webmDraftTick = async () => {
        const chunks = chunksRef.current;
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (blob.size > DRAFT_MAX_BYTES) {                      // very long clip — stop drafting
          retireDraftLane(`clip past the ${DRAFT_MAX_BYTES} byte draft cap`);
          return;
        }
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve((reader.result as string).split(',')[1] ?? '');
          reader.onerror = () => reject(new Error('draft blob read failed'));
          reader.readAsDataURL(blob);
        });
        const abort = new AbortController();
        draftAbortRef.current = abort;
        try {
          const { text } = await draftTranscribe(base64, draftFormat, languageRef.current, abort.signal);
          if (isMountedRef.current && mediaRecorderRef.current === recorder && text) {
            setIsDrafting(true);
            lastDraftRef.current = text;
            onDraftRef.current?.(text);
          }
        } catch (err) {
          // Same rule as the PCM path: a body the server refuses on its face
          // will be refused again next tick, so stop asking. This path always
          // re-sends the whole clip, which only grows — retrying it is the
          // worst version of the loop.
          if (!abort.signal.aborted && !isRetryableDraftFailure(err)) {
            retireDraftLane(err instanceof Error ? err.message : String(err));
          }
        } finally {
          draftAbortRef.current = null;
        }
      };

      draftTimerRef.current = setInterval(async () => {
        if (draftBusyRef.current) return;                       // previous request still in flight
        if (mediaRecorderRef.current !== recorder || recorder.state === 'inactive') return;
        draftBusyRef.current = true;
        try {
          const source = await liveDraftSource();
          if (source === 'webm') await webmDraftTick();
          else if (source) await pcmDraftTick(source);
        } catch {
          // No preview this tick — silent by design (including aborts on stop).
        } finally {
          draftBusyRef.current = false;
        }
      }, DRAFT_INTERVAL_MS);
    } catch (err) {
      setMicOpening(false);
      stopStream();
      if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        setError('Microphone permission denied');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    }
  }, [stopStream, retireDraftLane]);

  const retryWithModel = useCallback(async (model?: string) => {
    const last = lastAudioRef.current;
    if (!last) return;

    setError(null);
    setIsTranscribing(true);
    try {
      // A clip this hook stored after its pass failed is re-run in place: the
      // same history row gets the text, and the audio is not uploaded again.
      const savedId = model ? null : await (savedRecordingRef.current ?? Promise.resolve(null));
      log.info('stt', `Retrying transcription${model ? ` with model: ${model}` : ' (configured engine)'}${savedId ? ` from stored recording ${savedId}` : ''}`);
      const result = savedId
        ? await retranscribeRecording(savedId, languageRef.current)
        : await transcribeAudio(last.base64, last.format, languageRef.current, model);

      if (isMountedRef.current && result.debugAudioPath) {
        setLastDebugPath(result.debugAudioPath);
      }

      if (result.text && isMountedRef.current) {
        // The words from before the failure may already be in the box. Swap
        // them for the complete text while they sit there untouched; otherwise
        // (sent, edited) add the complete text, because the user asked for it
        // and dropping it would lose the rest of the dictation a second time.
        const replaces = retryReplacesRef.current;
        retryReplacesRef.current = null;
        const swapped = replaces !== null && onRefineRef.current?.(result.text, replaces) === true;
        if (!swapped) onTranscribeRef.current(result.text);
        const preview = result.text.length > 50 ? result.text.slice(0, 50) + '...' : result.text;
        log.info('stt', `Retry transcribed: "${preview}" (${result.durationMs}ms, model=${model ?? 'configured'}, ${swapped ? 'replaced the partial text' : 'inserted'})`);
      } else if (!result.text && isMountedRef.current) {
        setError('Transcription came back empty — the audio is kept, you can retry.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('stt', `Retry failed: ${msg}`);
      if (isMountedRef.current) setError(sttFailureMessage(err));
    } finally {
      if (isMountedRef.current) setIsTranscribing(false);
    }
  }, []);

  const retryLast = useCallback(() => retryWithModel(undefined), [retryWithModel]);

  // The final words are handed to onTranscribe in the same batch that turns
  // recording/transcribing off, so once this render shows both off, the box
  // already holds them. The tick re-runs it for a waiter that arrived while the
  // state was already settling.
  useEffect(() => {
    if (isRecording || isTranscribing) return;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') return;
    const waiters = finishWaitersRef.current;
    if (waiters.length === 0) return;
    finishWaitersRef.current = [];
    for (const resolve of waiters) resolve({ error });
  }, [isRecording, isTranscribing, error, finishTick]);
  useEffect(() => () => {
    const waiters = finishWaitersRef.current;
    finishWaitersRef.current = [];
    for (const resolve of waiters) resolve({ error: DICTATION_CLOSED_ERROR });
  }, []);

  const isBusy = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    return (!!recorder && recorder.state !== 'inactive') || busyRenderedRef.current;
  }, []);

  const finishRecording = useCallback((): Promise<DictationOutcome> => {
    const recorder = mediaRecorderRef.current;
    const live = !!recorder && recorder.state !== 'inactive';
    if (!live && !busyRenderedRef.current) return Promise.resolve({ error: null });
    return new Promise<DictationOutcome>((resolve) => {
      finishWaitersRef.current.push(resolve);
      if (live) {
        // The same stop as the mic button's: the words are delivered, not dropped.
        setError(null);
        draftAbortRef.current?.abort();
        recorder.stop();
      }
      setFinishTick((t) => t + 1);
    });
  }, []);

  const discardRecording = useCallback(() => {
    // A send waiting on these words must not go: the box moved on without them.
    const waiters = finishWaitersRef.current;
    finishWaitersRef.current = [];
    for (const resolve of waiters) resolve({ error: DICTATION_DISCARDED_ERROR });
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    // The flag is read in onstop, which stop() triggers asynchronously.
    discardedRef.current = true;
    draftAbortRef.current?.abort();
    setVoiceStatus({ transcribing: false });
    recorder.stop();
  }, []);

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
    micLive,
    micOpening,
    silenceWarning,
    isDrafting,
    discardRecording,
    finishRecording,
    isBusy,
  };
}

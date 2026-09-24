/**
 * React hook for browser-based speech-to-text.
 *
 * Uses MediaRecorder to capture mic audio, then sends to the server
 * for transcription via the configured STT engine.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { transcribeAudio, draftTranscribe, saveRecording, warmupStt, isRetryableDraftFailure } from '@/api/stt';
import { setVoiceStatus } from '@/utils/voice-status';
import { decideStopAction } from '@/utils/stt-stop';
import { joinSegments } from '@/utils/stt-segments';
import { decideDraftTick } from '@/utils/stt-draft-window';
import { PcmCapture } from '@/utils/pcm-stream';
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
   * Called when the authoritative pass finishes AFTER a draft was already handed
   * over as the result, which happens when the user stops mid-sentence: the draft
   * goes in straight away so it is usable, and this refines it a moment later.
   *
   * `provisional` is the exact text that was delivered, so the consumer can tell
   * whether its text box still holds that untouched and skip the swap if the user
   * has since edited, sent, or dictated over it. Without this the hook waits for
   * the server before showing anything, which is the delay users notice most.
   */
  onRefine?: (finalText: string, provisional: string) => void;
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
  /** True while a live draft is being streamed into the consumer's text. */
  isDrafting: boolean;
  /**
   * Stop recording and throw the audio away without delivering any text. For when
   * the user has already acted on what they see (sending the message), so a
   * transcription landing afterwards would duplicate what they just sent.
   */
  discardRecording: () => void;
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
  // Text committed at silence gaps this recording — frozen, never re-transcribed.
  const confirmedRef = useRef('');
  // Absolute sample offset where the still-open draft window begins.
  const windowStartRef = useRef(0);
  // Absolute sample position covered by the newest delivered draft (PCM path's
  // equivalent of draftCoveredChunksRef).
  const draftCoveredSampleRef = useRef(0);
  // Commits whose text never reached confirmedRef: the slice was over the upload
  // cap, its transcribe failed, or the window had to be clamped forward past
  // audio nobody drafted. Counted only when the abandoned span actually held
  // SPEECH — dropping silence costs nothing. Non-zero means "committed segments
  // + tail would be missing words", which the stop path repairs with a
  // whole-clip pass.
  const skippedSegmentsRef = useRef(0);
  // The skip condition repeats every tick, so only the first one is logged in
  // full; the stop line reports the count.
  const draftSkipLoggedRef = useRef(false);
  // True once the draft lane has been retired for this recording.
  const draftRetiredRef = useRef(false);

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
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const onRefineRef = useRef(onRefine);
  onRefineRef.current = onRefine;
  // How many 1s chunks of audio the newest delivered draft was built from, and the
  // chunk during which speech was last heard. If the draft already covered every
  // chunk that had speech in it, the user finished talking before it ran, so the
  // authoritative pass has nothing left to add and is skipped entirely.
  const draftCoveredChunksRef = useRef(0);
  const lastVoiceChunkRef = useRef(0);
  // Set when the user acts on the text themselves (sends the message) while a
  // recording is live: stop, and deliver nothing.
  const discardedRef = useRef(false);
  // Last draft handed to the consumer this recording. If the final pass fails or
  // comes back empty we deliver this instead, so the user keeps the words they
  // watched appear (and the consumer's draft span gets released either way).
  const lastDraftRef = useRef<string | null>(null);
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

  /**
   * Final pass failed or came back empty, but the user already watched a draft
   * appear in their text box. Promote that draft to the final result rather than
   * yanking it away: the words are good enough to send or edit, the audio is
   * still in history for a Redo, and the consumer's draft span gets released.
   * Returns true when a draft was promoted (so the caller skips the error).
   */
  const keepLastDraft = useCallback((): boolean => {
    const draft = lastDraftRef.current;
    if (!draft) return false;
    lastDraftRef.current = null;
    log.warn('stt', 'final transcription unusable — keeping the live draft text');
    onTranscribeRef.current(draft);
    return true;
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
    // Detach (stop capturing) but keep the object: onstop still reads its
    // buffered samples for the tail pass. It is replaced on the next start.
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
    // be superseded, and on a busy engine it would otherwise delay the final
    // tail pass by a whole request.
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      draftAbortRef.current?.abort();
      mediaRecorderRef.current.stop();
      return;
    }

    // Start recording
    try {
      // Load the engine while the user talks, not in front of the first draft.
      warmupStt();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 16000 } },
      });
      streamRef.current = stream;

      // Set up Web Audio analyser for the live level meter + dead-mic warning.
      // Best-effort: if AudioContext is unavailable, recording still works (just no meter).
      sawAnyNonDeadRef.current = false;
      analyserAttachedRef.current = false;
      setSilenceWarning(null);
      pcmRef.current = null;
      confirmedRef.current = '';
      windowStartRef.current = 0;
      draftCoveredSampleRef.current = 0;
      skippedSegmentsRef.current = 0;
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

            // Speech (not just noise floor) → remember how far into the recording
            // we are, in chunks. chunksRef grows one entry per CHUNK_MS, so its
            // length is the current position; +1 because the chunk in progress has
            // not been pushed yet.
            if (rms > VOICE_RMS) {
              lastVoiceChunkRef.current = chunksRef.current.length + 1;
            }

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

        const totalChunks = chunksRef.current.length;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        chunksRef.current = [];

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
          if (isMountedRef.current) setHasLastRecording(true);
          return base64;
        };
        const persistHistory = (base64: string, finalText: string) => {
          saveRecording(base64, format, finalText, languageRef.current)
            .then((saved) => { if (isMountedRef.current) setLastDebugPath(saved.debugAudioPath); })
            .catch((e) => log.warn('stt', `recording history write failed: ${e instanceof Error ? e.message : String(e)}`));
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

        // How the stop is served depends on whether the user had finished talking.
        //
        // The newest draft covered some prefix of the audio, and we know where
        // speech was last heard (PCM samples when the side capture ran, 1s webm
        // chunks otherwise). If the draft already saw every moment that had
        // speech in it, the user stopped during silence, having watched their
        // words land: a final pass would re-transcribe just to arrive at the
        // same words, so skip it and keep the draft. Otherwise they stopped
        // mid-sentence: hand the draft over right away (usable immediately) and
        // refine it when the tail pass returns.
        //
        // Both need level data: without it we cannot tell a pause from speech,
        // so fall through to the plain wait-for-the-server behaviour.
        const pcm = pcmRef.current;
        const lastVoiceAt = pcm ? pcm.lastVoiceSample(VOICE_RMS) : lastVoiceChunkRef.current;
        const draftCovered = pcm ? draftCoveredSampleRef.current : draftCoveredChunksRef.current;
        const draft = lastDraftRef.current;
        const decided = decideStopAction({
          hasDraft: !!draft,
          knowsWhenSpeechEnded: (pcm ? true : analyserAttachedRef.current) && lastVoiceAt > 0,
          draftCoveredChunks: draftCovered,
          lastVoiceChunk: lastVoiceAt,
        });
        // A span of speech the draft loop had to abandon is missing from the
        // draft text, so the draft cannot BE the answer however cleanly the user
        // stopped: hand it over now (still usable) and let the authoritative pass
        // below replace it with the complete words.
        const action = decided === 'draft-is-final' && skippedSegmentsRef.current > 0
          ? 'draft-then-refine'
          : decided;
        let provisional: string | null = null;
        if (draft && action !== 'wait-for-server') {
          lastDraftRef.current = null;
          log.info('stt', `stop → ${action} (draft covered ${draftCovered}, last speech at ${lastVoiceAt}, ${totalChunks} chunks, ${skippedSegmentsRef.current} undrafted)`);
          if (isMountedRef.current) onTranscribeRef.current(draft);
          if (action === 'draft-is-final') {
            setVoiceStatus({ transcribing: false, lastFailed: false });
            void persistRecording(draft);
            return;
          }
          provisional = draft;
        }

        if (!isMountedRef.current) return;
        setIsTranscribing(true);
        setVoiceStatus({ transcribing: true });
        try {
          // Empty is the honest default: every path below either produces text or
          // leaves it empty, and empty is already handled (surface it, keep the
          // audio, keep the draft) rather than pretending a result exists.
          let finalText = '';
          let tookMs = 0;
          let via = '';

          if (pcm) {
            // Keep the clip for Retry BEFORE the tail pass, so a failed pass
            // still leaves the audio recoverable.
            const retryBase64 = await keepForRetry().catch(() => null);
            // The whole clip through the authoritative /transcribe lane. Slower,
            // and only used when the fast assembly below cannot produce the
            // user's actual words. Returns null when it is unavailable or fails,
            // so the caller always has the segment assembly to fall back on.
            const tryWholeClip = async (why: string): Promise<string | null> => {
              if (!retryBase64) return null;
              log.warn('stt', `stop → whole-clip pass: ${why}`);
              const t0 = Date.now();
              return transcribeAudio(retryBase64, format, languageRef.current)
                .then((r) => {
                  tookMs = Date.now() - t0;
                  if (isMountedRef.current && r.debugAudioPath) setLastDebugPath(r.debugAudioPath);
                  return r.text;
                })
                .catch((e) => {
                  log.warn('stt', `whole-clip pass failed (${e instanceof Error ? e.message : String(e)}) — falling back to committed segments`);
                  return null;
                });
            };

            // A span of SPEECH was abandoned by the draft loop (over the upload
            // cap, a failed commit, or a clamped window), so "committed segments
            // + open tail" would hand the user text with words missing in the
            // middle. Pay for the whole clip once instead: a slower stop, but
            // complete words. Only in this degraded case — the fast tail-only
            // assembly stays the normal path.
            let wholeClip: string | null = null;
            if (skippedSegmentsRef.current > 0) {
              wholeClip = await tryWholeClip(`${skippedSegmentsRef.current} segment(s) never got drafted, so committed text alone would be missing words`);
            }

            if (!wholeClip) {
              // Segment-committed recording: everything before windowStart is
              // already frozen text, so the final pass only transcribes the open
              // tail — this is what makes stopping fast regardless of clip length.
              const slice = pcm.sliceWavBase64(windowStartRef.current);
              // The tail obeys the SAME cap as a draft, because it posts to the
              // same route. An unbounded tail here would 413 exactly like the
              // runaway drafts did, and then the user would get only the draft.
              if (slice && slice.base64.length > DRAFT_MAX_BYTES) {
                wholeClip = await tryWholeClip(`open tail is ${slice.base64.length}B, past the ${DRAFT_MAX_BYTES}B cap the draft lane accepts`);
              }
              if (!wholeClip) {
                if (!slice) {
                  finalText = confirmedRef.current;
                } else {
                  const t0 = Date.now();
                  const { text: tail } = await draftTranscribe(slice.base64, 'wav', languageRef.current);
                  tookMs = Date.now() - t0;
                  finalText = joinSegments(confirmedRef.current, tail);
                }
                via = ', tail-only';
                if (retryBase64) persistHistory(retryBase64, finalText || provisional || '');
              }
            }
            if (wholeClip) {
              // /transcribe already stored this clip and its text server-side,
              // so writing history again here would duplicate the row.
              finalText = wholeClip;
              via = ', whole-clip repair';
            }
          } else {
            const base64 = await readBlobBase64();
            log.info('stt', `Sending ${(blob.size / 1024).toFixed(1)}KB ${format} for transcription`);
            lastAudioRef.current = { base64, format };
            if (isMountedRef.current) setHasLastRecording(true);
            const result = await transcribeAudio(base64, format, languageRef.current);
            if (isMountedRef.current && result.debugAudioPath) setLastDebugPath(result.debugAudioPath);
            finalText = result.text;
            tookMs = result.durationMs;
          }

          if (finalText) {
            setVoiceStatus({ transcribing: false, lastFailed: false });
            if (!isMountedRef.current) return;
            lastDraftRef.current = null; // superseded by the authoritative pass
            if (provisional !== null) {
              // The draft is already in the user's text box. Let the consumer swap
              // it only if it is still sitting there untouched; identical text is a
              // no-op it can skip. Falls back to a plain write when the consumer
              // does not implement refining.
              if (onRefineRef.current) onRefineRef.current(finalText, provisional);
              else if (finalText !== provisional) onTranscribeRef.current(finalText);
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
              // `provisional` means the draft was already delivered, so there is
              // nothing to recover and nothing to warn about — keep it.
              if (provisional === null && !keepLastDraft()) {
                setError('Transcription came back empty — the audio is kept, you can retry.');
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('stt', `Transcription failed: ${msg} — audio kept for retry`);
          setVoiceStatus({ transcribing: false, lastFailed: true });
          if (!isMountedRef.current) return;
          if (provisional === null && !keepLastDraft()) setError(msg);
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
      setIsRecording(true);
      setIsDrafting(false);
      lastDraftRef.current = null;
      draftCoveredChunksRef.current = 0;
      lastVoiceChunkRef.current = 0;
      discardedRef.current = false;
      if (!onDraftRef.current) return; // consumer takes final text only

      // Live draft: every couple of seconds transcribe what's been said so far
      // and hand it to the consumer, which writes it straight into its text box.
      // Best-effort — any failure just means no update this tick; the final
      // transcription on stop is untouched by this.
      const draftFormat = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'webm';
      draftBusyRef.current = false;

      // Records that [from, to) of the recording was abandoned by the draft
      // pipeline. Silence costs nothing; speech means the committed-segments
      // assembly is now incomplete, which the stop path has to make good.
      const noteAbandonedSpan = (pcm: PcmCapture, from: number, to: number, why: string) => {
        if (to <= from) return;
        const lostSpeech = pcm.hasVoiceBetween(from, to, VOICE_RMS);
        if (lostSpeech) skippedSegmentsRef.current++;
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
      const pcmDraftTick = async (pcm: PcmCapture) => {
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
                  draftCoveredSampleRef.current = slice.endSample;
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

      // Fallback when the PCM capture failed: re-transcribe the whole webm clip
      // every tick (webm chunks only decode from the start, so no slicing).
      const webmDraftTick = async () => {
        const chunks = chunksRef.current;
        if (chunks.length === 0) return;
        // Remember how much audio THIS draft is built from, before awaiting: the
        // stop path compares it against where speech last was to decide whether
        // the draft already says everything.
        const coveredChunks = chunks.length;
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
            draftCoveredChunksRef.current = coveredChunks;
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
          const pcm = pcmRef.current;
          if (pcm) await pcmDraftTick(pcm);
          else await webmDraftTick();
        } catch {
          // No preview this tick — silent by design (including aborts on stop).
        } finally {
          draftBusyRef.current = false;
        }
      }, DRAFT_INTERVAL_MS);
    } catch (err) {
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

  const discardRecording = useCallback(() => {
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
    silenceWarning,
    isDrafting,
    discardRecording,
  };
}

/**
 * Recording a video from the camera's live picture: the video itself, a still
 * every STILL_EVERY_MS (the ones that changed most go with it), and, with sound
 * on, a separate small sound-only recording that the speech-to-text route turns
 * into words. The microphone is open only while it records.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { log } from '@/utils/log';
import { DICTATION_AUDIO_CONSTRAINTS } from '@/utils/mic-constraints';
import { acquireMediaHold, type MediaHoldHandle } from '@/api/media-hold';
import {
  MAX_CLIP_MS, STILL_EVERY_MS, extensionFor, pickRecorderType, pickStills, signatureDiff, stillName,
} from './camera-model';
import { frameSignature, grabStill, stopStream } from './camera-frames';

export interface RecordedClip {
  file: File;
  durationMs: number;
  stills: File[];
  /** The sound-only recording, for its words; null with sound off or no microphone. */
  sound: Blob | null;
  soundType: string;
}

interface Sample { atMs: number; score: number; still: Promise<File | null> }

export interface ClipRecorder {
  recording: boolean;
  /** Asking for the microphone (the browser may be showing its prompt): Record waits. */
  starting: boolean;
  elapsedMs: number;
  /** Why the sound was left out of this recording ('' when it is in, or off by choice). */
  soundNote: string;
  start: (video: HTMLVideoElement, stream: MediaStream, opts: { sound: boolean; base: string }) => Promise<boolean>;
  /** Stop and hand over what was recorded (null when nothing was). */
  stop: () => Promise<RecordedClip | null>;
  /** Throw away a recording in progress. */
  cancel: () => void;
}

interface Running {
  recorder: MediaRecorder;
  chunks: Blob[];
  type: string;
  soundRecorder: MediaRecorder | null;
  soundChunks: Blob[];
  soundType: string;
  mic: MediaStream | null;
  /** The music stays off while the recording's microphone is open, as with voice input. */
  hold: MediaHoldHandle | null;
  startedAt: number;
  samples: Sample[];
  lastSig: Uint8Array | null;
  base: string;
  video: HTMLVideoElement;
  timer: ReturnType<typeof setInterval>;
}

function stopped(recorder: MediaRecorder | null): Promise<void> {
  if (!recorder || recorder.state === 'inactive') return Promise.resolve();
  return new Promise((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
    try { recorder.stop(); } catch { resolve(); }
  });
}

/** `onLimit`: the minute is up (the panel stops it into its preview). */
export function useClipRecorder(onLimit: () => void): ClipRecorder {
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  // A start in progress, and whether the panel is still there when its microphone
  // answers: a panel closed during the browser's prompt never records after it.
  const startingRef = useRef<{ cancelled: boolean } | null>(null);
  const alive = useRef(true);
  const [elapsedMs, setElapsed] = useState(0);
  const [soundNote, setSoundNote] = useState('');
  const run = useRef<Running | null>(null);
  const stopping = useRef<Running | null>(null);
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;

  const sample = (r: Running) => {
    const atMs = Math.round(performance.now() - r.startedAt);
    const sig = frameSignature(r.video);
    if (!sig) return;
    const score = r.lastSig ? signatureDiff(sig, r.lastSig) : 0;
    r.lastSig = sig;
    r.samples.push({ atMs, score, still: grabStill(r.video, stillName(r.base, atMs)) });
  };

  const start = useLeanCallback(async (video: HTMLVideoElement, stream: MediaStream, opts: { sound: boolean; base: string }) => {
    if (run.current || startingRef.current || typeof MediaRecorder === 'undefined') return false;
    const attempt = { cancelled: false };
    startingRef.current = attempt;
    setStarting(true);
    setSoundNote('');
    let mic: MediaStream | null = null;
    try {
      if (opts.sound) {
        try {
          mic = await navigator.mediaDevices.getUserMedia({ audio: DICTATION_AUDIO_CONSTRAINTS });
        } catch (err) {
          log.warn('camera', 'microphone not allowed for the recording', { name: (err as { name?: string })?.name ?? '' });
          setSoundNote('No sound: the microphone was not allowed');
        }
      }
    } finally {
      startingRef.current = null;
      if (alive.current) setStarting(false);
    }
    // Closed (or cancelled) while the browser asked: the microphone it gave goes off at once.
    if (attempt.cancelled || !alive.current || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      stopStream(mic);
      return false;
    }
    const tracks = [...stream.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])];
    const type = pickRecorderType('video', (t) => MediaRecorder.isTypeSupported(t));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 2_500_000 });
    } catch (err) {
      stopStream(mic);
      log.warn('camera', 'video recorder did not start', { error: String(err) });
      return false;
    }
    const soundType = mic ? pickRecorderType('audio', (t) => MediaRecorder.isTypeSupported(t)) : '';
    let soundRecorder: MediaRecorder | null = null;
    if (mic) {
      try { soundRecorder = new MediaRecorder(new MediaStream(mic.getAudioTracks()), soundType ? { mimeType: soundType } : undefined); } catch { soundRecorder = null; }
    }
    const r: Running = {
      recorder, chunks: [], type: recorder.mimeType || type || 'video/webm',
      soundRecorder, soundChunks: [], soundType: soundRecorder?.mimeType || soundType || 'audio/webm',
      mic, hold: mic ? acquireMediaHold('camera') : null, startedAt: performance.now(), samples: [], lastSig: null, base: opts.base, video,
      timer: setInterval(() => {
        const cur = run.current;
        if (!cur) return;
        const ms = performance.now() - cur.startedAt;
        setElapsed(ms);
        if (ms >= MAX_CLIP_MS) onLimitRef.current();
        else if (ms - (cur.samples.at(-1)?.atMs ?? -STILL_EVERY_MS) >= STILL_EVERY_MS) sample(cur);
      }, 250),
    };
    recorder.ondataavailable = (e) => { if (e.data.size > 0) r.chunks.push(e.data); };
    if (soundRecorder) soundRecorder.ondataavailable = (e) => { if (e.data.size > 0) r.soundChunks.push(e.data); };
    run.current = r;
    recorder.start(1000);
    soundRecorder?.start(1000);
    sample(r);
    setElapsed(0);
    setRecording(true);
    return true;
  }, []);

  const finish = useLeanCallback((r: Running) => {
    clearInterval(r.timer);
    stopStream(r.mic);
    r.hold?.release();
    run.current = null;
    setRecording(false);
  }, []);

  const stop = useLeanCallback(async (): Promise<RecordedClip | null> => {
    const r = run.current;
    // One stop per recording: the minute's end and a click on Stop can come together.
    if (!r || stopping.current === r) return null;
    stopping.current = r;
    const durationMs = Math.round(performance.now() - r.startedAt);
    // The last moment counts too: a line drawn just before Stop.
    sample(r);
    clearInterval(r.timer);
    await Promise.all([stopped(r.recorder), stopped(r.soundRecorder)]);
    finish(r);
    if (r.chunks.length === 0) return null;
    const type = r.type.split(';')[0] || 'video/webm';
    const file = new File(r.chunks, `${r.base}.${extensionFor(type, 'video')}`, { type, lastModified: Date.now() });
    const picked = pickStills(r.samples);
    const stills = (await Promise.all(picked.map((s) => s.still))).filter((f): f is File => !!f);
    const sound = r.soundChunks.length ? new Blob(r.soundChunks, { type: r.soundType.split(';')[0] }) : null;
    return { file, durationMs: Math.min(durationMs, MAX_CLIP_MS + 1000), stills, sound, soundType: r.soundType };
  }, [finish]);

  const cancel = useLeanCallback(() => {
    if (startingRef.current) startingRef.current.cancelled = true;
    const r = run.current;
    if (!r) return;
    try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch { /* ended */ }
    try { if (r.soundRecorder && r.soundRecorder.state !== 'inactive') r.soundRecorder.stop(); } catch { /* ended */ }
    finish(r);
  }, [finish]);

  // A panel that goes away never leaves the microphone or a recorder running,
  // nor one that would start when a microphone prompt it asked is answered later.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancel(); };
  }, [cancel]);

  return { recording, starting, elapsedMs, soundNote, start, stop, cancel };
}

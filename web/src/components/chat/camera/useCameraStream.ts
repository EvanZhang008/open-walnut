/**
 * The camera's live picture: opened when the panel opens, stopped (every track,
 * so the camera light goes off) when it closes, the page is hidden, or nothing
 * was done in the panel for IDLE_OFF_MS. Nothing here starts on its own: the
 * panel exists only after the person picked Camera in the + menu.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { log } from '@/utils/log';
import { IDLE_OFF_MS, cameraErrorKind, cameraVideoConstraints } from './camera-model';
import { stopStream } from './camera-frames';

export type StreamState = 'starting' | 'live' | 'off' | 'denied' | 'missing' | 'busy' | 'failed';
export type Facing = 'user' | 'environment';

/** A phone or tablet starts on the back camera (a board in front of you); a computer on its own camera. */
export function defaultFacing(): Facing {
  try { return window.matchMedia('(pointer: coarse)').matches ? 'environment' : 'user'; } catch { return 'user'; }
}

export interface CameraStream {
  state: StreamState;
  stream: MediaStream | null;
  facing: Facing;
  /** More than one camera to switch between. */
  canFlip: boolean;
  flip: () => void;
  /** Open it again (after a refusal the person fixed, or after it turned itself off). */
  restart: () => void;
  stop: () => void;
  /** Something was done in the panel: the idle clock starts over. */
  touch: () => void;
  /** Bind the live <video>. */
  videoRef: (el: HTMLVideoElement | null) => void;
  video: () => HTMLVideoElement | null;
}

/**
 * `active`: the panel wants the picture now (false while a recorded video waits to go in).
 * `onIdle`: the camera turned itself off with nothing captured (the panel closes).
 * `busy`: a recording runs; the idle clock never fires then.
 */
export function useCameraStream(active: boolean, opts: { busy: boolean; onIdle: () => void; onHidden: () => void }): CameraStream {
  const [state, setState] = useState<StreamState>('off');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facing, setFacing] = useState<Facing>(defaultFacing);
  const [canFlip, setCanFlip] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const lastTouch = useRef(Date.now());

  const attach = useLeanCallback((s: MediaStream | null) => {
    const el = videoEl.current;
    if (!el) return;
    if (el.srcObject !== s) el.srcObject = s;
    if (s) void el.play().catch(() => { /* a muted inline video plays; a refusal shows a still frame */ });
  }, []);

  const videoRef = useLeanCallback((el: HTMLVideoElement | null) => {
    videoEl.current = el;
    if (el) {
      el.muted = true;
      el.playsInline = true;
      attach(streamRef.current);
    }
  }, [attach]);

  const stop = useLeanCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    if (videoEl.current) videoEl.current.srcObject = null;
    setState((s) => (s === 'live' || s === 'starting' ? 'off' : s));
  }, []);

  useEffect(() => {
    if (!active) { stop(); return; }
    let cancelled = false;
    setState('starting');
    lastTouch.current = Date.now();
    navigator.mediaDevices.getUserMedia(cameraVideoConstraints(facing)).then((s) => {
      if (cancelled) { stopStream(s); return; }
      streamRef.current = s;
      setStream(s);
      setState('live');
      attach(s);
      // Labels and the count are known once the camera is allowed.
      void navigator.mediaDevices.enumerateDevices?.().then((all) => {
        if (!cancelled) setCanFlip(all.filter((d) => d.kind === 'videoinput').length > 1);
      }).catch(() => undefined);
    }, (err: unknown) => {
      if (cancelled) return;
      const kind = cameraErrorKind(err);
      log.warn('camera', 'camera did not start', { kind, name: (err as { name?: string })?.name ?? '' });
      setState(kind);
    });
    return () => {
      cancelled = true;
      stopStream(streamRef.current);
      streamRef.current = null;
      setStream(null);
    };
  }, [active, facing, attempt, attach, stop]);

  // A hidden page never keeps the camera: the panel decides what is kept (a recording stops into its preview).
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') optsRef.current.onHidden(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Two minutes with nothing done: off.
  useEffect(() => {
    if (state !== 'live') return;
    const timer = setInterval(() => {
      if (!optsRef.current.busy && Date.now() - lastTouch.current >= IDLE_OFF_MS) optsRef.current.onIdle();
    }, 5_000);
    return () => clearInterval(timer);
  }, [state]);

  return {
    state,
    stream,
    facing,
    canFlip,
    flip: () => { lastTouch.current = Date.now(); setFacing((f) => (f === 'user' ? 'environment' : 'user')); },
    restart: () => { lastTouch.current = Date.now(); setAttempt((n) => n + 1); },
    stop,
    touch: () => { lastTouch.current = Date.now(); },
    videoRef,
    video: () => videoEl.current,
  };
}

/**
 * The chat camera: a panel right above the chat
 * box, opened from the + menu. One box of one size holds every state (the live
 * picture, a recording, a video waiting to go in, a refusal), so the chat moves once, when it
 * opens. The box below keeps working: type or speak while the camera is on.
 *
 * What the person takes goes straight into the box's attachments (Evan,
 * 2026-11-22: "拍照了，它自动就可以自动要加到那里面"): a photo the moment the
 * shutter is pressed, while recording too, and a video once its words are in.
 * They upload to Walnut as any attachment does, and the box's own Send sends
 * them; its × on a chip takes one back. A video the box refused (its file limit)
 * stays here with "Add the video", so a minute's recording is never lost.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { transcribeAudio } from '@/api/stt';
import type { ClipInfo } from '@/components/common/composer-clip';
import { log } from '@/utils/log';
import { inMacApp } from '@/utils/mac-app';
import { usePageView } from '@/utils/view-memory';
import { addedLabel, captureBaseName, recordingLabel, sttFormatFor } from './camera-model';
import { blobToBase64, grabStill, recorderAvailable } from './camera-frames';
import { useCameraStream } from './useCameraStream';
import { useClipRecorder, type RecordedClip } from './useClipRecorder';
import { SegmentedControl } from '@/components/controls';
import './camera-dock.css';

const CAMERA_MODES = [{ value: 'photo', label: 'Photo' }, { value: 'video', label: 'Video' }] as const;

type Mode = 'photo' | 'video';
const isMode = (v: unknown): v is Mode => v === 'photo' || v === 'video';
type Words = { state: 'none' | 'pending' | 'done' | 'failed'; text: string; note?: string };
/** A recorded video not yet in the box: its words are coming, or the box refused it. */
type Held = { clip: RecordedClip; id: number; words: Words; notAdded?: boolean };

export interface CameraDockProps {
  onClose: () => void;
  /** A photo into the box's attachments; false when the box refused it (it says why). */
  onPhoto: (file: File) => Promise<boolean>;
  /** A recorded video into the box's attachments, false when refused (null: this box takes pictures only, so Video is not offered). */
  onClip: ((video: File, stills: File[], clip: Omit<ClipInfo, 'stills'>) => Promise<boolean>) | null;
  /** The box's own file picker, for "Pick a file instead". */
  onPickFile: () => void;
  /** The box's voice input is listening: the recording cannot take the microphone. */
  micBusy?: () => boolean;
  /** Tells the box the camera's recording holds the microphone (its mic button waits). */
  onMicHeld?: (held: boolean) => void;
}

const ICON = {
  close: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>,
  flip: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7h-3l-2-3H9L7 7H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1Z" /><path d="M9 13a3 3 0 0 0 5.2 2M15 12a3 3 0 0 0-5.2-2" /></svg>,
  mic: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  camOff: <svg width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="9" width="22" height="15" rx="3" /><circle cx="15" cy="16.5" r="4" /><path d="M11 9l2-3h4l2 3" /><path d="M4 4l22 22" className="camera-dock-slash" /></svg>,
};

export function CameraDock({ onClose, onPhoto, onClip, onPickFile, micBusy, onMicHeld }: CameraDockProps) {
  const videoOk = !!onClip && recorderAvailable();
  // Photo or Video is kept, as every view choice: the next open starts where the person left it.
  const [mode, setMode] = usePageView<Mode>('chat-camera', 'mode', 'photo', isMode);
  const [sound, setSound] = useState(true);
  const [held, setHeld] = useState<Held | null>(null);
  const [photosAdded, setPhotosAdded] = useState(0);
  const [videosAdded, setVideosAdded] = useState(0);
  const [flash, setFlash] = useState(0);
  const [finishing, setFinishing] = useState(false);
  // The box's voice input held the microphone when this recording started.
  const micTaken = useRef(false);
  const heldRef = useRef(held);
  heldRef.current = held;
  const nextId = useRef(0);
  const recorder = useClipRecorder(() => { void stopRecording(); });
  // The camera is off while a recorded video waits to go in (nothing to aim at then).
  const cam = useCameraStream(!held, {
    busy: recorder.recording,
    onIdle: () => closeDock(),
    onHidden: () => {
      if (recorder.recording) void stopRecording();
      else closeDock();
    },
  });

  /**
   * The panel closes (×, Esc, a hidden page, idle). A video still waiting for its
   * words goes in without them, so closing never loses it; only one the box
   * refused (it said why) is let go.
   */
  function closeDock() {
    const h = heldRef.current;
    if (h && !h.notAdded && onClip && adding.current !== h.id) {
      adding.current = h.id;
      void onClip(h.clip.file, h.clip.stills, {
        durationMs: h.clip.durationMs,
        narration: h.words.state === 'done' ? h.words.text : undefined,
        narrationNote: h.words.state === 'done' ? undefined : h.words.state === 'pending' ? 'words skipped' : h.words.note,
      });
    }
    onClose();
  }

  useEffect(() => { onMicHeld?.(recorder.recording && sound); }, [recorder.recording, sound, onMicHeld]);
  useEffect(() => () => { onMicHeld?.(false); }, [onMicHeld]);
  const setWords = (id: number, words: Words) => setHeld((h) => (h && h.id === id && h.words.state === 'pending' ? { ...h, words } : h));
  const transcribe = useLeanCallback(async (clip: RecordedClip, id: number) => {
    if (!clip.sound || clip.sound.size === 0) return;
    try {
      const base64 = await blobToBase64(clip.sound);
      const result = await transcribeAudio(base64, sttFormatFor(clip.soundType));
      const text = String((result as { text?: unknown }).text ?? '').trim();
      setWords(id, text ? { state: 'done', text } : { state: 'none', text: '', note: 'nothing was said' });
    } catch (err) {
      log.warn('camera', 'video words not transcribed', { error: String(err) });
      setWords(id, { state: 'failed', text: '', note: 'speech to text did not answer' });
    }
  }, []);

  // A held video goes into the box once its words are in (or skipped); one the box
  // refused waits for "Add the video".
  const adding = useRef<number | null>(null);
  const addHeld = useLeanCallback(async () => {
    const h = heldRef.current;
    if (!h || !onClip || h.words.state === 'pending' || adding.current === h.id) return;
    adding.current = h.id;
    try {
      const ok = await onClip(h.clip.file, h.clip.stills, {
        durationMs: h.clip.durationMs,
        narration: h.words.state === 'done' ? h.words.text : undefined,
        narrationNote: h.words.state === 'done' ? undefined : h.words.note,
      });
      if (ok) { setHeld((now) => (now?.id === h.id ? null : now)); setVideosAdded((n) => n + 1); }
      else setHeld((now) => (now?.id === h.id ? { ...now, notAdded: true } : now));
    } finally {
      adding.current = null;
    }
  }, [onClip]);
  const heldReady = !!held && held.words.state !== 'pending' && !held.notAdded;
  useEffect(() => { if (heldReady) void addHeld(); }, [heldReady, addHeld]);

  async function stopRecording() {
    if (!recorder.recording || finishing) return;
    setFinishing(true);
    try {
      const clip = await recorder.stop();
      if (!clip) return;
      const note = !sound ? 'sound off' : micTaken.current ? 'voice input had the microphone' : recorder.soundNote || 'no sound';
      const words: Words = clip.sound ? { state: 'pending', text: '' } : { state: 'none', text: '', note };
      const id = ++nextId.current;
      setHeld({ clip, id, words });
      void transcribe(clip, id);
    } finally {
      setFinishing(false);
    }
  }

  const shoot = async () => {
    const video = cam.video();
    if (!video) return;
    cam.touch();
    const file = await grabStill(video, `${captureBaseName(new Date())}.jpg`, 2576, 0.9);
    if (!file) return;
    setFlash((n) => n + 1);
    // Straight into the attachments, a recording goes on. Only a photo the box
    // took counts (at its limit it says why it did not).
    void onPhoto(file).then((ok) => { if (ok) setPhotosAdded((n) => n + 1); });
  };

  const startRecording = async () => {
    const video = cam.video();
    if (!video || !cam.stream) return;
    cam.touch();
    micTaken.current = sound && !!micBusy?.();
    await recorder.start(video, cam.stream, { sound: sound && !micTaken.current, base: captureBaseName(new Date()) });
  };

  // A held video's first still, shown while the camera is off (let go with it).
  const heldStill = held?.clip.stills[0];
  const [heldCover, setHeldCover] = useState<string | null>(null);
  useEffect(() => {
    if (!heldStill) { setHeldCover(null); return; }
    const url = URL.createObjectURL(heldStill);
    setHeldCover(url);
    return () => URL.revokeObjectURL(url);
  }, [heldStill]);

  const wordsPending = held?.words.state === 'pending';
  const skipWords = () => { if (held) setWords(held.id, { state: 'none', text: '', note: 'words skipped' }); };
  const added = addedLabel(photosAdded, videosAdded);

  const stateClass = recorder.recording ? ' is-recording' : '';
  const camBlocked = cam.state === 'denied' || cam.state === 'missing' || cam.state === 'busy' || cam.state === 'failed';

  return (
    <div className={`camera-dock${stateClass}`} data-testid="camera-dock" onPointerDown={cam.touch} onKeyDown={(e) => { if (e.key === 'Escape' && !recorder.recording) { e.stopPropagation(); closeDock(); } }}>
      <div className="camera-dock-view">
        {camBlocked ? (
          <div className="camera-dock-refused" role="alert" data-testid="camera-refused">
            {ICON.camOff}
            <b>{cam.state === 'denied' ? (inMacApp() ? 'macOS is not letting Walnut use the camera' : 'Walnut can’t use the camera')
              : cam.state === 'missing' ? 'No camera found' : cam.state === 'busy' ? 'The camera is in use by another app' : 'The camera did not start'}</b>
            <span>{cam.state === 'denied'
              ? (inMacApp() ? 'Open System Settings › Privacy & Security › Camera and turn on Walnut, then try again.'
                : 'Your browser blocked it. Allow the camera for this site (the camera icon or the site settings in the address bar), then try again.')
              : cam.state === 'busy' ? 'Close the other app that uses it, then try again.' : 'Connect a camera, then try again.'}</span>
            <div className="camera-dock-row">
              <button type="button" className="btn btn-sm btn-primary" onClick={cam.restart}>Try again</button>
              <button type="button" className="btn btn-sm" onClick={() => { closeDock(); onPickFile(); }}>Pick a file instead</button>
            </div>
          </div>
        ) : held && heldCover ? (
          // The camera is off while the video waits: its first still holds the place.
          <img className="camera-dock-media" src={heldCover} alt="The video you recorded" data-testid="camera-held-cover" />
        ) : (
          <video ref={cam.videoRef} className="camera-dock-media is-live" autoPlay muted playsInline controls={false} data-testid="camera-live" />
        )}
        {!camBlocked && (
          <div className="camera-dock-top">
            {recorder.recording ? (
              <span className="camera-hud is-rec" data-testid="camera-timer"><i className="camera-rec-dot" />{recordingLabel(recorder.elapsedMs)}</span>
            ) : held ? (
              <span className="camera-hud">Video</span>
            ) : (
              <span className="camera-hud" data-testid="camera-on"><i className="camera-live-dot" />{cam.state === 'live' ? 'Camera on' : 'Starting camera…'}</span>
            )}
            {(mode === 'video' || recorder.recording) && (
              <button type="button" className="btn btn-sm camera-sound" disabled={recorder.recording} onClick={() => setSound((s) => !s)} aria-pressed={sound} >
                {ICON.mic}{sound ? 'Sound on' : 'Sound off'}
              </button>
            )}
            {added && <span className="camera-hud" data-testid="camera-added">{added}</span>}
            <span className="camera-dock-spacer" />
            {cam.canFlip && !recorder.recording && <button type="button" className="camera-round" onClick={cam.flip} aria-label="Switch camera" title="Switch camera">{ICON.flip}</button>}
            {!recorder.recording && <button type="button" className="camera-round" onClick={closeDock} aria-label="Close camera" title="Close camera (Esc)">{ICON.close}</button>}
          </div>
        )}
        {flash > 0 && <span key={flash} className="camera-flash" aria-hidden="true" />}
        {recorder.recording && <span className="camera-progress" style={{ width: `${Math.min(100, (recorder.elapsedMs / 60_000) * 100)}%` }} />}
      </div>
      {!camBlocked && (
        <div className="camera-dock-bar">
          {held && (wordsPending || held.notAdded) ? (
            <div className="camera-dock-held" data-testid="camera-held">
              {wordsPending ? <>
                <span className="camera-dock-hint">Adding the video once its words are in…</span>
                <span className="camera-dock-spacer" />
                <button type="button" className="btn btn-sm" onClick={skipWords}>Skip the words</button>
              </> : <>
                <span className="camera-dock-hint">The video is not in the message yet</span>
                <span className="camera-dock-spacer" />
                <button type="button" className="btn btn-sm" onClick={() => setHeld(null)}>Discard it</button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => { setHeld((h) => (h ? { ...h, notAdded: false } : h)); }}>Add the video</button>
              </>}
            </div>
          ) : (
            <>
              {videoOk && (
                <SegmentedControl
                  className="camera-seg wn-on-dark"
                  aria-label="Camera mode"
                  value={mode}
                  options={CAMERA_MODES}
                  disabled={recorder.recording || recorder.starting}
                  onChange={setMode}
                />
              )}
              <span className="camera-dock-spacer" />
              {mode === 'photo' || !videoOk ? (
                <button type="button" className="camera-shutter" onClick={() => void shoot()} disabled={cam.state !== 'live'} aria-label="Take photo" data-testid="camera-shutter" />
              ) : recorder.recording ? (
                <button type="button" className="camera-shutter is-stop" onClick={() => void stopRecording()} disabled={finishing} aria-label="Stop recording" data-testid="camera-stop" />
              ) : (
                <button type="button" className="camera-shutter is-video" onClick={() => void startRecording()} disabled={cam.state !== 'live' || recorder.starting || !!held} aria-label="Start recording" data-testid="camera-record" />
              )}
              <span className="camera-dock-spacer" />
              <span className="camera-dock-side">
                {recorder.recording
                  ? <button type="button" className="btn btn-sm" onClick={() => void shoot()} data-testid="camera-photo-while-recording">Take photo</button>
                  : mode === 'video' && videoOk ? <span className="camera-dock-hint">up to 1:00</span> : null}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

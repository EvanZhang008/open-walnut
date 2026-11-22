/**
 * The chat camera: a panel right above the chat
 * box, opened from the + menu. One box of one size holds every state (the live
 * picture, a recording, the preview, a refusal), so the chat moves once, when it
 * opens. The box below keeps working: type or speak while the camera is on.
 *
 * Nothing leaves the page before the person acts: "Add another" puts the capture
 * in the box's attachments (they upload to Walnut, as any attachment does) and
 * "Send" sends it with the box's words. A photo taken while recording goes to
 * the attachments at once and the recording goes on.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { transcribeAudio } from '@/api/stt';
import type { ClipInfo } from '@/components/common/composer-clip';
import { log } from '@/utils/log';
import { inMacApp } from '@/utils/mac-app';
import { usePageView } from '@/utils/view-memory';
import { captureBaseName, recordingLabel, sttFormatFor } from './camera-model';
import { blobToBase64, grabStill, recorderAvailable } from './camera-frames';
import { useCameraStream } from './useCameraStream';
import { useClipRecorder, type RecordedClip } from './useClipRecorder';
import { SegmentedControl } from '@/components/controls';
import './camera-dock.css';

const CAMERA_MODES = [{ value: 'photo', label: 'Photo' }, { value: 'video', label: 'Video' }] as const;

type Mode = 'photo' | 'video';
const isMode = (v: unknown): v is Mode => v === 'photo' || v === 'video';
type Words = { state: 'none' | 'pending' | 'done' | 'failed'; text: string; note?: string };
type Capture =
  | { kind: 'photo'; file: File; url: string }
  | { kind: 'video'; clip: RecordedClip; url: string; poster?: string; words: Words };

export interface CameraDockProps {
  onClose: () => void;
  /** A photo into the box's attachments; false when the box refused it (it says why). */
  onPhoto: (file: File) => Promise<boolean>;
  /** A recorded video into the box's attachments, false when refused (null: this box takes pictures only, so Video is not offered). */
  onClip: ((video: File, stills: File[], clip: Omit<ClipInfo, 'stills'>) => Promise<boolean>) | null;
  /** Send the box's message (after the capture was added). */
  onSend: () => void;
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

export function CameraDock({ onClose, onPhoto, onClip, onSend, onPickFile, micBusy, onMicHeld }: CameraDockProps) {
  const videoOk = !!onClip && recorderAvailable();
  // Photo or Video is kept, as every view choice: the next open starts where the person left it.
  const [mode, setMode] = usePageView<Mode>('chat-camera', 'mode', 'photo', isMode);
  const [sound, setSound] = useState(true);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [photosTaken, setPhotosTaken] = useState(0);
  const [flash, setFlash] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [keeping, setKeeping] = useState(false);
  // The box's voice input held the microphone when this recording started.
  const micTaken = useRef(false);
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const recorder = useClipRecorder(() => { void stopRecording(); });
  const cam = useCameraStream(!capture, {
    busy: recorder.recording,
    onIdle: () => { if (!captureRef.current) onClose(); },
    onHidden: () => {
      if (recorder.recording) void stopRecording();
      else if (!captureRef.current) onClose();
    },
  });

  useEffect(() => { onMicHeld?.(recorder.recording && sound); }, [recorder.recording, sound, onMicHeld]);
  useEffect(() => () => { onMicHeld?.(false); }, [onMicHeld]);
  // A preview's object URL is let go with it (not when its words arrive: the same capture, the same URL).
  const captureUrl = capture?.url;
  const posterUrl = capture?.kind === 'video' ? capture.poster : undefined;
  useEffect(() => () => { if (captureUrl) URL.revokeObjectURL(captureUrl); if (posterUrl) URL.revokeObjectURL(posterUrl); }, [captureUrl, posterUrl]);

  const transcribe = useLeanCallback(async (clip: RecordedClip, url: string) => {
    if (!clip.sound || clip.sound.size === 0) return;
    try {
      const base64 = await blobToBase64(clip.sound);
      const result = await transcribeAudio(base64, sttFormatFor(clip.soundType));
      const text = String((result as { text?: unknown }).text ?? '').trim();
      setCapture((c) => (c && c.url === url && c.kind === 'video'
        ? { ...c, words: text ? { state: 'done', text } : { state: 'none', text: '', note: 'nothing was said' } } : c));
    } catch (err) {
      log.warn('camera', 'video words not transcribed', { error: String(err) });
      setCapture((c) => (c && c.url === url && c.kind === 'video'
        ? { ...c, words: { state: 'failed', text: '', note: 'speech to text did not answer' } } : c));
    }
  }, []);

  async function stopRecording() {
    if (!recorder.recording || finishing) return;
    setFinishing(true);
    try {
      const clip = await recorder.stop();
      if (!clip) return;
      const url = URL.createObjectURL(clip.file);
      const note = !sound ? 'sound off' : micTaken.current ? 'voice input had the microphone' : recorder.soundNote || 'no sound';
      const words: Words = clip.sound ? { state: 'pending', text: '' } : { state: 'none', text: '', note };
      // Its first still is its cover: a recorded video shows no frame before it plays.
      const poster = clip.stills[0] ? URL.createObjectURL(clip.stills[0]) : undefined;
      setCapture({ kind: 'video', clip, url, poster, words });
      void transcribe(clip, url);
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
    if (recorder.recording) {
      // While it records: straight into the attachments, the recording goes on.
      // Only a photo the box took counts (at its limit it says why it did not).
      void onPhoto(file).then((ok) => { if (ok) setPhotosTaken((n) => n + 1); });
      return;
    }
    setCapture({ kind: 'photo', file, url: URL.createObjectURL(file) });
  };

  const startRecording = async () => {
    const video = cam.video();
    if (!video || !cam.stream) return;
    cam.touch();
    setPhotosTaken(0);
    micTaken.current = sound && !!micBusy?.();
    await recorder.start(video, cam.stream, { sound: sound && !micTaken.current, base: captureBaseName(new Date()) });
  };

  /**
   * The capture into the box: true once it is in. A capture the box refused (its
   * file limit) stays in the preview, so a minute's video is never lost to it.
   */
  const keep = async (): Promise<boolean> => {
    const c = captureRef.current;
    if (!c || keeping) return false;
    setKeeping(true);
    try {
      const ok = c.kind === 'photo'
        ? await onPhoto(c.file)
        : !!onClip && await onClip(c.clip.file, c.clip.stills, {
          durationMs: c.clip.durationMs,
          narration: c.words.state === 'done' ? c.words.text : undefined,
          narrationNote: c.words.state === 'done' ? undefined : c.words.note,
        });
      if (ok) setCapture((now) => (now === c ? null : now));
      return ok;
    } finally {
      setKeeping(false);
    }
  };

  const wordsPending = capture?.kind === 'video' && capture.words.state === 'pending';
  const skipWords = () => setCapture((c) => (c && c.kind === 'video' ? { ...c, words: { state: 'none', text: '', note: 'words skipped' } } : c));

  const stateClass = recorder.recording ? ' is-recording' : capture ? ' is-preview' : '';
  const refused = !capture && (cam.state === 'denied' || cam.state === 'missing' || cam.state === 'busy' || cam.state === 'failed');

  return (
    <div className={`camera-dock${stateClass}`} data-testid="camera-dock" onPointerDown={cam.touch} onKeyDown={(e) => { if (e.key === 'Escape' && !recorder.recording) { e.stopPropagation(); onClose(); } }}>
      <div className="camera-dock-view">
        {refused ? (
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
              <button type="button" className="btn btn-sm" onClick={() => { onClose(); onPickFile(); }}>Pick a file instead</button>
            </div>
          </div>
        ) : capture ? (
          capture.kind === 'photo'
            ? <img className="camera-dock-media" src={capture.url} alt="The photo you took" data-testid="camera-preview-photo" />
            : <video className="camera-dock-media" src={capture.url} poster={capture.poster} controls playsInline muted data-testid="camera-preview-video" />
        ) : (
          <video ref={cam.videoRef} className="camera-dock-media is-live" autoPlay muted playsInline controls={false} data-testid="camera-live" />
        )}
        {!refused && (
          <div className="camera-dock-top">
            {recorder.recording ? (
              <span className="camera-hud is-rec" data-testid="camera-timer"><i className="camera-rec-dot" />{recordingLabel(recorder.elapsedMs)}</span>
            ) : capture ? (
              <span className="camera-hud">{capture.kind === 'photo' ? 'Photo' : capture.words.state === 'pending' ? 'Video · getting the words…' : `Video · ${capture.clip.stills.length} stills`}</span>
            ) : (
              <span className="camera-hud" data-testid="camera-on"><i className="camera-live-dot" />{cam.state === 'live' ? 'Camera on' : 'Starting camera…'}</span>
            )}
            {(mode === 'video' || recorder.recording) && !capture && (
              <button type="button" className="btn btn-sm camera-sound" disabled={recorder.recording} onClick={() => setSound((s) => !s)} aria-pressed={sound} >
                {ICON.mic}{sound ? 'Sound on' : 'Sound off'}
              </button>
            )}
            {photosTaken > 0 && recorder.recording && <span className="camera-hud" data-testid="camera-photos-taken">{photosTaken === 1 ? '1 photo added' : `${photosTaken} photos added`}</span>}
            <span className="camera-dock-spacer" />
            {cam.canFlip && !capture && !recorder.recording && <button type="button" className="camera-round" onClick={cam.flip} aria-label="Switch camera" title="Switch camera">{ICON.flip}</button>}
            {!recorder.recording && <button type="button" className="camera-round" onClick={onClose} aria-label="Close camera" title="Close camera (Esc)">{ICON.close}</button>}
          </div>
        )}
        {flash > 0 && <span key={flash} className="camera-flash" aria-hidden="true" />}
        {recorder.recording && <span className="camera-progress" style={{ width: `${Math.min(100, (recorder.elapsedMs / 60_000) * 100)}%` }} />}
      </div>
      {!refused && (
        <div className="camera-dock-bar">
          {capture ? (
            <>
              <button type="button" className="btn btn-sm" onClick={() => setCapture(null)}>Retake</button>
              <span className="camera-dock-spacer" />
              {wordsPending && <button type="button" className="btn btn-sm" onClick={skipWords}>Skip the words</button>}
              <button type="button" className="btn btn-sm" disabled={wordsPending || keeping} onClick={() => { void keep(); }}>Add another</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={wordsPending || keeping} onClick={() => { void keep().then((ok) => { if (ok) { onClose(); onSend(); } }); }}>{wordsPending ? 'Getting the words…' : 'Send'}</button>
            </>
          ) : (
            <>
              {videoOk && (
                <SegmentedControl
                  className="camera-seg"
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
                <button type="button" className="camera-shutter is-video" onClick={() => void startRecording()} disabled={cam.state !== 'live' || recorder.starting} aria-label="Start recording" data-testid="camera-record" />
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

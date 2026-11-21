/**
 * The chat box's Camera (on for everyone since 2026-11-21; it was the `camera_capture` experiment): its row
 * in the + menu, its panel above the box, and, where this page may not open
 * the camera itself (a phone on plain http), the phone's own camera app through
 * a file input with `capture`. ChatInput holds one of these and stays unaware of
 * what the camera does.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { ComposerAttachments } from '@/components/common/composer-attachments';
import { CameraDock } from './CameraDock';
import { liveCameraAvailable, stillsFromVideoFile } from './camera-frames';
import { captureBaseName } from './camera-model';

interface Deps {
  /** A light box (an answer card) has no + menu, so no camera. */
  light: boolean;
  /** The box takes files: a video can go (its file and stills live on the session's host). */
  acceptsFiles: boolean;
  attachments: Pick<ComposerAttachments, 'addClip'>;
  /** Into the box's attachments; answers why it refused some (null: all are in). */
  processFiles: (files: File[]) => Promise<string | null>;
  /** The box moved to another draft or session: the camera closes (a recording is dropped), so nothing lands in the other one. */
  resetKey: string;
  setNotice: (notice: string | null) => void;
  send: () => void;
  pickFile: () => void;
  micBusy: () => boolean;
  closeMenu: () => void;
  focusBox: () => void;
}

export interface ComposerCameraState extends Deps {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  micHeld: boolean;
  setMicHeld: (held: boolean) => void;
  captureRef: React.RefObject<HTMLInputElement | null>;
  live: boolean;
}

export function useComposerCamera(deps: Deps): ComposerCameraState {
  const enabled = !deps.light;
  const [open, setOpen] = useState(false);
  const [micHeld, setMicHeld] = useState(false);
  const captureRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { setOpen(false); }, [deps.resetKey]);
  return { ...deps, enabled, open: open && enabled, setOpen, micHeld, setMicHeld, captureRef, live: liveCameraAvailable() };
}

const CAMERA_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 7h-3l-2-3H9L7 7H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1Z" /><circle cx="12" cy="13" r="3.5" />
  </svg>
);

/** The + menu's Camera row, right under the attach row. */
export function CameraMenuRow({ camera, disabled }: { camera: ComposerCameraState; disabled: boolean }) {
  if (!camera.enabled) return null;
  const hint = camera.live ? (camera.acceptsFiles ? 'Photo or video' : 'Photo') : 'Opens the phone camera';
  return (
    <button
      className="chat-plus-menu-item"
      type="button"
      role="menuitem"
      disabled={disabled}
      data-testid="plus-menu-camera"
      title={camera.live ? 'Take a photo or record a video to send' : 'This page cannot open the camera itself (it is not on https): your phone\'s camera app opens instead'}
      onClick={() => {
        camera.closeMenu();
        if (camera.live) camera.setOpen(true);
        else camera.captureRef.current?.click();
      }}
    >
      {CAMERA_ICON}
      <span>Camera</span>
      <span className="chat-plus-menu-hint" style={{ color: 'var(--fg-muted)' }}>{hint}</span>
    </button>
  );
}

/** The panel above the box, and the hidden input the phone's camera app answers. */
export function ComposerCamera({ camera }: { camera: ComposerCameraState }) {
  const { attachments, processFiles, setNotice, acceptsFiles } = camera;
  const addClip = useLeanCallback((video: File, stills: File[], clip: Parameters<ComposerAttachments['addClip']>[2]) => (
    attachments.addClip(video, stills, clip).then((notice) => { if (notice) setNotice(notice); return !notice; })
  ), [attachments, setNotice]);
  // processFiles shows its own notice.
  const addPhoto = useLeanCallback((file: File) => processFiles([file]).then((notice) => !notice), [processFiles]);

  const onCaptured = async () => {
    const input = camera.captureRef.current;
    const file = input?.files?.[0];
    if (input) input.value = '';
    if (!file) return;
    if (!file.type.startsWith('video/')) { void processFiles([file]); return; }
    if (!acceptsFiles) { setNotice('This box takes pictures only: send the video from a session'); return; }
    const base = captureBaseName(new Date());
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const named = new File([file], `${base}.${ext}`, { type: file.type, lastModified: file.lastModified });
    const taken = await stillsFromVideoFile(named, base);
    await addClip(named, taken?.stills ?? [], {
      durationMs: taken?.durationMs ?? 0,
      narrationNote: 'no words from the phone camera',
    });
  };

  if (!camera.enabled) return null;
  return (
    <>
      {camera.open && (
        <CameraDock
          onClose={() => { camera.setOpen(false); camera.focusBox(); }}
          onPhoto={addPhoto}
          onClip={acceptsFiles ? addClip : null}
          onSend={camera.send}
          onPickFile={camera.pickFile}
          micBusy={camera.micBusy}
          onMicHeld={camera.setMicHeld}
        />
      )}
      <input
        ref={camera.captureRef}
        type="file"
        accept={acceptsFiles ? 'image/*,video/*' : 'image/*'}
        capture="environment"
        style={{ display: 'none' }}
        data-testid="camera-capture-input"
        onChange={() => { void onCaptured(); }}
      />
    </>
  );
}

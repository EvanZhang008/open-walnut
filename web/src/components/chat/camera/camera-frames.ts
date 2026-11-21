/**
 * Pictures from the camera's live <video>: a still as a JPEG file, and the small
 * grey signature two moments are compared by (camera-model.ts pickStills).
 * Canvas is the one way every engine takes a frame (ImageCapture is not in
 * Safari before 26).
 */
import {
  MAX_CLIP_MS, SIGNATURE_H, SIGNATURE_W, STILL_EVERY_MS, STILL_LONG_EDGE, fitLongEdge, greySignature, pickStills, signatureDiff, stillName,
} from './camera-model';

/** The video's current frame as a JPEG, its long edge at most `edge`; null before the first frame. */
export function grabStill(video: HTMLVideoElement, name: string, edge = STILL_LONG_EDGE, quality = 0.86): Promise<File | null> {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight || video.readyState < 2) return Promise.resolve(null);
  const size = fitLongEdge(videoWidth, videoHeight, edge);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, size.width, size.height);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }) : null), 'image/jpeg', quality);
  });
}

let sigCanvas: HTMLCanvasElement | null = null;

/** The frame as SIGNATURE_W x SIGNATURE_H grey bytes, or null before the first frame. */
export function frameSignature(video: HTMLVideoElement): Uint8Array | null {
  if (!video.videoWidth || video.readyState < 2) return null;
  sigCanvas ??= document.createElement('canvas');
  sigCanvas.width = SIGNATURE_W;
  sigCanvas.height = SIGNATURE_H;
  const ctx = sigCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, SIGNATURE_W, SIGNATURE_H);
  return greySignature(ctx.getImageData(0, 0, SIGNATURE_W, SIGNATURE_H).data);
}

/** A blob's bytes as base64 (the speech-to-text route takes JSON). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the recording'));
    reader.readAsDataURL(blob);
  });
}

/** Whether this page may open the camera itself (a secure origin with getUserMedia and a recorder). */
export function liveCameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window !== 'undefined' && window.isSecureContext !== false;
}

export function recorderAvailable(): boolean {
  return typeof MediaRecorder !== 'undefined';
}

/** Stop every track of a stream (the camera light goes off). */
export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* already ended */ }
  }
}

/**
 * Stills of a video file the phone's own camera app recorded (a page on plain
 * http cannot open the camera itself): the file is played to each sample time
 * in turn and the same rule picks the stills. Null when the browser cannot play it.
 */
export async function stillsFromVideoFile(file: File, base: string): Promise<{ durationMs: number; stills: File[] } | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  const once = (event: string, ms = 8000) => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    video.addEventListener(event, () => { clearTimeout(timer); resolve(true); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); resolve(false); }, { once: true });
  });
  try {
    if (!(await once('loadeddata'))) return null;
    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    const samples: Array<{ atMs: number; score: number; still: Promise<File | null> }> = [];
    let last: Uint8Array | null = null;
    for (let at = 0; at <= Math.min(durationMs, MAX_CLIP_MS * 3); at += STILL_EVERY_MS) {
      video.currentTime = at / 1000;
      if (!(await once('seeked'))) break;
      const sig = frameSignature(video);
      if (!sig) continue;
      samples.push({ atMs: at, score: last ? signatureDiff(sig, last) : 0, still: grabStill(video, stillName(base, at)) });
      last = sig;
    }
    const stills = (await Promise.all(pickStills(samples).map((s) => s.still))).filter((f): f is File => !!f);
    return { durationMs, stills };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

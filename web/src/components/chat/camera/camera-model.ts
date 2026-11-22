/**
 * The chat camera's pure rules (no React, no DOM): which stills of a recorded
 * video go to the AI, what each capture is named, which recorder format a
 * browser takes. The iOS app follows the same rules
 * (ios-native: the camera's stills picker), so a video reads the same from both.
 *
 * Claude reads pictures, not video: a recorded video goes as its file, a few
 * stills taken while it was recorded, and what was said in it
 * (lib/attachment-headers.ts `videoClipBlocks`).
 */

/** A video stops by itself after a minute; the timer counts down from 50 s. */
export const MAX_CLIP_MS = 60_000;
export const CLIP_COUNTDOWN_FROM_MS = 50_000;
/** A still is sampled this often while recording. */
export const STILL_EVERY_MS = 2_000;
/** At most this many stills go with one video. */
export const MAX_STILLS = 8;
/**
 * A sample that changed less than this share of its picture (percent of the
 * signature's cells) from the one before shows nothing new. A new box or line on
 * a board is a small part of the frame (a mean over the whole picture missed it:
 * 2026-11-20, a drawn diagram kept one still), so the score counts changed cells.
 */
export const MIN_STILL_CHANGE = 0.5;
/** A cell changed when its grey moved more than this (a camera's own noise stays under it). */
export const CELL_CHANGE = 16;
/** Stills and photos keep at most this long edge (the size the model reads at). */
export const STILL_LONG_EDGE = 1568;
/** The camera turns itself off after this long with nothing done in its panel. */
export const IDLE_OFF_MS = 120_000;
/** The size of the grey thumbnail two samples are compared by. */
export const SIGNATURE_W = 64;
export const SIGNATURE_H = 36;

export interface StillSample {
  /** Milliseconds from the start of the recording. */
  atMs: number;
  /** Its difference from the sample before it (the first one's is ignored). */
  score: number;
}

/**
 * The samples to send: the first always, then the ones that changed most from
 * the sample before them (a new line on the board, the camera turned), at most
 * `max` in all, in time order. A board that never changed sends one still.
 */
export function pickStills<T extends StillSample>(samples: readonly T[], max = MAX_STILLS): T[] {
  if (samples.length === 0 || max <= 0) return [];
  const [first, ...rest] = samples;
  const changed = rest
    .filter((s) => s.score >= MIN_STILL_CHANGE)
    .sort((a, b) => b.score - a.score || a.atMs - b.atMs)
    .slice(0, max - 1);
  return [first, ...changed].sort((a, b) => a.atMs - b.atMs);
}

/** The share (percent, 0 to 100) of two grey signatures' cells that changed by more than CELL_CHANGE. */
export function signatureDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > CELL_CHANGE) changed++;
  return (changed / n) * 100;
}

/** RGBA pixels to one grey byte each (Rec. 601 weights). */
export function greySignature(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(Math.floor(rgba.length / 4));
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = Math.round(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]);
  }
  return out;
}

/** A capture's base name from when it was taken: "camera-1416" (hours and minutes, local time). */
export function captureBaseName(at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const ss = String(at.getSeconds()).padStart(2, '0');
  return `camera-${hh}${mm}${ss}`;
}

/** "camera-141605-still-0m06s.jpg": the time in the video is in the name, the header says so. */
export function stillName(base: string, atMs: number): string {
  const total = Math.max(0, Math.round(atMs / 1000));
  return `${base}-still-${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s.jpg`;
}

/** The recorder formats tried, best first: Safari records mp4, Chrome webm (and mp4 since 126). */
const VIDEO_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

/** The first format this browser can record, '' to let it pick (a recorder that supports none of them). */
export function pickRecorderType(kind: 'video' | 'audio', supported: (type: string) => boolean): string {
  for (const type of kind === 'video' ? VIDEO_TYPES : AUDIO_TYPES) {
    try { if (supported(type)) return type; } catch { /* a browser that throws on a type */ }
  }
  return '';
}

/** The file extension for a recorded type ("video/webm;codecs=vp9" → "webm"). */
export function extensionFor(type: string, kind: 'video' | 'audio'): string {
  const base = type.split(';')[0].trim().toLowerCase();
  if (base.endsWith('/mp4')) return kind === 'audio' ? 'm4a' : 'mp4';
  if (base.endsWith('/ogg')) return 'ogg';
  if (base.endsWith('/quicktime')) return 'mov';
  return 'webm';
}

/** The speech-to-text route's name for an audio recording's format. */
export function sttFormatFor(type: string): 'webm' | 'mp4' | 'ogg' {
  const base = type.split(';')[0].trim().toLowerCase();
  if (base.endsWith('/mp4') || base.endsWith('/quicktime')) return 'mp4';
  if (base.endsWith('/ogg')) return 'ogg';
  return 'webm';
}

/**
 * The camera's own request: the picture only (`audio: false`). Sound is asked
 * for apart, only while a video records, with the dictation constraints
 * (utils/mic-constraints.ts: echo cancellation off, or a Mac's mic stalls).
 */
export function cameraVideoConstraints(facing: 'user' | 'environment'): MediaStreamConstraints {
  return { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
}

/** A width and height scaled down so the long edge is at most `edge` (never up). */
export function fitLongEdge(width: number, height: number, edge = STILL_LONG_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= edge || long === 0) return { width, height };
  const k = edge / long;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

/** The recording timer: "0:23", and "0:07 left" once the countdown starts. */
export function recordingLabel(elapsedMs: number): string {
  const clock = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  if (elapsedMs >= CLIP_COUNTDOWN_FROM_MS) return `${clock(Math.ceil((MAX_CLIP_MS - elapsedMs) / 1000) * 1000)} left`;
  return clock(elapsedMs);
}

/** What a camera that could not start says, by the browser's error name. */
export function cameraErrorKind(err: unknown): 'denied' | 'missing' | 'busy' | 'failed' {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'failed';
}

/** What this panel put in the message: "2 photos added", "1 photo and 1 video added". */
export function addedLabel(photos: number, videos: number): string | null {
  const parts = [photos && (photos === 1 ? '1 photo' : `${photos} photos`), videos && (videos === 1 ? '1 video' : `${videos} videos`)].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} added` : null;
}

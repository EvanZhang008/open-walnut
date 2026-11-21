/**
 * A video recorded with the chat's camera, as a composer attachment: the video
 * is an ordinary file, and its stills (pictures the AI can read) go up to the
 * same host after it. The send names the video in the files block, then its
 * stills and what was said in it (lib/attachment-headers.ts videoClipBlocks).
 */
import { attachmentHeaderBlock, clipClock, videoClipBlocks } from '@open-walnut/attachment-headers';
import { newUploadId, safeUploadName, uploadFile, type UploadTarget } from '@/api/file-upload';

export interface ClipInfo {
  durationMs: number;
  /** Each still by name, with its saved path once uploaded. */
  stills: Array<{ name: string; path?: string }>;
  /** What was said in it, one line ('' or absent: nothing was said, or the sound was off). */
  narration?: string;
  /** Why it has no words, said on its card ("Speech to text is not set up"). */
  narrationNote?: string;
}

/**
 * Upload a video's stills one after another to the video's host; answers their
 * saved paths. `have` keeps the paths of the ones already up (by index), so a
 * retry after one failed sends only the rest; `onBytes` counts the bytes sent.
 */
export async function uploadClipStills(
  stills: readonly File[],
  target: UploadTarget,
  opts: { signal: AbortSignal; onWaiting?: (reason: string | null) => void; have: string[]; onBytes?: (sent: number) => void },
): Promise<ClipInfo['stills']> {
  const out: ClipInfo['stills'] = [];
  let before = 0;
  for (const [i, still] of stills.entries()) {
    const name = safeUploadName(still.name);
    if (!opts.have[i]) {
      const at = before;
      opts.have[i] = await uploadFile(still, target, {
        uploadId: newUploadId(), name, signal: opts.signal, onWaiting: opts.onWaiting,
        onProgress: (sent) => opts.onBytes?.(at + sent),
      });
    }
    before += still.size;
    opts.onBytes?.(before);
    out.push({ name, path: opts.have[i] });
  }
  return out;
}

/** Every still of a clip is up (a video with none counts as up). */
export function clipStillsUploaded(clip: ClipInfo | undefined): boolean {
  return !clip || clip.stills.every((s) => typeof s.path === 'string' && s.path.length > 0);
}

interface SentFile { kind: 'image' | 'file'; name: string; path?: string; clip?: ClipInfo }

/**
 * The words a send carries for its files: the files block (every file,
 * videos included), then each recorded video's stills and words, then what
 * the person typed.
 */
export function withAttachmentText(text: string, items: readonly SentFile[]): string {
  const files = items.filter((a) => a.kind === 'file' && a.path);
  const clips = files
    .filter((a) => a.clip)
    .map((a) => videoClipBlocks({
      name: a.name,
      durationMs: a.clip!.durationMs,
      stills: a.clip!.stills.map((s) => s.path ?? '').filter(Boolean),
      narration: a.clip!.narration,
    }))
    .join('');
  return attachmentHeaderBlock('files', files.map((a) => a.path!)) + clips + text;
}

/** A recorded video's line on its card: "0:42 video · 8 stills · what was said". */
export function clipDetail(clip: ClipInfo): string {
  const stills = clip.stills.length;
  const words = clip.narration ? 'what was said' : clip.narrationNote ?? 'no words';
  return `${clipClock(clip.durationMs)} video · ${stills === 1 ? '1 still' : `${stills} stills`} · ${words}`;
}

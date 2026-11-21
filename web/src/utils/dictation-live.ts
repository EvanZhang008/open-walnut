/**
 * Voice takes this page holds in memory: recording, or recorded and still being
 * heard. Nothing else has their audio until the whole clip reaches the server,
 * so a reload or a page recycle in between throws the take away.
 *
 * 2026-11-20, the user's 11-minute mock interview: a deploy made the tab's bundle
 * stale and the Mac app recycled the page process (`stale_bundle`) while he was
 * still talking. The take was never transcribed and no recording was saved. Every
 * reload and recycle asks unsaved-work.ts first, which counts these takes.
 */

const live = new Set<symbol>();

/** A take began; call the returned function once it is delivered, failed or dropped. */
export function holdLiveTake(): () => void {
  const id = Symbol('take');
  live.add(id);
  return () => { live.delete(id); };
}

/** How many takes this page holds that no server has yet. */
export function liveTakeCount(): number {
  return live.size;
}

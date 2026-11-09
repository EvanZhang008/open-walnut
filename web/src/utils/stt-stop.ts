/**
 * Deciding what to do when the user stops a dictation that has been streaming a
 * live draft into their text box.
 *
 * Extracted from the hook so the reasoning is testable on its own: the inputs are
 * four numbers and booleans, and getting it wrong either makes the user wait for
 * nothing or truncates the end of their sentence.
 */

export type StopAction =
  /** Keep the draft as the result. No server round-trip: the user finished talking before the last draft ran. */
  | 'draft-is-final'
  /** Deliver the draft now so it is usable, then refine it when the authoritative pass returns. */
  | 'draft-then-refine'
  /** Nothing usable to show yet: wait for the authoritative pass. */
  | 'wait-for-server';

export interface StopContext {
  /** A draft was delivered during this recording and is sitting in the user's text. */
  hasDraft: boolean;
  /**
   * The level analyser attached and saw speech at least once. Without it we have no
   * idea when the user stopped talking, so no shortcut is safe.
   */
  knowsWhenSpeechEnded: boolean;
  /** Chunks of audio (~1s each) the newest delivered draft was transcribed from. */
  draftCoveredChunks: number;
  /** Chunk during which speech was last heard. */
  lastVoiceChunk: number;
  /**
   * The draft was not made from the recording itself: the Web Audio side
   * capture built it (where the recorder's audio does not decode), or the draft
   * loop abandoned a span of speech. Such a draft is a preview and never the
   * result, however cleanly the user stopped. A draft decoded from the recorder's
   * own audio (recorder-pcm.ts) is not.
   */
  draftIsPreview: boolean;
}

/**
 * The whole question is "did the newest draft already hear everything the user
 * said?". If the draft was built from at least as much audio as the point where
 * speech last occurred, then everything after it is silence, the draft already
 * says it all, and re-transcribing the clip would burn seconds to reach the same
 * words. Otherwise the user stopped mid-sentence and the tail is genuinely
 * missing, so the draft is a head start rather than an answer.
 *
 * Only a draft made from the recording itself can be the answer. The side
 * capture's drafts dropped words the recording kept (in WebKit it reads the mic
 * through a ring buffer that gives zeros when read ahead): in the Mac app on
 * 2026-11-07, text assembled from them held 87% of the words a pass over the
 * whole recording found, a 240 s take about half. So those are always refined
 * from the whole clip.
 */
export function decideStopAction(ctx: StopContext): StopAction {
  if (!ctx.hasDraft || !ctx.knowsWhenSpeechEnded) return 'wait-for-server';
  if (ctx.draftIsPreview) return 'draft-then-refine';
  return ctx.draftCoveredChunks >= ctx.lastVoiceChunk ? 'draft-is-final' : 'draft-then-refine';
}

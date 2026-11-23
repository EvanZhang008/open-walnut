/**
 * The whole-clip text of a take into the consumer's box (useSpeechToText), and whether it landed
 * there. With a preview already in the box (`provisional`), the consumer swaps it only while the
 * preview sits there untouched (onRefine returns true); a preview the user edited, or one a second
 * dictation took over, stays, and the final text did not land. Only a landed take is noted as the
 * box's (onTake, utils/dictation-takes.ts): a box holding a preview never pairs the engine's text.
 */
export function deliverFinalText(
  finalText: string,
  provisional: string | null,
  cb: { onTranscribe: (text: string) => void; onRefine?: (finalText: string, provisional: string) => boolean | void },
): boolean {
  if (provisional === null) { cb.onTranscribe(finalText); return true; }
  if (cb.onRefine) return cb.onRefine(finalText, provisional) === true;
  // A consumer that cannot refine gets a plain write of the final text (identical text: already there).
  if (finalText !== provisional) cb.onTranscribe(finalText);
  return true;
}

/**
 * Message hints a surface asks for on a session's NEXT send, whoever's composer sends it (the
 * browser side panel's "Let Walnut act in this tab" turned on mid-conversation: the tab rides the
 * person's next message as the `object-context` hint, never as words in it; 2026-11-04, the user:
 * the instruction to Walnut is "some automatic thing", not his). useSessionSend takes them.
 */
export type RequestedHints = Record<string, { arg?: string }>;

const pending = new Map<string, RequestedHints>();

export function setPendingHints(sessionId: string, hints: RequestedHints): void {
  pending.set(sessionId, { ...(pending.get(sessionId) ?? {}), ...hints });
}

/** The hints waiting for this session's send, merged under the send's own; taken once. */
export function takePendingHints(sessionId: string, own?: RequestedHints): RequestedHints | undefined {
  const waiting = pending.get(sessionId);
  pending.delete(sessionId);
  if (!waiting) return own;
  return { ...waiting, ...(own ?? {}) };
}

/**
 * A surface that decides its hints only when the message goes (the side panel: the text the
 * person has selected on the page right then, and the tab they turned over since their last
 * message). Asked once per send of that session, before the bubble shows; its hints go under the
 * waiting ones and the send's own. One source per session; `null` removes it.
 */
/** Asked with the words the send carries, so the surface can tell which bubble its hints went with. */
export type PendingHintsSource = (message: string) => Promise<RequestedHints | undefined>;
const sources = new Map<string, PendingHintsSource>();

export function setPendingHintsSource(sessionId: string, source: PendingHintsSource | null): void {
  if (source) sources.set(sessionId, source);
  else sources.delete(sessionId);
}

export function hasPendingHintsSource(sessionId: string): boolean {
  return sources.has(sessionId);
}

/** takePendingHints, with the session's source asked first (a source that fails adds nothing). */
export async function takePendingHintsAsync(sessionId: string, own?: RequestedHints, message = ''): Promise<RequestedHints | undefined> {
  const source = sources.get(sessionId);
  const asked = source ? await source(message).catch(() => undefined) : undefined;
  const taken = takePendingHints(sessionId, own);
  if (!asked) return taken;
  return { ...asked, ...(taken ?? {}) };
}

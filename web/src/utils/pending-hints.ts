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

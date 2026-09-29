/**
 * The launch prompt as the tab that pressed Start knows it.
 *
 * The server holds every native launch's prompt and `session:get-queue` hands it
 * to any panel that opens (src/core/sessions/launch-prompts.ts). That answer is
 * one round trip after the real panel mounts, so the launching tab would show its
 * message in the pending column, then an empty timeline for a few frames, then the
 * message again. Seeding the real panel from what this tab just sent closes that
 * gap. It also covers an ACP launch, whose id the server only learns at spawn.
 *
 * Same id as the server's (`launch-<sid>`), so the queue answer is recognized as
 * the same bubble and never adds a second one. Short-lived on purpose: it only has
 * to bridge the promotion and a remount right after it (the strip's animation
 * mounts a panel twice). Anything later is the server's job.
 */

const TTL_MS = 60_000;
const MAX_ENTRIES = 20;

const seeds = new Map<string, { text: string; at: string; expiresAt: number }>();

/** Mirrors launchPromptId in src/core/sessions/launch-prompts.ts. */
export function launchPromptId(sessionId: string): string {
  return `launch-${sessionId}`;
}

export function seedLaunchPrompt(sessionId: string, text: string, now = Date.now()): void {
  if (!sessionId || !text.trim()) return;
  seeds.delete(sessionId);
  seeds.set(sessionId, { text, at: new Date(now).toISOString(), expiresAt: now + TTL_MS });
  while (seeds.size > MAX_ENTRIES) {
    const oldest = seeds.keys().next().value;
    if (oldest === undefined) break;
    seeds.delete(oldest);
  }
}

export function launchSeedFor(sessionId: string, now = Date.now()): { id: string; text: string; at: string } | undefined {
  const s = seeds.get(sessionId);
  if (!s) return undefined;
  if (s.expiresAt <= now) {
    seeds.delete(sessionId);
    return undefined;
  }
  return { id: launchPromptId(sessionId), text: s.text, at: s.at };
}

/** Test hook. */
export function clearLaunchSeeds(): void {
  seeds.clear();
}

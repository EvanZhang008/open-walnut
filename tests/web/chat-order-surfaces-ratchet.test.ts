/**
 * RATCHET: every chat surface places a sent message through ONE rule
 * (web/src/stream/chat-order.ts: where Claude Code took the line).
 *
 * 2026-10-31 (the user: "my own input jumped above the answer ... this is
 * ridiculous"): the order had been guessed per surface. The session timeline
 * froze a bubble at the block count when it was SENT, the question card drew
 * every unsent-yet question before the live answer, and the review sidebar took
 * the newest live text as the newest question's answer. Each earlier fix (send
 * position, `[Qn]` tags, the open/reload hold, iOS's own freeze) covered one of
 * those and left the rest.
 *
 * This test enumerates, from the source, every component that draws a user
 * bubble or a live stream block, and fails when one appears that neither reads
 * chat-order nor is listed below with the reason it has no live order to keep.
 * It also pins the order's inputs: the CLI's take report becomes a marker on the
 * server and in both browser reducers, and no surface reads the send-time
 * position (`blockIndexMap`) except through `bubbleIndexOf`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const WEB = join(ROOT, 'web', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const files = walk(WEB).map((p) => ({ rel: relative(ROOT, p), src: readFileSync(p, 'utf8') }));

/** Draws a user bubble, or a live stream block. */
const drawsChat = (src: string) => /session-msg-user/.test(src) || /<StreamingBlockView\b/.test(src);

/** How each chat-drawing component keeps the order. */
const SURFACES: Record<string, string> = {
  // Reads chat-order itself: the session columns, the Ask Walnut slot, Main's and a
  // lead's Org chat, the notes chat, the side-question drawer, the focus dock and
  // the task page all mount this one component.
  'web/src/components/sessions/SessionChatHistory.tsx': 'chat-order',
  // The Ask here card: drawn from `rounds`, which SessionChatHistory builds with cardLiveRounds.
  'web/src/components/sessions/ThreadCardConversation.tsx': 'rounds',
  // The row component itself: placed by its caller.
  'web/src/components/sessions/SessionMessage.tsx': 'row',
  // Persisted rows only (the server's parse orders them, src/core/session-history.ts).
  'web/src/components/sessions/ChatEarlierBlock.tsx': 'history only',
  'web/src/components/sessions/TaskEarlierSessions.tsx': 'history only',
  // Subagent lane blocks: no user line is ever in a lane.
  'web/src/components/sessions/LaneTimeline.tsx': 'lane only',
  // Before a session exists: queued messages and nothing streaming above them.
  'web/src/components/sessions/PendingSessionPanel.tsx': 'no stream',
  'web/src/components/workspaces/WorkspacePreparingPanel.tsx': 'no stream',
  'web/src/components/notes/NotesSessionChat.tsx': 'no stream before the session; SessionChatHistory after',
};

describe('ratchet: every chat surface keeps one order', () => {
  it('every component that draws a user bubble or a live block is listed', () => {
    const drawing = files.filter((f) => drawsChat(f.src)).map((f) => f.rel).sort();
    const unlisted = drawing.filter((rel) => !(rel in SURFACES));
    expect(unlisted, `A new chat surface draws messages without going through web/src/stream/chat-order.ts.
Place its bubbles with bubbleIndexOf / cardLiveRounds (or mount SessionChatHistory), then list it here.`).toEqual([]);
    // A listed file that stopped drawing is removed from the list (no stale exemptions).
    expect(Object.keys(SURFACES).filter((rel) => !drawing.includes(rel))).toEqual([]);
  });

  it('the surfaces that keep a live order read it from chat-order', () => {
    const history = read('web/src/components/sessions/SessionChatHistory.tsx');
    expect(history).toMatch(/from '@\/stream\/chat-order'/);
    // The timeline places every bubble through bubbleIndexOf, never by its send position alone.
    expect(history).toMatch(/const idx = bubbleIndexOf\(msg, lines, blocks\.length, blockIndexMap\.get\(msg\.queueId\)\)/);
    // The card and the review sidebar are built in timeline order.
    expect(history.match(/cardLiveRounds\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(read('web/src/components/sessions/ThreadCardConversation.tsx')).toMatch(/rounds: Array</);
    // No other file reads the send-time position.
    const readers = files.filter((f) => /blockIndexMap/.test(f.src)).map((f) => f.rel);
    expect(readers).toEqual(['web/src/components/sessions/SessionChatHistory.tsx']);
  });

  it('the CLI\'s take report becomes a marker on the server and in both browser reducers', () => {
    const session = read('src/providers/claude-code-session.ts');
    expect(session).toMatch(/if \(lc\.state === 'started' && this\.claudeSessionId[\s\S]{0,1200}bus\.emit\(EventNames\.SESSION_USER_LINE/);
    expect(read('src/web/server.ts')).toMatch(/'session:user-line'[\s\S]{0,300}sessionStreamBuffer\.appendUserLine\(/);
    expect(read('web/src/hooks/useSessionStream.ts')).toMatch(/useEvent\('session:user-line'[\s\S]{0,500}appendUserLineBlock\(/);
    expect(read('web/src/cache/session-cache.ts')).toMatch(/onSessionEvent\('session:user-line'[\s\S]{0,500}appendUserLineBlock\(/);
  });

  it('history places a mid-turn send at its take and floats a waiting one past the live reply', () => {
    const parser = read('src/core/session-history.ts');
    expect(parser).toMatch(/raw\.attachment\?\.type === 'queued_command'\) \{\n\s*const j = enqueueOfAttachment\.get\(i\)/);
    expect(parser).toMatch(/floatQueuedRows\(result, resultParentIds\)/);
  });
});

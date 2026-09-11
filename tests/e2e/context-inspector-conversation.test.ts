/**
 * E2E regression test: Context Inspector + /compact must be conversation-scoped.
 *
 * Root cause this guards against: the multi-conversation rollout gave every
 * conversation its own file (conversations/{agentId}/{convId}.json), but the
 * frontend call sites for /compact and /api/context dropped conversationId.
 * resolveStorePath() then silently fell back to a deprecated legacy single-file
 * store, so /compact compacted the wrong (tiny) file (felt like "nothing
 * happened") and the Context Inspector reported the legacy file's token count
 * while the header % read the real active conversation — two numbers for one chat.
 *
 * The root fix: chat I/O is conversation-scoped end-to-end. A missing
 * conversationId no longer silently falls back to the legacy ghost file — the
 * store layer rejects it, and the routes resolve the agent's ACTIVE conversation
 * at the request boundary. These tests pin that contract:
 *   1. /api/context?conversationId=X reflects exactly X's volume (isolated per conv).
 *   2. /api/context with NO conversationId resolves to the ACTIVE conversation,
 *      never the legacy file (which is never created on a fresh home).
 *   3. The Inspector count agrees with /api/chat/stats for the same conversation
 *      (the two-numbers-for-one-chat bug can't recur).
 *   4. compact(conversationId=X) compacts only X, leaving a sibling conversation
 *      untouched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';

import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-ctx-conv'));

import { WALNUT_HOME, CHAT_HISTORY_FILE, conversationFile } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as chatHistory from '../../src/core/chat-history.js';
import { createConversation, getActiveConversationId } from '../../src/core/conversations.js';
import type { MessageParam } from '../../src/agent/model.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/** Build N user/assistant pairs (2N messages). */
function pairs(n: number, tag: string): MessageParam[] {
  const out: MessageParam[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', content: `${tag} question ${i}` } as MessageParam);
    out.push({ role: 'assistant', content: `${tag} answer ${i}` } as MessageParam);
  }
  return out;
}

// Two sibling conversations with DISTINCT message volumes (mirrors the user's
// active 800K-token conversation vs a small one). convBig is seeded last so it
// ends up active — letting us prove the "no conversationId" boundary resolves to
// the active conversation, not the legacy ghost file.
let convSmall: string;
let convBig: string;

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });

  const small = await createConversation('general', 'Small conversation');
  convSmall = small.id;
  await chatHistory.addAIMessages(pairs(3, 'SMALL'), { agentId: 'general', conversationId: convSmall });

  const big = await createConversation('general', 'Active conversation');
  convBig = big.id;
  await chatHistory.addAIMessages(pairs(25, 'BIG'), { agentId: 'general', conversationId: convBig });

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  // Let lingering background writers (git auto-commit, QMD) settle, then remove
  // with a small retry — otherwise rmdir can race a late write and hit ENOTEMPTY.
  await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

describe('Context Inspector — conversation scoping (regression)', () => {
  it('the legacy single-file store is never created on a fresh, conversation-native home', () => {
    // The whole bug was a silent fallback to this file. It must not exist.
    expect(fs.existsSync(CHAT_HISTORY_FILE)).toBe(false);
  });

  it('GET /api/context?conversationId=X reflects exactly that conversation', async () => {
    const small = await (await fetch(apiUrl(`/api/context?conversationId=${convSmall}`))).json();
    const big = await (await fetch(apiUrl(`/api/context?conversationId=${convBig}`))).json();
    expect(small.sections.apiMessages.count).toBe(6);   // 3 pairs
    expect(big.sections.apiMessages.count).toBe(50);    // 25 pairs
    // Conversations are isolated — one's volume never bleeds into the other.
    expect(big.sections.apiMessages.count).not.toBe(small.sections.apiMessages.count);
  });

  it('GET /api/context with NO conversationId resolves to the ACTIVE conversation', async () => {
    // convBig was seeded last → it is the active conversation.
    const active = await getActiveConversationId('general');
    expect(active).toBe(convBig);

    const res = await fetch(apiUrl('/api/context'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The boundary resolves to the active conversation (50 msgs), NOT a legacy
    // fallback. Pre-fix this silently read the ghost file instead.
    expect(body.sections.apiMessages.count).toBe(50);
  });

  it('Inspector message count agrees with /api/chat/stats for the same conversation', async () => {
    const ctxBody = await (await fetch(apiUrl(`/api/context?conversationId=${convBig}`))).json();
    const statsBody = await (await fetch(apiUrl(`/api/chat/stats?conversationId=${convBig}`))).json();
    // The header % (stats) and the Inspector now read the SAME file → same count.
    // This is the "two numbers for one chat" bug, pinned shut.
    expect(ctxBody.sections.apiMessages.count).toBe(statsBody.apiMessageCount);
  });

  it('Inspector token total for the bigger conversation exceeds the smaller one', async () => {
    const small = await (await fetch(apiUrl(`/api/context?conversationId=${convSmall}`))).json();
    const big = await (await fetch(apiUrl(`/api/context?conversationId=${convBig}`))).json();
    expect(big.sections.apiMessages.tokens).toBeGreaterThan(small.sections.apiMessages.tokens);
  });
});

describe('/compact — conversation scoping (regression)', () => {
  // We exercise the core compact() with a mock summarizer rather than the REST
  // /compact endpoint: the endpoint's summarizer is a real model call (no creds in
  // the test env). smart-compaction.test.ts uses the same pattern. This still
  // proves the fix's essence — that compaction honors conversationId and only
  // touches the targeted conversation.
  it('compact(conversationId=X) compacts X only, leaving a sibling conversation untouched', async () => {
    const smallMsgsBefore = (await chatHistory.getApiMessages('general', convSmall)).length;

    // Compact the BIG conversation with a deterministic summary (no LLM).
    await chatHistory.compact(async () => 'Big conversation summary', undefined, 'general', convBig);

    // The big conversation's compactionCount must increment + its summary set.
    const bigStore = JSON.parse(fs.readFileSync(conversationFile('general', convBig), 'utf8'));
    expect(bigStore.compactionCount ?? 0).toBeGreaterThan(0);
    expect(await chatHistory.getCompactionSummary('general', convBig)).toBe('Big conversation summary');

    // The small (sibling) conversation must be untouched — compaction was scoped.
    const smallStore = JSON.parse(fs.readFileSync(conversationFile('general', convSmall), 'utf8'));
    expect(smallStore.compactionCount ?? 0).toBe(0);
    expect((await chatHistory.getApiMessages('general', convSmall)).length).toBe(smallMsgsBefore);
    expect(await chatHistory.getCompactionSummary('general', convSmall)).toBeNull();
  });
});

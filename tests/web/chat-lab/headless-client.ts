/**
 * HeadlessChatClient — the chat lab's browser-free session view.
 *
 * It is deliberately NOT a reimplementation: every piece of rendering logic it
 * runs is the REAL production module —
 *   · stream accumulation  → web/src/stream/stream-reducer.ts
 *   · delta folding        → web/src/hooks/history-merge.ts (planDeltaMerge)
 *   · request shape        → web/src/hooks/history-anchor.ts (anchor + reviseIds)
 *   · absorption           → web/src/stream/render-filter.ts
 *   · lane grouping        → web/src/stream/group-blocks.ts
 *   · bubble dedup         → web/src/components/sessions/optimistic-dedup.ts
 * The lab replaces only React's wiring (hooks/effects) and the transport. A
 * scenario that passes here proves the shipped logic; a scenario that fails
 * here is a real UI bug reproduced without a browser.
 *
 * The client mirrors the component's own reactions:
 *   · session:batch-completed  → delta fetch (anchor + unsettled re-ask)
 *   · session:result           → isStreaming false; on the true→false EDGE, a
 *                                delta fetch (SessionChatHistory's edge refetch)
 *   · watermark                → advanced on the false→true streaming edge
 */

import {
  applyMainTextDelta,
  appendMainThinking,
  appendLaneText,
  appendLaneThinking,
  appendToolCall,
  backfillToolResult,
  appendSystemBlock,
  flushMainTextBuffer,
  type StreamingBlock,
} from '../../../web/src/stream/stream-reducer';
import { computeRenderFilter, allBlocksAbsorbed } from '../../../web/src/stream/render-filter';
import { groupStreamingBlocks, type GroupedStreamItem } from '../../../web/src/stream/group-blocks';
import { dedupeOptimisticMessages } from '../../../web/src/components/sessions/optimistic-dedup';
import { computeHistoryAnchor, collectUnsettledIds } from '../../../web/src/hooks/history-anchor';
import { planDeltaMerge } from '../../../web/src/hooks/history-merge';
import type { SessionHistoryMessage } from '../../../web/src/types/session';
import type { ScriptedServer } from './scripted-server';

interface OptimisticBubble {
  queueId: string;
  text: string;
  status: 'pending' | 'received' | 'delivered' | 'failed';
  role: 'user';
  timestamp: string;
  dedupText?: string;
}

/** One visible item in the projected timeline — what the user would see. */
export interface VisibleItem {
  kind: 'history' | 'bubble' | 'block' | 'task-group' | 'orphan-group';
  label: string;
}

export class HeadlessChatClient {
  messages: SessionHistoryMessage[] = [];
  cursor = 0;
  blocks: StreamingBlock[] = [];
  textBuffer = '';
  isStreaming = false;
  watermark = 0;
  optimistic: OptimisticBubble[] = [];
  /** Lazy tail mode (mirrors useSessionHistory): full fetches carry ?tail=N;
   *  baseOffset counts the rows hidden before messages[0] in cursor space. */
  tailLimit?: number;
  baseOffset = 0;
  /** Sticky consumption (mirrors SessionChatHistory's consumedQueueIds ref):
   *  once dedup hides a bubble it is GC'd permanently — the watermark advancing
   *  past its persisted twin must not resurrect it. */
  private consumedQueueIds = new Set<string>();
  private bubbleSeq = 0;

  constructor(private server: ScriptedServer, opts?: { tailLimit?: number }) {
    this.tailLimit = opts?.tailLimit;
  }

  // ── Initial load / reload ──────────────────────────────────────────────────

  /** Full fetch — initial mount or a page reload. A reload also drops streaming
   *  state (the server prunes its buffer after turn end, and the empty-snapshot
   *  guard means a fresh mount simply has no blocks). */
  reload(): void {
    const r = this.server.serve(this.tailLimit ? { tail: this.tailLimit } : {});
    this.messages = r.messages;
    this.cursor = r.cursor;
    // Lazy tail: cursor counts rows we did not receive (adoptOffset in the hook).
    this.baseOffset = Math.max(0, r.cursor - r.messages.length);
    this.blocks = [];
    this.textBuffer = '';
    this.isStreaming = false;
    this.watermark = this.messages.length;
    // Optimistic bubbles live in useSessionSend state, which a reload resets.
    this.optimistic = [];
    this.consumedQueueIds.clear();
  }

  /** "Load N earlier messages" — the one deliberately unbounded fetch. */
  loadFullHistory(): void {
    if (this.baseOffset === 0) return;
    const grew = this.server.serve({});
    // Mirror the hook: full replace + fresh offset bookkeeping. The watermark
    // must keep pointing at the same MESSAGE (turn boundary), not the same
    // index — the array just grew by the backfilled prefix.
    const growth = grew.messages.length - this.messages.length;
    this.messages = grew.messages;
    this.cursor = grew.cursor;
    this.baseOffset = Math.max(0, grew.cursor - grew.messages.length);
    this.watermark = Math.min(grew.messages.length, Math.max(0, this.watermark + growth));
  }

  // ── User actions ───────────────────────────────────────────────────────────

  send(text: string): string {
    const queueId = `qm-lab-${++this.bubbleSeq}`;
    this.optimistic.push({
      queueId, text, status: 'delivered', role: 'user',
      timestamp: new Date(1700000000000 + this.bubbleSeq).toISOString(),
    });
    return queueId;
  }

  // ── WS events (the same payloads the server broadcasts) ───────────────────

  /** React renders after EVERY state change, and bubble consumption is sticky
   *  (a bubble hidden once is GC'd). A lab that only projects at the end would
   *  let the watermark advance past a bubble's twin before dedup ever saw it —
   *  a fake stuck-bubble. Each event method ends with this render. */
  private render(): void {
    void this.project();
  }

  private markStreaming(): void {
    if (!this.isStreaming) {
      // false→true edge: the component advances the turn watermark here.
      // The render BEFORE the move mirrors React: the send/last events already
      // rendered with the old watermark, consuming any bubble whose twin
      // arrived in the previous window.
      this.render();
      this.watermark = this.messages.length;
      this.isStreaming = true;
    }
  }

  textDelta(delta: string, opts?: { msgId?: string; parentToolUseId?: string; subagentType?: string; taskDescription?: string }): void {
    this.markStreaming();
    if (opts?.parentToolUseId) {
      this.blocks = appendLaneText(this.blocks, {
        delta, msgId: opts.msgId, parentToolUseId: opts.parentToolUseId,
        subagentType: opts.subagentType, taskDescription: opts.taskDescription,
      });
      return;
    }
    const next = applyMainTextDelta(this.blocks, this.textBuffer, delta, opts?.msgId, 0);
    this.blocks = next.blocks;
    this.textBuffer = next.textBuffer;
  }

  thinkingDelta(delta: string, opts?: { msgId?: string; parentToolUseId?: string }): void {
    this.markStreaming();
    if (opts?.parentToolUseId) {
      this.blocks = appendLaneThinking(this.blocks, { delta, msgId: opts.msgId, parentToolUseId: opts.parentToolUseId });
      return;
    }
    this.blocks = appendMainThinking(this.blocks, delta, opts?.msgId, 0);
  }

  toolUse(toolUseId: string, toolName: string, opts?: { input?: Record<string, unknown>; parentToolUseId?: string; subagentType?: string; taskDescription?: string }): void {
    this.markStreaming();
    if (!opts?.parentToolUseId) {
      this.blocks = flushMainTextBuffer(this.blocks, this.textBuffer, 0);
      this.textBuffer = '';
    }
    this.blocks = appendToolCall(this.blocks, {
      toolUseId, toolName, input: opts?.input,
      parentToolUseId: opts?.parentToolUseId,
      subagentType: opts?.subagentType, taskDescription: opts?.taskDescription,
    });
  }

  toolResult(toolUseId: string, result: string): void {
    this.blocks = backfillToolResult(this.blocks, toolUseId, result, false);
  }

  systemEvent(message: string): void {
    this.blocks = flushMainTextBuffer(this.blocks, this.textBuffer, 0);
    this.textBuffer = '';
    this.blocks = appendSystemBlock(this.blocks, { variant: 'info', message });
  }

  /** session:result — the turn ended. Mirrors the component: streaming flips
   *  false, and the true→false edge triggers a history refetch. */
  result(): void {
    this.blocks = flushMainTextBuffer(this.blocks, this.textBuffer, 0);
    this.textBuffer = '';
    const wasStreaming = this.isStreaming;
    this.isStreaming = false;
    if (wasStreaming) this.deltaFetch();
    this.render();
  }

  /** session:batch-completed — the delivered batch flushed to JSONL. */
  batchCompleted(): void {
    this.deltaFetch();
    this.render();
  }

  // ── History delta fetch (the REAL request/merge contract) ─────────────────

  deltaFetch(): void {
    const anchor = computeHistoryAnchor(this.messages);
    const reviseIds = collectUnsettledIds(this.messages);
    const r = this.server.serve({
      since: this.cursor,
      anchorMsgId: anchor.anchorMsgId,
      anchorTail: anchor.anchorTail,
      reviseIds,
      // Mirrors the hook: tail bounds the declined-delta full payload only.
      ...(this.tailLimit ? { tail: this.tailLimit } : {}),
    });
    if (!r.delta) {
      // Full replace (server declined the delta) — possibly tail-sliced.
      this.messages = r.messages;
      this.cursor = r.cursor;
      this.baseOffset = Math.max(0, r.cursor - r.messages.length);
      return;
    }
    const plan = planDeltaMerge(this.messages, r, this.cursor, { baseOffset: this.baseOffset });
    if (plan.kind === 'rebuild') {
      const full = this.server.serve(this.tailLimit ? { tail: this.tailLimit } : {});
      this.messages = full.messages;
      this.cursor = full.cursor;
      this.baseOffset = Math.max(0, full.cursor - full.messages.length);
      return;
    }
    if (plan.kind === 'merged') this.messages = plan.messages;
    this.cursor = plan.cursor;
  }

  // ── Projection — what the user sees (history + bubbles + live region) ─────

  project(): VisibleItem[] {
    const items: VisibleItem[] = [];
    for (const m of this.messages) {
      items.push({ kind: 'history', label: `${m.role}:${m.text.slice(0, 40)}` });
    }
    // Sticky consumption, exactly as the component does it: dedup runs on the
    // still-visible bubbles, and anything it hides is consumed FOREVER.
    const visible = this.optimistic.filter(b => !this.consumedQueueIds.has(b.queueId));
    const kept = dedupeOptimisticMessages(visible, this.messages, this.watermark);
    const keptIds = new Set(kept.map(b => b.queueId));
    for (const b of visible) {
      if (!keptIds.has(b.queueId)) this.consumedQueueIds.add(b.queueId);
    }
    for (const b of kept) {
      items.push({ kind: 'bubble', label: `bubble:${b.text.slice(0, 40)}:${b.status}` });
    }
    const { hidden } = computeRenderFilter({
      blocks: this.blocks,
      messages: this.messages,
      watermark: this.watermark,
      isStreaming: this.isStreaming,
    });
    const grouped = groupStreamingBlocks(this.blocks, hidden);
    for (const g of grouped) {
      items.push(...this.projectGroupItem(g, hidden));
    }
    // Mirror the component's resetIfAbsorbed: once EVERY block is hidden and no
    // turn is live, the array is physically dropped (pure memory reclamation —
    // zero visual difference NOW, but load-bearing later: a /compact rewrite
    // removes the twins from history, and blocks still held would "un-absorb"
    // and resurface. Production can't hit that because the array is gone).
    if (allBlocksAbsorbed(this.blocks, hidden, this.isStreaming)) {
      this.blocks = [];
      this.textBuffer = '';
    }
    return items;
  }

  private projectGroupItem(g: GroupedStreamItem, hidden: Set<number>): VisibleItem[] {
    if (g.kind === 'block') {
      if (hidden.has(g.index)) return [];
      const b = g.block;
      const label = b.type === 'text' ? `text:${b.content.slice(0, 40)}`
        : b.type === 'thinking' ? `thinking:${b.content.slice(0, 40)}`
        : b.type === 'tool_call' ? `tool:${b.name}`
        : b.type === 'system' ? `system:${b.message.slice(0, 40)}`
        : 'permission';
      return [{ kind: 'block', label }];
    }
    if (g.kind === 'task-group') {
      return [{ kind: 'task-group', label: `agent:${g.taskBlock.toolUseId}:children=${g.childBlocks.length}` }];
    }
    return [{ kind: 'orphan-group', label: `orphan:${g.parentToolUseId}:children=${g.childBlocks.length}` }];
  }

  /** The live region only — streaming items rendered BELOW the last history
   *  message. This is exactly what "stale stuff pinned at the bottom" is. */
  liveRegion(): VisibleItem[] {
    return this.project().filter(i => i.kind !== 'history' && i.kind !== 'bubble');
  }

  staleBubbles(): VisibleItem[] {
    return this.project().filter(i => i.kind === 'bubble');
  }
}

/**
 * Transcript chain machinery — two functions with two distinct roles:
 *
 * 1. `computeCliLoadedChain` — a read-side port of the CLI's own `--resume
 *    <sid>` loader (`getLastSessionLog`): the chain from the latest-timestamp
 *    non-sidechain leaf, walked to its root, with DAG recovery for parallel
 *    tool results. Because the walk stops at the first null/dangling parent,
 *    this is the NEWEST tree of the forest only — exactly what the CLI can
 *    resume. Used to VALIDATE a rewind point at commit time (the CLI exits 1
 *    when `--resume-session-at` names a uuid off this chain, e.g. one behind
 *    the last compact boundary) and by tests. It is deliberately NOT used to
 *    filter displayed history: the file alone provably cannot distinguish a
 *    rewind branch from an innocent fork (an api_error line re-parenting the
 *    next user message, a mid-turn slash-command branch off pre-turn state) —
 *    measured on the real transcript store, an always-on chain filter deleted
 *    8.4% of rendered rows from sessions that were never rewound.
 *
 * 2. `computeRewindDeadSet` — display filtering driven ONLY by recorded rewind
 *    events (SessionRecord.inPlaceRewinds), replayed against the file FRESH at
 *    every read. The CLI disambiguates a rewind branch from an innocent fork
 *    via runtime state (`--resume-session-at` argv + the on-disk snapshot at
 *    resume); the cut record {uuid, lastUuidAtCommit} IS that runtime state,
 *    persisted. Both anchors are uuids resolved to line indices per read, so a
 *    file rewrite (tombstone) cannot desync them, and lines appended after the
 *    commit sit past the anchor and can never join the dead region.
 *
 * Port contract for #1 is the CLI source, cited per rule below:
 *   loadTranscriptFile dispatch      sessionStorage.ts:3625-3698
 *   isTranscriptMessage              sessionStorage.ts:139
 *   findLatestMessage                sessionStorage.ts:2046
 *   buildConversationChain           sessionStorage.ts:2069-2092
 *   recoverOrphanedParallelToolResults sessionStorage.ts:2118-2206
 *
 * Pure computation: no file/network I/O. Input is the array of per-line parsed
 * JSON objects in file order.
 */

import { log } from '../logging/index.js';
import type { InPlaceRewindCut } from './types.js';

/** Tree-node line types — port of isTranscriptMessage (sessionStorage.ts:139).
 *  Note `system` IS a tree node (compact boundaries chain through it). */
export const TRANSCRIPT_TREE_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);

/** Minimal structural shape of a parsed JSONL line the walk needs. */
export interface TranscriptChainLine {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  /** queue-operation fields (uuid-less lines, suppressed by identity key). */
  operation?: string;
  content?: string;
  /** compact_boundary metadata — preservedSegment drives the relink port. */
  compactMetadata?: {
    preservedSegment?: { headUuid?: string; anchorUuid?: string; tailUuid?: string };
  };
  message?: {
    id?: string;
    content?: string | Array<{ type: string }>;
  };
}

/**
 * Identity key of a queue-operation enqueue line: its own timestamp + content
 * pair. Queue lines carry NO uuid, and file order is NOT time order (35/40 real
 * transcripts have backward-stamped lines, so a [min,max] time window over a
 * dead region reached back past the rewind point and deleted LIVE pre-cut
 * rows). The pair can only match a line outside the dead region when it shares
 * the exact millisecond AND the exact text — and the history parser's synthetic
 * `queue-<timestamp>` id already collapses those into one row. A timestampless
 * enqueue still gets a usable key (empty prefix), so a timestampless dead
 * region no longer leaks its enqueues back as Pattern-B rows.
 */
export function queueEnqueueKey(line: { timestamp?: string; content?: unknown }): string {
  return `${line.timestamp ?? ''} ${typeof line.content === 'string' ? line.content : ''}`;
}

interface ChainNode {
  uuid: string;
  /** Effective parent (after the legacy progress bridge rewrite). */
  parentUuid: string | null;
  type: string;
  isSidechain: boolean;
  timestamp: string;
  /** Anthropic message.id for assistant nodes (parallel-tool sibling groups). */
  msgApiId?: string;
  /** user node whose content carries a tool_result block (DAG recovery). */
  isToolResultUser: boolean;
  /** system/compact_boundary line (isCompactBoundaryMessage, messages.ts:4608). */
  isCompactBoundary?: boolean;
  /** The boundary's compactMetadata.preservedSegment, when it carries one. */
  compactSeg?: { headUuid: string; anchorUuid: string; tailUuid: string };
}

/**
 * Build the uuid→node map in file order — port of the loadTranscriptFile parse
 * loop (sessionStorage.ts:3625-3698).
 *
 * Legacy progress bridge (sessionStorage.ts:3629-3645): pre-#24099 transcripts
 * persisted `progress` lines INSIDE the parentUuid chain; they are consumed
 * into a uuid→parent bridge (chain-resolving through consecutive runs) and any
 * tree node whose parent lands in the bridge is re-pointed at the nearest
 * non-progress ancestor. Without this an old transcript truncates there.
 */
function buildChainNodes(parsedLines: readonly TranscriptChainLine[]): Map<string, ChainNode> {
  const progressBridge = new Map<string, string | null>();
  const nodes = new Map<string, ChainNode>();
  for (const raw of parsedLines) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') continue;
    if (raw.type === 'progress' && typeof raw.uuid === 'string') {
      const parent = typeof raw.parentUuid === 'string' ? raw.parentUuid : null;
      progressBridge.set(
        raw.uuid,
        parent && progressBridge.has(parent) ? (progressBridge.get(parent) ?? null) : parent,
      );
      continue;
    }
    if (!TRANSCRIPT_TREE_TYPES.has(raw.type)) continue;
    // A tree-typed line with NO uuid is a non-tree line (pass-through) — mirrors
    // the CLI byte prefilter's "no top-level uuid = metadata, always preserved"
    // (sessionStorage.ts:3390).
    if (typeof raw.uuid !== 'string') continue;
    let parentUuid = typeof raw.parentUuid === 'string' ? raw.parentUuid : null;
    if (parentUuid && progressBridge.has(parentUuid)) {
      parentUuid = progressBridge.get(parentUuid) ?? null;
    }
    const content = raw.message?.content;
    const isCompactBoundary = raw.type === 'system' && raw.subtype === 'compact_boundary';
    const seg = isCompactBoundary ? raw.compactMetadata?.preservedSegment : undefined;
    // Map.set on a duplicate uuid: later value overwrites, original insertion
    // position kept — matching sessionStorage.ts:3646.
    nodes.set(raw.uuid, {
      uuid: raw.uuid,
      parentUuid,
      type: raw.type,
      isSidechain: raw.isSidechain === true,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
      msgApiId: raw.type === 'assistant' && typeof raw.message?.id === 'string'
        ? raw.message.id : undefined,
      isToolResultUser: raw.type === 'user' && Array.isArray(content)
        && content.some((b) => b?.type === 'tool_result'),
      ...(isCompactBoundary ? { isCompactBoundary } : {}),
      ...(seg && typeof seg.headUuid === 'string' && typeof seg.anchorUuid === 'string'
        && typeof seg.tailUuid === 'string'
        ? { compactSeg: { headUuid: seg.headUuid, anchorUuid: seg.anchorUuid, tailUuid: seg.tailUuid } }
        : {}),
    });
  }
  return nodes;
}

/**
 * Port of the CLI's applyPreservedSegmentRelinks (sessionStorage.ts:1839-1956),
 * relink half only. A partial ("suffix-preserving") compaction dedup-skips the
 * kept messages, so on disk they keep their PRE-compact parentUuids while the
 * first post-compact message parents onto the ANCHOR (the last summary line, or
 * the boundary itself for prefix-preserving). The CLI patches the endpoints in
 * memory BEFORE leaf selection: head.parentUuid → anchorUuid, and anchor's
 * other children → tailUuid — which is what makes the preserved messages part
 * of the chain `--resume` loads. Without this port, a rewind to a message
 * inside the preserved segment was refused with 409 even though
 * `--resume-session-at` on it works (4/17 real preserved-segment files).
 *
 * Faithful to the CLI:
 *  - only the LAST seg-boundary is relinked, and only when it IS the
 *    absolute-last boundary (a later no-seg /compact makes the seg stale —
 *    segIsLive, sessionStorage.ts:1870);
 *  - the tail→head walk is validated FIRST; if it doesn't reach head, NO
 *    relink (the CLI bails the same way, tengu_relink_walk_broken).
 *
 * The prune half (delete pre-boundary entries) is deliberately NOT ported: it
 * only removes uuids that are already off the chain this gate walks, and the
 * chain — not the node map — is what the gate consumes.
 *
 * Mutates the node map in place.
 */
function applyPreservedSegmentRelink(nodes: Map<string, ChainNode>): void {
  let lastSeg: { headUuid: string; anchorUuid: string; tailUuid: string } | undefined;
  let lastSegBoundaryIdx = -1;
  let absoluteLastBoundaryIdx = -1;
  let i = 0;
  for (const node of nodes.values()) {
    if (node.isCompactBoundary) {
      absoluteLastBoundaryIdx = i;
      if (node.compactSeg) {
        lastSeg = node.compactSeg;
        lastSegBoundaryIdx = i;
      }
    }
    i++;
  }
  if (!lastSeg) return;
  // Seg stale (a no-seg boundary came after): the CLI skips the relink.
  if (lastSegBoundaryIdx !== absoluteLastBoundaryIdx) return;

  // Validate tail→head BEFORE mutating (sessionStorage.ts:1875-1902).
  const walkSeen = new Set<string>();
  let cur = nodes.get(lastSeg.tailUuid);
  let reachedHead = false;
  while (cur && !walkSeen.has(cur.uuid)) {
    walkSeen.add(cur.uuid);
    if (cur.uuid === lastSeg.headUuid) {
      reachedHead = true;
      break;
    }
    cur = cur.parentUuid ? nodes.get(cur.parentUuid) : undefined;
  }
  if (!reachedHead) return; // broken walk — resume loads full pre-compact history

  const head = nodes.get(lastSeg.headUuid);
  if (head) head.parentUuid = lastSeg.anchorUuid;
  // Tail-splice: anchor's other children → tail (sessionStorage.ts:1915-1919).
  for (const node of nodes.values()) {
    if (node.parentUuid === lastSeg.anchorUuid && node.uuid !== lastSeg.headUuid) {
      node.parentUuid = lastSeg.tailUuid;
    }
  }
}

export interface CliLoadedChainResult {
  /** Uuids of the loaded chain, root → leaf order (DAG-recovered siblings and
   *  tool_results spliced after their group's last on-chain member). */
  chain: string[];
  /** Same uuids as `chain`, for membership checks. */
  chainUuids: Set<string>;
  /** The selected leaf's uuid, or null when the transcript has no non-sidechain
   *  tree line (the CLI's getLastSessionLog treats that as "no session"). */
  leafUuid: string | null;
}

/**
 * The conversation chain the CLI's `--resume <sid>` load would produce
 * (getLastSessionLog, sessionStorage.ts:3899): newest-tree only, since the walk
 * from the newest leaf terminates at the first null/dangling parent — a compact
 * boundary or a fork root (sessionStorage.ts:2088 and :3414).
 */
export function computeCliLoadedChain(parsedLines: readonly TranscriptChainLine[]): CliLoadedChainResult {
  const nodes = buildChainNodes(parsedLines);

  // ── Preserved-segment relink ── runs BEFORE leaf selection, exactly like the
  // CLI (applyPreservedSegmentRelinks at sessionStorage.ts:3704).
  applyPreservedSegmentRelink(nodes);

  // ── Leaf ── findLatestMessage(all nodes, m => !m.isSidechain): strict `>` on
  // Date.parse(timestamp) — NaN skipped, tie → first-inserted wins (Map
  // iteration order = file order; sessionStorage.ts:2046, :3899).
  let leaf: ChainNode | undefined;
  let maxTime = -Infinity;
  for (const m of nodes.values()) {
    if (m.isSidechain) continue;
    const t = Date.parse(m.timestamp);
    if (t > maxTime) { maxTime = t; leaf = m; }
  }
  if (!leaf) return { chain: [], chainUuids: new Set(), leafUuid: null };

  // ── Chain walk ── leaf→root with a `seen` cycle guard; on cycle keep the
  // partial chain (buildConversationChain, sessionStorage.ts:2069-2092).
  const seen = new Set<string>();
  const chainNodes: ChainNode[] = [];
  let cur: ChainNode | undefined = leaf;
  while (cur) {
    if (seen.has(cur.uuid)) break; // cycle → partial chain (:2077-2084)
    seen.add(cur.uuid);
    chainNodes.push(cur);
    cur = cur.parentUuid ? nodes.get(cur.parentUuid) : undefined;
  }
  chainNodes.reverse(); // root → leaf (:2092)

  // ── DAG recovery ── port of recoverOrphanedParallelToolResults
  // (sessionStorage.ts:2118-2206), over the whole map like the CLI. Streaming
  // emits one assistant line per content_block_stop, so N parallel tool_uses
  // are N lines with distinct uuids but ONE message.id, and each tool_result's
  // parentUuid points at its own one-block assistant — the single-parent walk
  // keeps only one branch. Recover off-chain sibling assistants and their
  // tool_result children for every group with an on-chain member; splice after
  // the LAST on-chain member so the group stays contiguous.
  const siblingsByMsgId = new Map<string, ChainNode[]>();
  const toolResultsByAsst = new Map<string, ChainNode[]>();
  for (const m of nodes.values()) {
    if (m.type === 'assistant' && m.msgApiId) {
      const group = siblingsByMsgId.get(m.msgApiId);
      if (group) group.push(m);
      else siblingsByMsgId.set(m.msgApiId, [m]);
    } else if (m.isToolResultUser && m.parentUuid) {
      const group = toolResultsByAsst.get(m.parentUuid);
      if (group) group.push(m);
      else toolResultsByAsst.set(m.parentUuid, [m]);
    }
  }
  const chainAssistants = chainNodes.filter((m) => m.type === 'assistant');
  // Anchor = last on-chain member of each group (chain order → last wins,
  // sessionStorage.ts:2129-2134).
  const anchorByMsgId = new Map<string, ChainNode>();
  for (const a of chainAssistants) {
    if (a.msgApiId) anchorByMsgId.set(a.msgApiId, a);
  }
  const processedGroups = new Set<string>();
  const inserts = new Map<string, ChainNode[]>();
  for (const asst of chainAssistants) {
    const msgId = asst.msgApiId;
    if (!msgId || processedGroups.has(msgId)) continue;
    processedGroups.add(msgId);
    const group = siblingsByMsgId.get(msgId) ?? [asst];
    const orphanedSiblings = group.filter((s) => !seen.has(s.uuid));
    const orphanedTRs: ChainNode[] = [];
    for (const member of group) {
      for (const tr of toolResultsByAsst.get(member.uuid) ?? []) {
        if (!seen.has(tr.uuid)) orphanedTRs.push(tr);
      }
    }
    if (orphanedSiblings.length === 0 && orphanedTRs.length === 0) continue;
    // Timestamp sort keeps content-block order; stable sort preserves JSONL
    // write order on ties (sessionStorage.ts:2184).
    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const recovered = [...orphanedSiblings, ...orphanedTRs];
    for (const r of recovered) seen.add(r.uuid);
    inserts.set(anchorByMsgId.get(msgId)!.uuid, recovered);
  }
  let ordered: ChainNode[];
  if (inserts.size > 0) {
    ordered = [];
    for (const m of chainNodes) {
      ordered.push(m);
      const ins = inserts.get(m.uuid);
      if (ins) ordered.push(...ins);
    }
  } else {
    ordered = chainNodes;
  }

  const chain = ordered.map((m) => m.uuid);
  return { chain, chainUuids: new Set(chain), leafUuid: leaf.uuid };
}

export interface RewindDeadSetResult {
  /** Uuids of DEAD tree lines. null = nothing to drop — callers skip filtering
   *  entirely (identity fast path; a session with no recorded rewinds always
   *  lands here, so never-rewound sessions are provably served unfiltered). */
  deadUuids: Set<string> | null;
  droppedCount: number;
  /** Identity keys (`queueEnqueueKey`) of the queue-operation enqueue lines
   *  found INSIDE resolved dead regions, plus each resolved cut's commit-time
   *  `trailingQueueKeys`. Used ONLY to suppress queue-operation enqueue echoes
   *  of rewound-away messages — never to decide tree-line deadness. Identity,
   *  not a time window: file order is not time order, and a [min,max] window
   *  measurably deleted live pre-cut rows on real transcripts. */
  queueDeadKeys: Set<string>;
}

/**
 * Replay recorded in-place rewind cuts against the file as read RIGHT NOW.
 *
 * For each cut: the dead region is the lines strictly after the rewind point
 * (cut.uuid) up to and INCLUDING the last tree line that existed at commit time
 * (cut.lastUuidAtCommit) — i.e. exactly the branch the rewind abandoned. Tree
 * lines in the region contribute their uuids to the dead set (only when that
 * uuid occurs EXACTLY once in the file — the dead set is applied uuid-globally,
 * so a duplicated uuid would take its live twin outside the region with it);
 * every queue-operation enqueue in the region contributes its identity key.
 * Regions union across cuts (a later rewind to an earlier point naturally
 * swallows the first branch and its replacement).
 *
 * Either anchor missing from the file, or either anchor uuid DUPLICATED in it
 * → SKIP that cut with one warn (named degrade — the file was rewritten under
 * the record, e.g. a tombstone or a preserved-segment compact re-append; never
 * cut on shaky ground). Deadness is NEVER computed from chain membership: the
 * file alone cannot distinguish a rewind branch from an innocent fork (see
 * module doc).
 */
export function computeRewindDeadSet(
  parsedLines: readonly TranscriptChainLine[],
  cuts: readonly Pick<InPlaceRewindCut, 'uuid' | 'lastUuidAtCommit' | 'trailingQueueKeys'>[],
): RewindDeadSetResult {
  if (cuts.length === 0) return { deadUuids: null, droppedCount: 0, queueDeadKeys: new Set() };

  // uuid → FIRST line index (+ occurrence count), resolved fresh from this
  // read. First occurrence is safe for the ANCHOR only: a too-early anchor can
  // only shrink the region. A too-early CUT index would GROW the region
  // backwards over live rows — so a duplicated cut/anchor uuid skips the cut
  // outright (the count guard below) instead of trusting either index.
  const indexOfUuid = new Map<string, number>();
  const countOfUuid = new Map<string, number>();
  for (let i = 0; i < parsedLines.length; i++) {
    const u = parsedLines[i]?.uuid;
    if (typeof u !== 'string') continue;
    countOfUuid.set(u, (countOfUuid.get(u) ?? 0) + 1);
    if (!indexOfUuid.has(u)) indexOfUuid.set(u, i);
  }

  const dead = new Set<string>();
  const queueDeadKeys = new Set<string>();
  for (const cut of cuts) {
    const cutIdx = indexOfUuid.get(cut.uuid);
    const anchorIdx = indexOfUuid.get(cut.lastUuidAtCommit);
    const cutDuplicated = (countOfUuid.get(cut.uuid) ?? 0) > 1;
    const anchorDuplicated = (countOfUuid.get(cut.lastUuidAtCommit) ?? 0) > 1;
    if (cutIdx === undefined || anchorIdx === undefined || cutDuplicated || anchorDuplicated) {
      log.session.warn('rewind cut anchor missing or duplicated in transcript — cut skipped, region served unfiltered', {
        cutUuid: cut.uuid,
        lastUuidAtCommit: cut.lastUuidAtCommit,
        cutFound: cutIdx !== undefined,
        anchorFound: anchorIdx !== undefined,
        cutDuplicated,
        anchorDuplicated,
      });
      continue;
    }
    // Dead region = (cutIdx, anchorIdx]. Lines appended after the rewind commit
    // sit past anchorIdx by construction and can never join it.
    for (let i = cutIdx + 1; i <= anchorIdx; i++) {
      const line = parsedLines[i];
      if (!line || typeof line !== 'object') continue;
      if (typeof line.uuid === 'string' && typeof line.type === 'string'
        && TRANSCRIPT_TREE_TYPES.has(line.type)
        // Application is uuid-global while collection is index-bounded: a dead
        // uuid whose twin sits OUTSIDE the region would delete that live twin
        // too (real source: preserved-segment compaction re-appends earlier
        // lines with their original uuids). Only a uuid unique in the file is
        // safe to kill.
        && countOfUuid.get(line.uuid) === 1) {
        dead.add(line.uuid);
      }
      if (line.type === 'queue-operation' && line.operation === 'enqueue') {
        queueDeadKeys.add(queueEnqueueKey(line));
      }
    }
    // Enqueues that trailed the commit-time anchor (uuid-less, so outside any
    // uuid-anchored region) — captured at commit, applied here.
    for (const key of cut.trailingQueueKeys ?? []) queueDeadKeys.add(key);
  }

  if (dead.size === 0) return { deadUuids: null, droppedCount: 0, queueDeadKeys };
  return { deadUuids: dead, droppedCount: dead.size, queueDeadKeys };
}

// The CLI load chain is used for resume validation; display filtering relies only on recorded rewinds and must never infer a deletion from an off-chain identity.

import type { InPlaceRewindCut } from './types.js';
import { selectCliLeafCandidates } from './transcript-chain-leaf.js';

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
  leafUuid?: string | null;
  explicit?: boolean;
  loaderReset?: boolean;
  attachment?: { type?: string };
  /** queue-operation fields (uuid-less lines, suppressed by identity key). */
  operation?: string;
  content?: string;
  compactMetadata?: {
    preservedSegment?: { headUuid?: string; anchorUuid?: string; tailUuid?: string };
    preservedMessages?: { anchorUuid: string; uuids: string[] };
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
  isSidechain?: boolean;
  timestamp: string;
  hasTimestamp: boolean;
  /** Anthropic message.id for assistant nodes (parallel-tool sibling groups). */
  msgApiId?: string;
  /** user node whose content carries a tool_result block (DAG recovery). */
  isToolResultUser: boolean;
  /** system/compact_boundary line (isCompactBoundaryMessage, messages.ts:4608). */
  isCompactBoundary?: boolean;
  compactSeg?: { headUuid: string; anchorUuid: string; tailUuid: string };
  preservedMessages?: { anchorUuid: string; uuids: string[] };
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
    if (raw.loaderReset) { nodes.clear(); progressBridge.clear(); }
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
      isSidechain: raw.isSidechain,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
      hasTimestamp: typeof raw.timestamp === 'string',
      msgApiId: raw.type === 'assistant' && typeof raw.message?.id === 'string'
        ? raw.message.id : undefined,
      isToolResultUser: raw.type === 'user' && Array.isArray(content)
        && content.some((b) => b?.type === 'tool_result'),
      ...(isCompactBoundary ? { isCompactBoundary, preservedMessages: raw.compactMetadata?.preservedMessages } : {}),
      ...(seg && typeof seg.headUuid === 'string' && typeof seg.anchorUuid === 'string'
        && typeof seg.tailUuid === 'string'
        ? { compactSeg: { headUuid: seg.headUuid, anchorUuid: seg.anchorUuid, tailUuid: seg.tailUuid } }
        : {}),
    });
  }
  return nodes;
}

function resolvePreservedMessages(boundary: ChainNode, nodes: Map<string, ChainNode>) {
  if (boundary.preservedMessages) return boundary.preservedMessages;
  const segment = boundary.compactSeg;
  if (!segment) return undefined;
  const seen = new Set<string>();
  const uuids: string[] = [];
  let current = nodes.get(segment.tailUuid);
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    uuids.push(current.uuid);
    if (current.uuid === segment.headUuid) return { anchorUuid: segment.anchorUuid, uuids: uuids.reverse() };
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  return undefined;
}

// CLI 2.1.258 hns/yns: list order wins; after relinking, prune the old nodes, then repair parent links that pointed at pruned nodes.
function applyPreservedSegmentRelink(nodes: Map<string, ChainNode>): string | undefined {
  let lastPreserved: ChainNode | undefined;
  let lastPreservedIndex = -1;
  let lastBoundaryIndex = -1;
  const indices = new Map<string, number>();
  let index = 0;
  for (const node of nodes.values()) {
    indices.set(node.uuid, index);
    if (node.isCompactBoundary) {
      lastBoundaryIndex = index;
      if (node.preservedMessages || node.compactSeg) {
        lastPreserved = node;
        lastPreservedIndex = index;
      }
    }
    index++;
  }
  if (!lastPreserved) return undefined;
  const live = lastPreservedIndex === lastBoundaryIndex;
  const resolved = live ? resolvePreservedMessages(lastPreserved, nodes) : undefined;
  if (live && !resolved) return undefined;
  const preserved = resolved && resolved.uuids.length > 0 ? resolved : undefined;
  if (preserved?.uuids.some((uuid) => !nodes.has(uuid))) return undefined;
  const uuids = preserved?.uuids ?? [];
  const kept = new Set(uuids);
  const tail = uuids.at(-1);
  if (preserved) {
    let parentUuid = preserved.anchorUuid;
    for (const uuid of uuids) {
      nodes.get(uuid)!.parentUuid = parentUuid;
      parentUuid = uuid;
    }
    for (const node of nodes.values()) {
      if (node.parentUuid === preserved.anchorUuid && node.uuid !== uuids[0]) node.parentUuid = tail!;
    }
  }
  const removed = new Set<string>();
  for (const uuid of nodes.keys()) {
    if (indices.get(uuid)! < lastBoundaryIndex && !kept.has(uuid)) removed.add(uuid);
  }
  for (const uuid of removed) nodes.delete(uuid);
  if (preserved && removed.size > 0) {
    for (const node of nodes.values()) {
      if ((node.type === 'user' || node.type === 'assistant') && node.parentUuid !== null && removed.has(node.parentUuid)) {
        node.parentUuid = tail!;
      }
    }
  }
  return tail;
}

function timestampFallbackParent(nodes: Map<string, ChainNode>, current: ChainNode, seen: Set<string>): ChainNode | undefined {
  const now = new Date(current.timestamp).getTime();
  if (Number.isNaN(now)) return undefined;
  let closest: ChainNode | undefined;
  let distance = Infinity;
  for (const node of nodes.values()) {
    if (seen.has(node.uuid) || node.isSidechain !== current.isSidechain) continue;
    const at = new Date(node.timestamp).getTime();
    if (Number.isNaN(at)) continue;
    const delta = now - at;
    if (delta >= 0 && delta <= 5000 && delta < distance) {
      distance = delta;
      closest = node;
    }
  }
  return closest;
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
  clearedToEmpty?: true;
}

// CLI 2.1.258: mir → hns → Ht → m4 → aEe/Sns/kns.
export function computeCliLoadedChain(parsedLines: readonly TranscriptChainLine[]): CliLoadedChainResult {
  const nodes = buildChainNodes(parsedLines);

  // ── Preserved-segment relink ── runs BEFORE leaf selection, exactly like the
  // CLI (applyPreservedSegmentRelinks at sessionStorage.ts:3704).
  const preservedTail = applyPreservedSegmentRelink(nodes);
  const candidates = selectCliLeafCandidates(parsedLines, nodes, preservedTail);
  const fallback = candidates.uuids.size === 0 && !candidates.clearedToEmpty;
  let leaf: ChainNode | undefined;
  let maxTime = -Infinity;
  for (const m of nodes.values()) {
    if (fallback ? m.isSidechain : !candidates.uuids.has(m.uuid)) continue;
    const t = Date.parse(m.timestamp);
    if (t > maxTime) { maxTime = t; leaf = m; }
  }
  if (!leaf) return { chain: [], chainUuids: new Set(), leafUuid: null, ...(candidates.clearedToEmpty ? { clearedToEmpty: true as const } : {}) };

  // ── Chain walk ── leaf→root with a `seen` cycle guard; on cycle keep the
  // partial chain (buildConversationChain, sessionStorage.ts:2069-2092).
  const seen = new Set<string>();
  const chainNodes: ChainNode[] = [];
  let cur: ChainNode | undefined = leaf;
  while (cur) {
    if (seen.has(cur.uuid)) break; // cycle → partial chain (:2077-2084)
    seen.add(cur.uuid);
    chainNodes.push(cur);
    if (!cur.parentUuid) break;
    const parent = nodes.get(cur.parentUuid);
    cur = !parent || seen.has(parent.uuid) ? timestampFallbackParent(nodes, cur, seen) : parent;
  }
  chainNodes.reverse();

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

  const children = new Map<string, ChainNode[]>();
  for (const node of nodes.values()) {
    if (node.parentUuid && node.type !== 'user' && node.type !== 'assistant') {
      const group = children.get(node.parentUuid) ?? [];
      group.push(node);
      children.set(node.parentUuid, group);
    }
  }
  const attachments: ChainNode[] = [];
  const pending = [leaf.uuid];
  for (let i = 0; i < pending.length; i++) {
    for (const node of children.get(pending[i]) ?? []) {
      if (seen.has(node.uuid)) continue;
      seen.add(node.uuid);
      attachments.push(node);
      pending.push(node.uuid);
    }
  }
  attachments.sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
  const chain = [...ordered, ...attachments].map((m) => m.uuid);
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
   *  `trailingQueueKeys` (which also carries the rewound message's own echo —
   *  that one sits BEFORE the cut). Used ONLY to suppress enqueue echoes
   *  of rewound-away messages — never to decide tree-line deadness. Identity,
   *  not a time window: file order is not time order, and a [min,max] window
   *  measurably deleted live pre-cut rows on real transcripts. */
  queueDeadKeys: Set<string>;
  /** Cuts this replay REFUSED to apply (anchor missing or duplicated), one entry
   *  each, always present (`[]` when every cut resolved). The caller logs them:
   *  this module has no logger (it is bundled into the daemon), and the named
   *  degrade must stay visible — the region is served UNFILTERED. */
  skippedCuts: SkippedRewindCut[];
}

/** One cut the replay could not locate, with the facts that decided it. */
export interface SkippedRewindCut {
  cutUuid: string;
  lastUuidAtCommit: string;
  cutFound: boolean;
  anchorFound: boolean;
  cutDuplicated: boolean;
  anchorDuplicated: boolean;
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
 * → SKIP that cut and report it in `skippedCuts` for the caller to warn about
 * (named degrade — the file was rewritten under the record, e.g. a tombstone or
 * a preserved-segment compact re-append; never cut on shaky ground). Deadness
 * is NEVER computed from chain membership: the
 * file alone cannot distinguish a rewind branch from an innocent fork (see
 * module doc).
 */
export function computeRewindDeadSet(
  parsedLines: readonly TranscriptChainLine[],
  cuts: readonly Pick<InPlaceRewindCut, 'uuid' | 'lastUuidAtCommit' | 'trailingQueueKeys'>[],
): RewindDeadSetResult {
  if (cuts.length === 0) {
    return { deadUuids: null, droppedCount: 0, queueDeadKeys: new Set(), skippedCuts: [] };
  }

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
  const skippedCuts: SkippedRewindCut[] = [];
  for (const cut of cuts) {
    const cutIdx = indexOfUuid.get(cut.uuid);
    const anchorIdx = indexOfUuid.get(cut.lastUuidAtCommit);
    const cutDuplicated = (countOfUuid.get(cut.uuid) ?? 0) > 1;
    const anchorDuplicated = (countOfUuid.get(cut.lastUuidAtCommit) ?? 0) > 1;
    if (cutIdx === undefined || anchorIdx === undefined || cutDuplicated || anchorDuplicated) {
      skippedCuts.push({
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
    // Enqueues the branch owns but this region cannot reach (uuid-less, so
    // outside any uuid-anchored region): the ones that trailed the commit-time
    // anchor, and the rewound message's own echo, which the CLI wrote BEFORE the
    // cut. Both captured at commit, applied here.
    for (const key of cut.trailingQueueKeys ?? []) queueDeadKeys.add(key);
  }

  if (dead.size === 0) return { deadUuids: null, droppedCount: 0, queueDeadKeys, skippedCuts };
  return { deadUuids: dead, droppedCount: dead.size, queueDeadKeys, skippedCuts };
}

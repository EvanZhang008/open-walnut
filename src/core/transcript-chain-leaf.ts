import type { TranscriptChainLine } from './transcript-chain.js';

interface LeafNode {
  uuid: string;
  parentUuid: string | null;
  type: string;
  isSidechain?: boolean;
  timestamp: string;
  hasTimestamp: boolean;
}

// CLI 2.1.258 mir/Ht: the last-prompt and the file order together decide the candidates; never just take the largest timestamp.
export function selectCliLeafCandidates(
  lines: readonly TranscriptChainLine[],
  nodes: ReadonlyMap<string, LeafNode>,
  preservedTail?: string,
): { uuids: Set<string>; clearedToEmpty: boolean } {
  let last: string | undefined;
  let latest: string | undefined;
  let latestTimestamp = '';
  let prompt: string | undefined;
  let explicit = false;
  let clearedToEmpty = false;
  let sawPrompt = false;
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    if (['user', 'assistant', 'attachment', 'system'].includes(line.type ?? '') && typeof line.uuid === 'string') {
      if (!line.isSidechain && !(line.type === 'attachment' && line.attachment?.type === 'fork_briefing')) {
        last = line.uuid;
        if (typeof line.timestamp === 'string' && line.timestamp > latestTimestamp) {
          latest = line.uuid;
          latestTimestamp = line.timestamp;
        }
        explicit = false;
        clearedToEmpty = false;
      }
      if (line.type === 'system' && line.subtype === 'compact_boundary') {
        prompt = undefined;
        explicit = false;
      }
    } else if (line.type === 'last-prompt') {
      if (line.leafUuid !== undefined) sawPrompt = true;
      if (line.leafUuid) {
        explicit = line.explicit === true || (explicit && line.leafUuid === prompt);
        prompt = line.leafUuid;
        clearedToEmpty = false;
      } else if (line.leafUuid === null && line.explicit === true) {
        clearedToEmpty = true;
        prompt = undefined;
        explicit = false;
      }
    }
  }
  const uuids = new Set<string>();
  if (clearedToEmpty) return { uuids, clearedToEmpty };
  const firstConversational = (uuid: string | undefined): LeafNode | undefined => {
    const seen = new Set<string>();
    let node = uuid ? nodes.get(uuid) : undefined;
    while (node && !seen.has(node.uuid)) {
      seen.add(node.uuid);
      if (node.type === 'user' || node.type === 'assistant') return node;
      node = node.parentUuid ? nodes.get(node.parentUuid) : undefined;
    }
    return undefined;
  };
  let base = last;
  if (!sawPrompt && base && latest && latest !== base) {
    const reaches = new Map<string, boolean>([[base, true]]);
    let timestamp = '';
    for (const node of nodes.values()) {
      if (node.isSidechain || node.uuid === last || !node.hasTimestamp || node.timestamp < timestamp) continue;
      const visited: string[] = [];
      let current: string | undefined = node.uuid;
      let reachable = false;
      while (current) {
        const known = reaches.get(current);
        if (known !== undefined) { reachable = known; break; }
        reaches.set(current, false);
        visited.push(current);
        current = nodes.get(current)?.parentUuid ?? undefined;
      }
      for (const uuid of visited) reaches.set(uuid, reachable);
      if (reachable) { base = node.uuid; timestamp = node.timestamp; }
    }
  }
  const explicitPresent = explicit && prompt && nodes.has(prompt) && !nodes.get(prompt)?.isSidechain;
  if (!preservedTail || explicitPresent) {
    let candidate = prompt && nodes.has(prompt) ? prompt : undefined;
    if (candidate && !explicit && last && nodes.has(last) && last !== candidate) {
      let current: string | undefined = last;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        if (current === candidate) { candidate = last; break; }
        seen.add(current);
        current = nodes.get(current)?.parentUuid ?? undefined;
      }
    }
    if (!preservedTail) candidate ??= base;
    const node = firstConversational(candidate);
    if (node) return { uuids: new Set([node.uuid]), clearedToEmpty };
  }
  const parents = new Set<string>();
  const conversationalParents = new Set<string>();
  for (const node of nodes.values()) {
    if (node.parentUuid !== null) {
      parents.add(node.parentUuid);
      if (node.type === 'user' || node.type === 'assistant') conversationalParents.add(node.parentUuid);
    }
  }
  for (const node of nodes.values()) {
    if (parents.has(node.uuid)) continue;
    const tip = firstConversational(node.uuid);
    if (tip && !conversationalParents.has(tip.uuid)) uuids.add(tip.uuid);
  }
  if (uuids.size > 1) {
    const candidate = prompt && uuids.has(prompt) ? prompt : last;
    const tip = firstConversational(candidate);
    if (tip) { uuids.clear(); uuids.add(tip.uuid); }
  }
  return { uuids, clearedToEmpty };
}

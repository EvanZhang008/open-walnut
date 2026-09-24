import type { TranscriptChainLine } from './transcript-chain.js';

export const CLI_TRANSCRIPT_PREFILTER_BYTES = 5 * 1024 * 1024;
const PARENT_PREFIX = Buffer.from('{"parentUuid":');
const PARENT_KEY = Buffer.from('"parentUuid":');
const UUID_KEY = Buffer.from('"uuid":"');
const UUID_TIMESTAMP = Buffer.from('","timestamp":"');
const SIDECHAIN = Buffer.from('"isSidechain":true');
const COMPACT = Buffer.from('"compact_boundary"');
const LAST_PROMPT = Buffer.from('"type":"last-prompt"');
const ATTRIBUTION = Buffer.from('{"type":"attribution-snapshot"');
const LEDGER = Buffer.from('{"type":"artifact-autoreact-ledger"');

function topLevelKey(bytes: Buffer, key: Buffer): number {
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i];
    if (escaped) { escaped = false; continue; }
    if (quoted) {
      if (value === 92) escaped = true;
      else if (value === 34) quoted = false;
      continue;
    }
    if (depth === 1 && value === key[0] && bytes.subarray(i, i + key.length).equals(key)) return i;
    if (value === 34) quoted = true;
    else if (value === 123) depth++;
    else if (value === 125) depth--;
  }
  return -1;
}

function uuidKey(bytes: Buffer): number {
  let first = -1;
  const matching: number[] = [];
  for (let at = bytes.indexOf(UUID_KEY); at >= 0; at = bytes.indexOf(UUID_KEY, at + UUID_KEY.length)) {
    if (first < 0) first = at;
    const end = at + UUID_KEY.length + 36;
    if (bytes.subarray(end, end + UUID_TIMESTAMP.length).equals(UUID_TIMESTAMP)) matching.push(at);
  }
  if (matching.length === 0) return first;
  if (matching.length === 1) return matching[0];
  let depth = 0, quoted = false, escaped = false, next = 0;
  for (let i = 0; next < matching.length; i++) {
    if (i === matching[next]) {
      if (depth === 1 && !quoted) return i;
      next++;
    }
    const value = bytes[i];
    if (escaped) escaped = false;
    else if (quoted) {
      if (value === 92) escaped = true;
      else if (value === 34) quoted = false;
    } else if (value === 34) quoted = true;
    else if (value === 123) depth++;
    else if (value === 125) depth--;
  }
  return matching.at(-1)!;
}

interface ByteNode {
  index: number;
  parent: string | null;
  sidechain: boolean;
  bytes: number;
}

// CLI 2.1.258 dir/gsr: keep the byte-level filter rules so the off-chain records of a large file are not fed back into the resume logic.
export function createCliTranscriptPrefilter(size: number, disablePrecompactSkip = false) {
  const large = size > CLI_TRANSCRIPT_PREFILTER_BYTES;
  const nodes: ByteNode[] = [];
  const byUuid = new Map<string, number>();
  const metadata = new Set<number>();
  const resets = new Set<number>();
  let preserved = false;
  let prompt: string | undefined;

  function push(bytes: Buffer, raw: Record<string, unknown>, index: number, lineBytes = bytes.length + 1): void {
    if (!large) return;
    if (!disablePrecompactSkip) {
      if (bytes.subarray(0, ATTRIBUTION.length).equals(ATTRIBUTION)) return;
      let start = 0;
      while (start < bytes.length && bytes[start] === 0) start++;
      if (bytes.subarray(start, start + LEDGER.length).equals(LEDGER)) return;
      if (bytes.length < 1024 && bytes.subarray(0, 64).includes(LAST_PROMPT) && raw.type === 'last-prompt') {
        if (raw.leafUuid) prompt = raw.leafUuid as string;
        metadata.add(index);
        return;
      }
      if (bytes.subarray(0, 4096).includes(COMPACT) && raw.type === 'system' && raw.subtype === 'compact_boundary') {
        const meta = raw.compactMetadata as { preservedSegment?: unknown; preservedMessages?: unknown } | undefined;
        if (meta?.preservedSegment || meta?.preservedMessages) preserved = true;
        else {
          resets.add(index);
          nodes.length = 0;
          byUuid.clear();
          preserved = false;
          prompt = undefined;
        }
      }
    }
    const prefixed = bytes.length > PARENT_PREFIX.length && bytes.subarray(0, PARENT_PREFIX.length).equals(PARENT_PREFIX);
    const parentAt = prefixed ? PARENT_PREFIX.length : disablePrecompactSkip ? -1 : topLevelKey(bytes, PARENT_KEY);
    if (parentAt < 0) { metadata.add(index); return; }
    const parentStart = prefixed ? parentAt : parentAt + PARENT_KEY.length;
    const at = uuidKey(bytes);
    if (at < 0) { metadata.add(index); return; }
    const uuid = bytes.toString('latin1', at + UUID_KEY.length, at + UUID_KEY.length + 36);
    const parent = bytes[parentStart] === 34 ? bytes.toString('latin1', parentStart + 1, parentStart + 37) : null;
    byUuid.set(uuid, nodes.length);
    nodes.push({ index, parent, bytes: lineBytes, sidechain: (disablePrecompactSkip ? bytes : bytes.subarray(0, 256)).includes(SIDECHAIN) });
  }

  function apply<T extends TranscriptChainLine>(lines: T[]): T[] {
    if (!large) return lines;
    let last = -1;
    if (disablePrecompactSkip || !preserved) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (!nodes[i].sidechain) { last = i; break; }
      }
    }
    let selected: Set<number> | null = last < 0 ? null : new Set();
    let selectedBytes = 0;
    let phantomParent = false;
    const seen = new Set<number>();
    const walk = (from: number | undefined) => {
      let current = from;
      while (current !== undefined && !seen.has(current)) {
        seen.add(current);
        const node = nodes[current];
        selected!.add(node.index);
        selectedBytes += node.bytes;
        if (node.parent === null) break;
        current = byUuid.get(node.parent);
        if (current === undefined) phantomParent = true;
      }
    };
    if (last >= 0) {
      walk(last);
      if (!disablePrecompactSkip) walk(prompt ? byUuid.get(prompt) : undefined);
    }
    if (disablePrecompactSkip && (last < 0 || size - selectedBytes < (size >> 1))) return lines;
    if (!disablePrecompactSkip && phantomParent) selected = null;
    selected ??= new Set(nodes.map((node) => node.index));
    for (const index of metadata) selected.add(index);
    return lines.filter((line, index) => {
      if (!selected.has(index)) return false;
      if (!disablePrecompactSkip && resets.has(index)) line.loaderReset = true;
      return true;
    });
  }
  return { push, apply };
}

import { describe, expect, it } from 'vitest';
import { createCliTranscriptPrefilter, CLI_TRANSCRIPT_PREFILTER_BYTES } from '../../src/core/transcript-chain-prefilter.js';
import { computeCliLoadedChain, type TranscriptChainLine } from '../../src/core/transcript-chain.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, parent: number | null, extra: Record<string, unknown> = {}) => ({
  parentUuid: parent === null ? null : id(parent), type: 'user', uuid: id(n),
  timestamp: new Date(Date.UTC(2026, 7, 1, 12, 0, n)).toISOString(), message: { content: [] }, ...extra,
});
function select(rows: Record<string, unknown>[], size = CLI_TRANSCRIPT_PREFILTER_BYTES + 1, disabled = false) {
  const filter = createCliTranscriptPrefilter(size, disabled);
  const lines = structuredClone(rows);
  lines.forEach((row, i) => filter.push(Buffer.from(JSON.stringify(row)), row, i));
  return filter.apply(lines as TranscriptChainLine[]);
}
const ids = (rows: TranscriptChainLine[]) => rows.map((row) => row.uuid);

describe('CLI 2.1.258 byte prefilter', () => {
  it('does not prefilter at exactly five MiB', () => {
    const rows = [node(0, null), node(1, 0), node(2, 0)];
    expect(ids(select(rows, CLI_TRANSCRIPT_PREFILTER_BYTES))).toEqual([id(0), id(1), id(2)]);
    expect(ids(select(rows))).toEqual([id(0), id(2)]);
  });

  it('retains the last-prompt chain alongside the latest branch', () => {
    const rows = [node(0, null), node(1, 0), node(2, 0), { type: 'last-prompt', leafUuid: id(1), explicit: true }];
    const selected = select(rows);
    expect(ids(selected)).toEqual([id(0), id(1), id(2), undefined]);
    expect(computeCliLoadedChain(selected).chain).toEqual([id(0), id(1)]);
  });

  it('falls back to all candidate rows for a missing parent, not a false partial chain', () => {
    expect(ids(select([node(0, null), node(1, 0), node(2, 99)]))).toEqual([id(0), id(1), id(2)]);
  });

  it('preserved compact metadata prevents branch narrowing', () => {
    const rows = [node(0, null), node(1, 0), node(2, null, {
      type: 'system', subtype: 'compact_boundary', compactMetadata: { preservedMessages: { anchorUuid: id(2), uuids: [id(0), id(1)] } },
    }), node(3, 2)];
    expect(ids(select(rows))).toEqual(rows.map((row) => row.uuid));
    expect(computeCliLoadedChain(select(rows)).chain).toEqual([id(2), id(0), id(1), id(3)]);
  });

  it('a later plain boundary resets prior nodes even when metadata kept a prior tree line', () => {
    const prior = { type: 'user', uuid: id(0), timestamp: node(0, null).timestamp, message: { content: [] } };
    const boundary = node(1, null, { type: 'system', subtype: 'compact_boundary' });
    const selected = select([prior, boundary, node(2, 1)]);
    expect(ids(selected)).toEqual([id(0), id(1), id(2)]);
    expect(selected[1].loaderReset).toBe(true);
    expect(computeCliLoadedChain(selected).chain).toEqual([id(1), id(2)]);
  });

  it('ignores a sidechain suffix but keeps uuid-less metadata', () => {
    const rows = [node(0, null), node(1, 0), node(2, 0, { isSidechain: true }), { type: 'last-prompt' }];
    expect(ids(select(rows))).toEqual([id(0), id(1), undefined]);
  });

  it('uses the top-level uuid when a nested uuid has the same timestamp shape', () => {
    const first = node(0, null, { message: { uuid: id(99), timestamp: 'later', content: [] } });
    expect(ids(select([first, node(1, 0), node(2, 0)]))).toEqual([id(0), id(2)]);
  });

  it('finds a reordered parent key without taking an escaped key from content', () => {
    const { parentUuid, ...rest } = node(1, 0);
    const reordered = { ...rest, message: { content: '\\"parentUuid\\":not-a-key' }, parentUuid };
    expect(ids(select([node(0, null), node(2, 0), reordered]))).toEqual([id(0), id(1)]);
  });

  it('disabled precompact skip still trims the last chain, without retaining the prompt branch', () => {
    const rows = [node(0, null), node(1, 0), node(2, 0), { type: 'last-prompt', leafUuid: id(1), explicit: true }];
    expect(ids(select(rows, CLI_TRANSCRIPT_PREFILTER_BYTES + 1, true))).toEqual([id(0), id(2), undefined]);
  });

  it('the disabled path retains all rows when the chosen chain owns more than half the bytes', () => {
    const rows = [node(0, null, { message: { content: 'x'.repeat(CLI_TRANSCRIPT_PREFILTER_BYTES) } }), node(1, 0), node(2, 0)];
    const bytes = Buffer.byteLength(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    expect(ids(select(rows, bytes, true))).toEqual([id(0), id(1), id(2)]);
    expect(ids(select(rows, bytes))).toEqual([id(0), id(2)]);
  });

  it('the disabled path treats a non-prefixed tree line as metadata', () => {
    const { parentUuid, ...rest } = node(1, 0);
    const rows = [node(0, null), { ...rest, parentUuid }, node(2, 0)];
    expect(ids(select(rows, CLI_TRANSCRIPT_PREFILTER_BYTES + 1, true))).toEqual([id(0), id(1), id(2)]);
  });
});

/**
 * The host-local rewind probe (src/providers/transcript-rewind-core.ts) — the
 * daemon's answer to every question rewind used to ask by shuttling the whole
 * transcript over the tunnel.
 *
 * Everything here runs against a REAL file under a temp claudeHome, because the
 * point of the module is the file: path resolution (canonical dir and the
 * unknown-cwd scan), line-by-line streaming that survives a corrupt line, and
 * the three answers (chain membership, the commit anchor, the replayed dead set)
 * coming out identical to what the server computes from the same bytes.
 *
 * The cases are chosen for the failures that shipped: a probe that reported a
 * post-compaction uuid off-chain would 409 a legal rewind; an anchor that missed
 * trailing enqueues would leave a rewound-away queued message rendering forever;
 * an unbounded dead set on a rewind-to-line-1 would put a multi-MB frame on the
 * tunnel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transcript, cutHere, lastTreeUuid, type TranscriptFixture } from '../helpers/transcript-fixtures.js';
import { encodeProjectPathCore } from '../../src/providers/session-changes-core.js';
import {
  probeTranscriptRewindHostLocal,
  commitAnchorOf,
  DEFAULT_MAX_DEAD_UUIDS,
} from '../../src/providers/transcript-rewind-core.js';

const CWD = '/proj/rewind-probe';
let claudeHome: string;

beforeEach(async () => {
  claudeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-rewind-probe-'));
});
afterEach(async () => {
  await fsp.rm(claudeHome, { recursive: true, force: true }).catch(() => { /* best-effort */ });
});

async function writeRaw(sessionId: string, text: string, cwd = CWD): Promise<void> {
  const dir = path.join(claudeHome, 'projects', encodeProjectPathCore(cwd));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), text);
}
const write = (sessionId: string, t: TranscriptFixture, cwd = CWD) => writeRaw(sessionId, t.text(), cwd);

type ProbeArgs = Parameters<typeof probeTranscriptRewindHostLocal>[0];
const probe = (sessionId: string, extra: Partial<ProbeArgs> = {}) =>
  probeTranscriptRewindHostLocal({ sessionId, cwd: CWD, claudeHome, ...extra });

describe('probeTranscriptRewindHostLocal — finding the file', () => {
  it('returns null when this host has no transcript for the session', async () => {
    expect(await probe('missing-session')).toBeNull();
  });

  it('finds the transcript by SCANNING when the cwd is unknown', async () => {
    // Hashed-cwd sessions (and a record with no cwd) have no canonical path to
    // compute, so the resolver walks the project dirs — the same fallback
    // changes.compute relies on.
    await write('s-scan', transcript().user('u1', 'first'));
    const out = await probeTranscriptRewindHostLocal({ sessionId: 's-scan', claudeHome });
    expect(out).not.toBeNull();
    expect(out!.jsonlPath.endsWith(path.join(encodeProjectPathCore(CWD), 's-scan.jsonl'))).toBe(true);
    expect(out!.size).toBeGreaterThan(0);
    expect(out!.mtimeMs).toBeGreaterThan(0);
  });

  it('reports the file stats and line count of what it actually read', async () => {
    const t = transcript().user('u1', 'first').assistant('a1', 'reply one');
    await write('s-stats', t);
    const out = (await probe('s-stats'))!;
    expect(out.lineCount).toBe(2);
    expect(out.size).toBe(Buffer.byteLength(t.text()));
  });
});

describe('probeTranscriptRewindHostLocal — chain membership (the 409 gate)', () => {
  it('says onChain for a uuid the CLI would load, and NOT for one behind the last compaction', async () => {
    // `--resume-session-at` resolves against the chain getLastSessionLog builds,
    // which terminates at the newest compact boundary: a pre-compaction uuid is
    // on disk but unresumable (the CLI exits 1), and Walnut's history view shows
    // it, so the human can click it.
    const t = transcript()
      .user('u1', 'before the compaction').assistant('a1', 'pre-compact reply')
      .compactBoundary('cb', { logicalParentUuid: 'a1' })
      .user('u2', 'after the compaction').assistant('a2', 'post-compact reply');
    await write('s-chain', t);

    expect((await probe('s-chain', { uuid: 'u2' }))!.onChain).toBe(true);
    expect((await probe('s-chain', { uuid: 'u1' }))!.onChain).toBe(false);
    // A uuid that is not in the file at all is likewise off-chain.
    expect((await probe('s-chain', { uuid: 'nope' }))!.onChain).toBe(false);
    // The leaf is the newest non-sidechain tree line, whatever was asked.
    expect((await probe('s-chain'))!.leafUuid).toBe('a2');
  });

  it('omits onChain entirely when no uuid was asked about', async () => {
    await write('s-noask', transcript().user('u1', 'first'));
    expect((await probe('s-noask'))!.onChain).toBeUndefined();
  });

  it('keeps the DAG recovery of a parallel tool call (tool_result lines stay on chain)', async () => {
    // Streaming writes one assistant line per content block, so N parallel
    // tool_uses share ONE message.id and each tool_result parents onto its own
    // one-block assistant. The slimmed lines must keep enough shape for that
    // recovery, or the probe would disagree with the server's own parse.
    const t = transcript()
      .user('u1', 'run both')
      .toolUse('x1', 'tool-1', { msgId: 'msg_par' })
      .toolUse('x2', 'tool-2', { msgId: 'msg_par' })
      .toolResult('r1', 'tool-1', 'output one', { parent: 'x1' })
      .toolResult('r2', 'tool-2', 'output two', { parent: 'x2' })
      .from('r2').assistant('done', 'both finished');
    await write('s-par', t);

    // r1 hangs off the sibling the single-parent walk drops; recovery puts it back.
    expect((await probe('s-par', { uuid: 'r1' }))!.onChain).toBe(true);
    expect((await probe('s-par', { uuid: 'x1' }))!.onChain).toBe(true);
  });
});

describe('probeTranscriptRewindHostLocal — the commit anchor', () => {
  it('reports the LAST tree line plus the enqueue keys trailing it', async () => {
    const t = transcript().user('u1', 'first').user('u2', 'second').user('u3', 'third');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-anchor', content: 'queued mid-turn' });
    await write('s-anchor', t);

    const out = (await probe('s-anchor'))!;
    expect(out.lastUuidAtCommit).toBe('u3');
    expect(out.lastUuidAtCommit).toBe(lastTreeUuid(t.lines));
    expect(out.trailingQueueKeys).toHaveLength(1);
    expect(out.trailingQueueKeys[0].endsWith(' queued mid-turn')).toBe(true);
  });

  it('reports a null anchor (and no keys) for a transcript with no tree line', async () => {
    const t = transcript();
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-noanchor', content: 'orphan enqueue' });
    await write('s-noanchor', t);

    const out = (await probe('s-noanchor'))!;
    expect(out.lastUuidAtCommit).toBeNull();
    // No anchor means no "past the anchor" — an unanchored enqueue is not trailing.
    expect(out.trailingQueueKeys).toEqual([]);
  });

  it('commitAnchorOf is the SAME helper the server fallback calls', async () => {
    // One implementation, or a cut records an anchor the reader can't reproduce.
    const t = transcript().user('u1', 'first').assistant('a1', 'reply');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-same', content: 'trailing' });
    await write('s-same', t);

    const out = (await probe('s-same'))!;
    const local = commitAnchorOf(t.lines);
    expect(out.lastUuidAtCommit).toBe(local.lastUuidAtCommit);
    expect(out.trailingQueueKeys).toEqual(local.trailingQueueKeys);
  });
});

describe('probeTranscriptRewindHostLocal — replaying recorded cuts', () => {
  it('returns the dead tree uuids and the dead queue identity keys', async () => {
    const t = transcript()
      .user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second')
      .assistant('a2', 'ABANDONED reply two');
    t.raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-cuts', content: 'ABANDONED ask', timestamp: '2026-08-30T00:00:09.000Z' });
    t.raw({ type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: '2026-08-30T00:00:10.000Z', message: { role: 'user', content: 'ABANDONED third' } });
    const cut = cutHere(t, 'u2');
    t.from('u2').user('u2b', 'second take');
    await write('s-cuts', t);

    const out = (await probe('s-cuts', { cuts: [cut] }))!;
    expect(out.deadUuids).toEqual(['a2', 'u3']);
    expect(out.queueDeadKeys).toHaveLength(1);
    expect(out.queueDeadKeys![0].endsWith(' ABANDONED ask')).toBe(true);
    expect(out.skippedCuts).toEqual([]);
    expect(out.truncated).toBeUndefined();
  });

  it('reports an empty dead set (not null) when the cut region holds nothing yet', async () => {
    // The death window: the rewind point IS still the file tip.
    const t = transcript().user('u1', 'first').user('u2', 'second');
    await write('s-empty', t);

    const out = (await probe('s-empty', { cuts: [cutHere(t, 'u2')] }))!;
    expect(out.deadUuids).toEqual([]);
    expect(out.queueDeadKeys).toEqual([]);
  });

  it('omits the dead set entirely when no cuts were asked about', async () => {
    await write('s-nocuts', transcript().user('u1', 'first'));
    const out = (await probe('s-nocuts'))!;
    expect(out.deadUuids).toBeUndefined();
    expect(out.queueDeadKeys).toBeUndefined();
    expect(out.skippedCuts).toBeUndefined();
  });

  it('REPORTS a cut it refused to apply instead of warning (the daemon has no logger)', async () => {
    const t = transcript().user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second');
    await write('s-skip', t);

    const out = (await probe('s-skip', {
      cuts: [{ uuid: '0199dead-0000-4000-8000-000000000000', lastUuidAtCommit: 'u2' }],
    }))!;
    expect(out.deadUuids).toEqual([]);
    expect(out.skippedCuts).toEqual([{
      cutUuid: '0199dead-0000-4000-8000-000000000000',
      lastUuidAtCommit: 'u2',
      cutFound: false,
      anchorFound: true,
      cutDuplicated: false,
      anchorDuplicated: false,
    }]);
  });

  it('caps a runaway dead set: truncated, and NOTHING reported', async () => {
    // A rewind to the first line of a very long transcript would otherwise put
    // one uuid per line on the tunnel. Over the cap the caller serves unfiltered
    // and says so, which is the same documented degrade as an unresolvable cut.
    const t = transcript().user('u1', 'first');
    for (let i = 0; i < 5; i++) t.assistant(`a${i}`, `ABANDONED ${i}`);
    t.raw({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-cap', content: 'ABANDONED ask', timestamp: '2026-08-30T00:01:00.000Z' });
    const cut = cutHere(t, 'u1');
    t.from('u1').user('u2', 'the live take');
    await write('s-cap', t);

    const capped = (await probe('s-cap', { cuts: [cut], maxDeadUuids: 2 }))!;
    expect(capped.truncated).toBe(true);
    expect(capped.deadUuids).toEqual([]);
    expect(capped.queueDeadKeys).toEqual([]);
    // Under the real cap the same file answers in full.
    const full = (await probe('s-cap', { cuts: [cut] }))!;
    expect(full.truncated).toBeUndefined();
    expect(full.deadUuids).toHaveLength(5);
    expect(DEFAULT_MAX_DEAD_UUIDS).toBe(200_000);
  });
});

describe('the daemon bundle stays clean', () => {
  it('neither the probe nor the chain machinery imports the server logger', async () => {
    // Both files are compiled into the daemon binary AND shipped as the
    // transcript-rewind-core.cjs sidecar, where `../logging` cannot resolve. A
    // re-added logger import would only be noticed at deploy time, on a host,
    // which is why this is a source-level ratchet.
    const root = path.resolve(__dirname, '../..');
    for (const rel of ['src/core/transcript-chain.ts', 'src/providers/transcript-rewind-core.ts']) {
      const src = await fsp.readFile(path.join(root, rel), 'utf-8');
      expect(src, `${rel} must not import the logger`).not.toMatch(/^import .*logging\/index\.js/m);
    }
  });
});

describe('probeTranscriptRewindHostLocal — junk tolerance', () => {
  it('skips a corrupt line and still answers about the rest of the file', async () => {
    // A transcript being appended to can end mid-line, and a crashed write can
    // leave garbage in the middle. Neither may take the whole answer down.
    const t = transcript().user('u1', 'first').assistant('a1', 'reply one').user('u2', 'second');
    const lines = t.text().trimEnd().split('\n');
    const text = [lines[0], '{"type":"user","uuid":"trunc', lines[1], 'not json at all', lines[2]].join('\n') + '\n';
    await writeRaw('s-junk', text);

    const out = (await probe('s-junk', { uuid: 'u2', cuts: [cutHere(t, 'u1')] }))!;
    expect(out.lineCount).toBe(5);            // every non-empty line was read
    expect(out.onChain).toBe(true);           // …and the tree still resolves
    expect(out.lastUuidAtCommit).toBe('u2');
    expect(out.deadUuids).toEqual(['a1', 'u2']);
  });

  it('handles an empty transcript without throwing', async () => {
    await writeRaw('s-blank', '');
    const out = (await probe('s-blank', { uuid: 'u1', cuts: [{ uuid: 'u1', lastUuidAtCommit: 'u2' }] }))!;
    expect(out.lineCount).toBe(0);
    expect(out.leafUuid).toBeNull();
    expect(out.lastUuidAtCommit).toBeNull();
    expect(out.onChain).toBe(false);
    expect(out.deadUuids).toEqual([]);
    expect(out.skippedCuts).toHaveLength(1);
  });
});

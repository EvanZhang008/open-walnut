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
  resumeAnchorBefore,
  resumeFactsOf,
  targetQueueKeys,
  DEFAULT_MAX_DEAD_UUIDS,
  type RewindTranscriptLine,
} from '../../src/providers/transcript-rewind-core.js';
import { computeCliLoadedChain } from '../../src/core/transcript-chain.js';

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

describe('probeTranscriptRewindHostLocal — the resume anchor (rewind is EXCLUSIVE)', () => {
  /** The one-line reason this whole block exists: `--resume-session-at` keeps the
   *  message it names, and a rewind means "back to before I sent that". The CLI's
   *  own /rewind slices exclusively and puts the message back in the input box, so
   *  the flag is handed the message BEFORE the target. Reported live: the rewound
   *  message stayed in the model's context and the human's edit landed after it. */
  it('answers with the chain message just BEFORE the target', async () => {
    const t = transcript()
      .user('u1', 'first ask').assistant('a1', 'first reply')
      .user('u2', 'second ask').assistant('a2', 'second reply');
    await write('s-anchor-basic', t);

    const out = (await probe('s-anchor-basic', { uuid: 'u2' }))!;
    expect(out.onChain).toBe(true);
    expect(out.resumeAnchorUuid).toBe('a1');
  });

  it('reports null when the target is the FIRST message the CLI would load', async () => {
    // Nothing before it to resume at, so the caller refuses instead of shipping
    // a flag value the CLI would reject.
    await write('s-anchor-first', transcript().user('u1', 'first ask').assistant('a1', 'reply'));
    expect((await probe('s-anchor-first', { uuid: 'u1' }))!.resumeAnchorUuid).toBeNull();
  });

  it('omits the anchor for an OFF-chain target (that refusal comes first)', async () => {
    const t = transcript()
      .user('u1', 'pre-compact').assistant('a1', 'reply')
      .compactBoundary('cb', { logicalParentUuid: 'a1' })
      .user('u2', 'post-compact');
    await write('s-anchor-offchain', t);

    const out = (await probe('s-anchor-offchain', { uuid: 'u1' }))!;
    expect(out.onChain).toBe(false);
    expect(out.resumeAnchorUuid).toBeUndefined();
  });

  it('takes the compact boundary itself as the anchor for the first post-compact ask', async () => {
    const t = transcript()
      .user('u1', 'pre-compact')
      .compactBoundary('cb', { logicalParentUuid: 'u1' })
      .user('u2', 'post-compact').assistant('a2', 'reply');
    await write('s-anchor-boundary', t);

    expect((await probe('s-anchor-boundary', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('cb');
  });

  // ── The dangerous direction ── the CLI resolves the flag against the messages
  // it has ALREADY deserialized, and deserialization DROPS some assistant
  // messages. Naming one of those makes the CLI exit 1 at respawn, i.e. a dead
  // session behind a committed rewind. Each case below is one of the three
  // filters (utils/messages.ts), and the answer must skip past the casualty.
  it('skips an assistant message whose only tool_use never got a result', async () => {
    // filterUnresolvedToolUses — the shape a turn interrupted mid-tool-call leaves.
    const t = transcript()
      .user('u1', 'first ask').assistant('a1', 'first reply')
      .toolUse('x1', 'tool-1', { msgId: 'msg_orphan' })
      .from('x1').user('u2', 'second ask');
    await write('s-anchor-unresolved', t);

    expect((await probe('s-anchor-unresolved', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('a1');
  });

  it('keeps a tool_use assistant whose result DID land', async () => {
    const t = transcript()
      .user('u1', 'first ask')
      .toolUse('x1', 'tool-1', { msgId: 'msg_ok' })
      .toolResult('r1', 'tool-1', 'output', { parent: 'x1' })
      .from('r1').user('u2', 'second ask');
    await write('s-anchor-resolved', t);

    // r1 (the tool_result user line) is itself the nearest survivor.
    expect((await probe('s-anchor-resolved', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('r1');
  });

  it('skips an orphaned thinking-only assistant message', async () => {
    // filterOrphanedThinkingOnlyMessages — a turn cancelled during thinking.
    const t = transcript()
      .user('u1', 'first ask').assistant('a1', 'first reply')
      .meta({
        type: 'assistant', uuid: 'think1', parentUuid: 'a1',
        message: { id: 'msg_think', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      })
      .from('think1').user('u2', 'second ask');
    await write('s-anchor-thinking', t);

    expect((await probe('s-anchor-thinking', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('a1');
  });

  it('keeps a thinking-only message whose sibling by message.id carries real content', async () => {
    // The CLI merges those two by message.id, so it does NOT drop this one.
    const t = transcript()
      .user('u1', 'first ask')
      .meta({
        type: 'assistant', uuid: 'think2', parentUuid: 'u1',
        message: { id: 'msg_pair', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
      })
      .from('think2').assistant('a1', 'the answer', { msgId: 'msg_pair' })
      .user('u2', 'second ask');
    await write('s-anchor-thinking-pair', t);

    expect((await probe('s-anchor-thinking-pair', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('a1');
    // And the thinking line itself is a legal anchor for the message after it.
    expect((await probe('s-anchor-thinking-pair', { uuid: 'a1' }))!.resumeAnchorUuid).toBe('think2');
  });

  it('skips a whitespace-only assistant message', async () => {
    // filterWhitespaceOnlyAssistantMessages — "\n\n" emitted before a cancelled turn.
    const t = transcript()
      .user('u1', 'first ask').assistant('a1', 'first reply')
      .meta({
        type: 'assistant', uuid: 'blank', parentUuid: 'a1',
        message: { id: 'msg_blank', role: 'assistant', content: [{ type: 'text', text: '\n\n' }] },
      })
      .from('blank').user('u2', 'second ask');
    await write('s-anchor-blank', t);

    expect((await probe('s-anchor-blank', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('a1');
  });

  it('skips a candidate whose uuid appears TWICE in the file', async () => {
    // This uuid becomes the recorded cut's start, and computeRewindDeadSet
    // refuses a duplicated cut anchor — taking it would leave the abandoned
    // branch on screen. (Real source: a preserved-segment compact re-appends
    // earlier lines under their original uuids.)
    const t = transcript()
      .user('u1', 'first ask').assistant('a1', 'first reply')
      .meta({
        type: 'assistant', uuid: 'a1', parentUuid: 'u1',
        message: { id: 'msg_dup', role: 'assistant', content: [{ type: 'text', text: 'duplicate line' }] },
      })
      .from('a1').user('u2', 'second ask');
    await write('s-anchor-dup', t);

    expect((await probe('s-anchor-dup', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('u1');
  });

  it('resumeAnchorBefore is the SAME helper the server fallback calls', async () => {
    // The server reads the file itself on a host whose daemon predates the
    // capability; both sides must name the same anchor or a rewind would mean
    // two different things depending on the daemon's age.
    const t = transcript()
      .user('u1', 'first ask').assistant('a1', 'first reply').user('u2', 'second ask');
    await write('s-anchor-parity', t);
    const lines = t.text().split('\n').filter(Boolean).map((l) => {
      const raw = JSON.parse(l) as Record<string, unknown>;
      const resume = resumeFactsOf(raw);
      return resume ? { ...raw, resume } : raw;
    }) as RewindTranscriptLine[];

    const chain = computeCliLoadedChain(lines).chain;
    expect(resumeAnchorBefore(lines, chain, 'u2').uuid).toBe('a1');
    expect((await probe('s-anchor-parity', { uuid: 'u2' }))!.resumeAnchorUuid).toBe('a1');
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

describe('the rewound message\'s own enqueue echo (targetQueueKeys)', () => {
  // Every message Walnut sends reaches the CLI through the FIFO, so the CLI logs
  // a queue-operation enqueue for it and the real user line a couple of lines
  // later; the history parser shows ONE row. The enqueue is written when the
  // message ARRIVES, so it sits BEFORE the user line — and before the cut anchor,
  // outside the (cut, last] region. Measured live on 2026-09-03: kill the user
  // line without this and the rewound message is STILL on screen, re-rendered
  // from its orphaned enqueue.
  it('claims the enqueue that sits just before the target user line', async () => {
    const t = transcript().user('u1', 'first').assistant('a1', 'ok');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-echo', content: 'second ask' });
    t.meta({ type: 'queue-operation', operation: 'dequeue', sessionId: 's-echo' });
    // The CLI writes a system line between the enqueue and the user line, and the
    // system line is what a rewind resumes AT — which is exactly why the enqueue
    // ends up on the far side of the cut.
    t.from('a1').user('u2', 'second ask');
    await write('s-echo', t);

    const out = (await probe('s-echo', { uuid: 'u2' }))!;
    expect(out.targetQueueKeys).toHaveLength(1);
    expect(out.targetQueueKeys![0].endsWith(' second ask')).toBe(true);
  });

  it('claims the whole RUN when the CLI drained several queued sends into one prompt', async () => {
    const t = transcript().user('u1', 'first').assistant('a1', 'ok');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-batch', content: 'part one' });
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-batch', content: 'part two' });
    t.from('a1').user('u2', 'part one\npart two');
    await write('s-batch', t);

    const out = (await probe('s-batch', { uuid: 'u2' }))!;
    expect(out.targetQueueKeys).toHaveLength(2);
    expect(out.targetQueueKeys!.map((k) => k.split(' ').pop())).toEqual(['one', 'two']);
  });

  it('claims the CLOSEST match, leaving an identical earlier send\'s row alive', async () => {
    // "continue" twice: the earlier enqueue belongs to a LIVE row, and suppressing
    // it by text alone would delete a message the human never rewound.
    const t = transcript();
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-dup', content: 'continue' });
    t.from(null).user('u1', 'continue');
    t.from('u1').assistant('a1', 'ok');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-dup', content: 'continue' });
    t.from('a1').user('u2', 'continue');
    await write('s-dup', t);

    const out = (await probe('s-dup', { uuid: 'u2' }))!;
    expect(out.targetQueueKeys).toHaveLength(1);
    // The SECOND enqueue (the one whose timestamp is later), not the first.
    const enqueues = t.lines.filter((l) => (l as { type?: string }).type === 'queue-operation');
    const lastTs = (enqueues[enqueues.length - 1] as { timestamp?: string }).timestamp;
    expect(out.targetQueueKeys![0].startsWith(lastTs!)).toBe(true);
  });

  it('claims nothing when the target has no enqueue echo (a message typed into the CLI itself)', async () => {
    const t = transcript().user('u1', 'first').assistant('a1', 'ok').user('u2', 'second');
    await write('s-noecho', t);
    expect((await probe('s-noecho', { uuid: 'u2' }))!.targetQueueKeys).toEqual([]);
  });

  it('is omitted entirely when no uuid was asked about', async () => {
    const t = transcript().user('u1', 'first');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-nouuid', content: 'first' });
    await write('s-nouuid', t);
    expect((await probe('s-nouuid'))!.targetQueueKeys).toBeUndefined();
  });

  it('targetQueueKeys is the SAME helper the server fallback calls on raw lines', async () => {
    // The daemon keeps only the ASKED-ABOUT line's text (slimming is what lets a
    // whale transcript fit in memory); the server parses raw lines and reads the
    // text off message.content. Both must claim the same key.
    const t = transcript().user('u1', 'first').assistant('a1', 'ok');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: 's-parity', content: 'second ask' });
    t.from('a1').user('u2', 'second ask');
    await write('s-parity', t);

    const out = (await probe('s-parity', { uuid: 'u2' }))!;
    const local = targetQueueKeys(t.lines as RewindTranscriptLine[], 'u2');
    expect(out.targetQueueKeys).toEqual(local);
    expect(local).toHaveLength(1);
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

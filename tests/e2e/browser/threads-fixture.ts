/**
 * Question stack + tree drawer fixtures (slice 1). PURE: builds transcripts,
 * records and tasks as data; test-server.ts writes them, and the unit tests
 * (tests/web/thread-meta.test.ts) read the SAME data, so the counts a unit test
 * pins are exactly the counts the browser specs see (C72).
 *
 * Sessions:
 *  - pw-threads-dense-session: 30 questions over 5 levels, 10 pins, long
 *    answers, a meta mix (open / resolved / suggested / hidden) plus 5 older
 *    questions without meta, and one answer that opens with a preamble.
 *  - pw-threads-ai-session: plain root conversation that can SEND (the server's
 *    AI naming stub is keyed on the `pw-threads-ai-` prefix).
 *  - pw-threads-failed-session: one question whose turn ended in an API error,
 *    and one parked follow-up (queue row), no answer text after either.
 *  - pw-threads-rewritten-session: a question whose parent answer no longer
 *    holds its quoted passage.
 * All text is invented, neutral filler.
 */

export const DENSE_SESSION = 'pw-threads-dense-session';
export const AI_SESSION = 'pw-threads-ai-session';
export const FAILED_SESSION = 'pw-threads-failed-session';
export const REWRITTEN_SESSION = 'pw-threads-rewritten-session';
/** Sends, and its mock CLI turns are written into its transcript (the only
 *  fixture session that grows): a question asked here survives a reload (N37). */
export const RELOAD_SESSION = 'pw-threads-reload-session';
/** Prefix the server's thread AI stub answers for (P2 reads the env var). */
export const THREAD_AI_STUB_PREFIX = 'pw-threads-ai-';
/** An existing fixture session with no thread anchors at all. */
export const NO_THREAD_SESSION = 'pw-outline-window-session';

export interface FixtureAnchor { msgId: string; parent: string; quote?: { exact: string; prefix?: string; suffix?: string }; source: 'selection' | 'sticky' | 'manual'; at: string }
export interface FixtureMeta { headId: string; status: 'open' | 'suggested' | 'resolved' | 'older'; title?: string; titleSource?: 'ai' | 'user'; titleState?: 'pending' | 'done' | 'failed' | 'unavailable'; question?: string; takeaway?: string; takeawaySource?: 'fallback' | 'user' | 'ai'; takeawayState?: 'pending' | 'done' | 'failed'; hidden?: boolean; suggestDismissed?: boolean; updatedAt: string }
export interface FixturePin { msgId: string; label: string; role: 'user' | 'assistant' | 'system'; pinnedAt: string; timestamp?: string; id?: string; quote?: { exact: string } }
export interface FixtureRow { role: 'user' | 'assistant'; uuid: string; text: string; isApiError?: boolean }

export interface ThreadsFixtureSession {
  sessionId: string;
  taskId: string;
  title: string;
  rows: FixtureRow[];
  threadAnchors: FixtureAnchor[];
  threadMeta: FixtureMeta[];
  pinnedMessages: FixturePin[];
  /** Parked queue rows for this session (session-message-queue.json). */
  parked: Array<{ id: string; message: string; userUuid: string }>;
}

// ── Deterministic neutral text ──

const WORDS = [
  'the', 'index', 'keeps', 'a', 'small', 'buffer', 'of', 'recent', 'entries', 'so', 'reads', 'stay', 'cheap',
  'while', 'writes', 'batch', 'into', 'larger', 'pages', 'each', 'page', 'carries', 'its', 'own', 'checksum',
  'and', 'a', 'version', 'number', 'that', 'lets', 'the', 'reader', 'skip', 'stale', 'copies', 'when', 'two',
  'workers', 'race', 'on', 'one', 'slot', 'order', 'matters', 'more', 'than', 'speed', 'here', 'because',
  'a', 'late', 'flush', 'can', 'hide', 'an', 'earlier', 'update', 'garden', 'river', 'lantern', 'marina',
  'meadow', 'pebble', 'orchard', 'window', 'ladder', 'kettle', 'compass', 'canvas', 'marble',
];

/** Tiny LCG so every run builds byte-identical text. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function sentence(next: () => number, n = 14): string {
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(WORDS[Math.floor(next() * WORDS.length)]);
  const s = w.join(' ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/** About `words` words of prose in paragraphs of 5 sentences. */
export function filler(seed: number, words: number): string {
  const next = rng(seed);
  const paras: string[] = [];
  let count = 0;
  while (count < words) {
    const ss: string[] = [];
    for (let i = 0; i < 5 && count < words; i++) { ss.push(sentence(next)); count += 14; }
    paras.push(ss.join(' '));
  }
  return paras.join('\n\n');
}

/** A transcript uuid: `<prefix><nn>-<kind>-4aaa-8bbb-<12 digits>`. */
export function fxUuid(prefix: string, n: number, kind: 'u' | 'a'): string {
  const hex = n.toString(16).padStart(2, '0').slice(-2);
  return `${prefix}${hex}-${kind === 'u' ? '1111' : '2222'}-4aaa-8bbb-${String(n).padStart(12, '0')}`;
}

// ── Dense session: 30 questions, 5 levels ──

const NOUNS = ['lantern', 'orchard', 'kettle', 'compass', 'ladder', 'meadow', 'pebble', 'canvas', 'marble', 'river',
  'window', 'garden', 'buffer', 'ledger', 'anchor', 'beacon', 'candle', 'cellar', 'chisel', 'harvest',
  'island', 'jigsaw', 'kernel', 'lattice', 'mosaic', 'needle', 'paddle', 'quarry', 'saddle', 'tunnel'];

/** [question, parent] where parent is a root turn `R<n>` or another question. */
const DENSE_TREE: ReadonlyArray<readonly [string, string]> = [
  ['Q1', 'R0'], ['Q11', 'Q1'], ['Q21', 'Q11'], ['Q26', 'Q21'], ['Q29', 'Q26'], ['Q22', 'Q11'], ['Q12', 'Q1'],
  ['Q2', 'R0'], ['Q13', 'Q2'],
  ['Q3', 'R1'], ['Q14', 'Q3'], ['Q4', 'R1'],
  ['Q5', 'R2'], ['Q15', 'Q5'], ['Q23', 'Q15'], ['Q27', 'Q23'], ['Q30', 'Q27'], ['Q16', 'Q5'],
  ['Q6', 'R3'], ['Q17', 'Q6'], ['Q24', 'Q17'], ['Q28', 'Q24'], ['Q7', 'R3'],
  ['Q8', 'R4'], ['Q18', 'Q8'],
  ['Q9', 'R5'], ['Q19', 'Q9'], ['Q25', 'Q19'], ['Q10', 'R5'], ['Q20', 'Q10'],
];
const ROOT_TURNS = 6;
/** Questions with a second (sticky follow-up) turn right after their first answer. */
const FOLLOW_UPS = new Set(['Q1', 'Q5']);
const OLDER = new Set(['Q4', 'Q7', 'Q13', 'Q16', 'Q20']);
const RESOLVED = new Set(['Q2', 'Q3', 'Q10', 'Q12', 'Q14', 'Q18', 'Q25']);
const SUGGESTED = new Set(['Q6', 'Q9', 'Q15', 'Q28']);
const HIDDEN_HEADS = new Set(['Q8', 'Q23', 'Q29']);
const AI_TITLES: Record<string, string> = {
  Q1: 'Buffer flush order', Q2: 'Checksum per page', Q6: 'Late flush risk', Q9: 'Version skip rule',
  Q10: 'Batching writes', Q12: 'Slot race outcome', Q15: 'Stale copy detection', Q17: 'Reader skip cost',
};
/** The preamble answer: one paragraph opening with `Good question.` */
export const DENSE_PREAMBLE_QUESTION = 'Q22';
export const DENSE_PREAMBLE_TAKEAWAY = 'The reader compares the page version with the index before it trusts any cached copy of the entry.';

/** Expected counts on the dense fixture (spec 7.3), pinned by unit + browser tests. */
export const DENSE_EXPECTED_COUNTS = { open: 9, suggested: 4, done: 6, older: 5, all: 24, pinned: 8 } as const;

export function densePassage(q: string): string {
  const i = Number(q.slice(1)) - 1;
  return `Point ${i + 1}: the ${NOUNS[i]} pass reads the ${NOUNS[(i + 7) % NOUNS.length]} before it writes.`;
}

/** Insert each child's passage as its own sentence inside the parent answer. */
function answerWith(seed: number, words: number, passages: string[]): string {
  const paras = filler(seed, words).split('\n\n');
  passages.forEach((p, k) => {
    const at = Math.min(paras.length - 1, 1 + k * 2);
    paras[at] = `${p} ${paras[at]}`;
  });
  return paras.join('\n\n');
}

export interface DenseIds {
  /** Question id (`Q7`) to its head user row uuid. */
  head: Record<string, string>;
  /** Question id (or `R<n>`) to the uuid of its FIRST answer row. */
  answer: Record<string, string>;
}

/** Build the dense session. Deterministic for a given `nowMs`. */
export function buildDenseSession(nowMs: number): ThreadsFixtureSession & { ids: DenseIds } {
  const P = '0199f1';
  const iso = (k: number) => new Date(nowMs - 3_600_000 + k * 1000).toISOString();
  const rows: FixtureRow[] = [];
  const anchors: FixtureAnchor[] = [];
  const ids: DenseIds = { head: {}, answer: {} };
  let n = 0;
  const childrenOf = (p: string) => DENSE_TREE.filter(([, parent]) => parent === p).map(([q]) => q);
  const turn = (userText: string, answerText: string): { u: string; a: string } => {
    n += 1;
    const u = fxUuid(P, n, 'u');
    const a = fxUuid(P, n, 'a');
    rows.push({ role: 'user', uuid: u, text: userText }, { role: 'assistant', uuid: a, text: answerText });
    return { u, a };
  };
  const answerFor = (id: string, seed: number, words: number) => answerWith(seed, words, childrenOf(id).map(densePassage));

  const emitQuestion = (q: string, parent: string) => {
    const passage = densePassage(q);
    const i = Number(q.slice(1));
    const question = `What does point ${i} change for the reader?`;
    const words = i <= 10 ? 1500 : 300;
    const answer = q === DENSE_PREAMBLE_QUESTION
      ? `Good question. ${DENSE_PREAMBLE_TAKEAWAY} ${filler(900 + i, 60).replace(/\n\n/g, ' ')}`
      : answerFor(q, 100 + i, words);
    const t = turn(`> ${passage}\n\n${question}`, answer);
    ids.head[q] = t.u;
    ids.answer[q] = t.a;
    anchors.push({ msgId: t.u, parent: ids.answer[parent], quote: { exact: passage }, source: 'selection', at: iso(n) });
    if (FOLLOW_UPS.has(q)) {
      const f = turn(`And how does that interact with the ${NOUNS[i % NOUNS.length]} step?`, filler(500 + i, 300));
      anchors.push({ msgId: f.u, parent: ids.answer[parent], quote: { exact: passage }, source: 'sticky', at: iso(n) });
    }
    for (const c of childrenOf(q)) emitQuestion(c, q);
  };

  for (let r = 0; r < ROOT_TURNS; r++) {
    const t = turn(`Walk me through part ${r + 1} of the storage notes.`, answerFor(`R${r}`, 10 + r, 1500));
    ids.answer[`R${r}`] = t.a;
    for (const c of childrenOf(`R${r}`)) emitQuestion(c, `R${r}`);
  }

  const threadMeta: FixtureMeta[] = [];
  for (const [q] of DENSE_TREE) {
    if (OLDER.has(q)) continue;
    const status = RESOLVED.has(q) ? 'resolved' : SUGGESTED.has(q) ? 'suggested' : 'open';
    const m: FixtureMeta = { headId: ids.head[q], status, updatedAt: iso(200) };
    if (AI_TITLES[q]) Object.assign(m, { title: AI_TITLES[q], titleSource: 'ai', titleState: 'done' });
    else if (q === 'Q3') Object.assign(m, { title: 'My note on versions', titleSource: 'user', titleState: 'done' });
    else m.titleState = 'failed';
    m.question = `What does point ${q.slice(1)} change for the reader?`;
    if (status === 'resolved') Object.assign(m, { takeaway: `Point ${q.slice(1)} keeps reads ordered before writes land.`, takeawaySource: q === 'Q14' ? 'user' : 'ai', takeawayState: 'done' });
    if (HIDDEN_HEADS.has(q)) m.hidden = true;
    threadMeta.push(m);
  }

  const pin = (key: string, quote?: string): FixturePin => ({
    msgId: ids.answer[key], label: quote ?? `Answer ${key}`, role: 'assistant', pinnedAt: iso(300),
    id: `pin-${key.toLowerCase()}${quote ? '-q' : ''}`, ...(quote ? { quote: { exact: quote } } : {}),
  });
  const pinnedMessages: FixturePin[] = [
    pin('R0'), pin('R2', densePassage('Q5')), pin('Q1', densePassage('Q11')), pin('Q5'),
    pin('Q11', densePassage('Q21')), pin('Q14'), pin('Q21', densePassage('Q26')), pin('Q9'),
    pin('Q18'), pin('Q27', densePassage('Q30')),
  ];
  return {
    sessionId: DENSE_SESSION, taskId: 'pw-task-threads-dense', title: 'Threads dense fixture session',
    rows, threadAnchors: anchors, threadMeta, pinnedMessages, parked: [], ids,
  };
}

// ── Small sessions ──

function simpleTurns(prefix: string, turns: Array<[string, string]>): FixtureRow[] {
  return turns.flatMap(([q, a], k) => [
    { role: 'user' as const, uuid: fxUuid(prefix, k + 1, 'u'), text: q },
    { role: 'assistant' as const, uuid: fxUuid(prefix, k + 1, 'a'), text: a },
  ]);
}

export const AI_PASSAGE = 'The compaction step merges small pages into one larger page once a minute.';

export function buildAiSession(): ThreadsFixtureSession {
  const rows = simpleTurns('0199f2', [
    ['Explain how the storage layer batches writes.', `${filler(41, 200)}\n\n${AI_PASSAGE} ${filler(42, 120)}`],
    ['What happens when two workers race on one slot?', filler(43, 260)],
    ['How should the reader treat stale copies?', filler(44, 240)],
  ]);
  return {
    sessionId: AI_SESSION, taskId: 'pw-task-threads-ai', title: 'Threads AI fixture session',
    rows, threadAnchors: [], threadMeta: [], pinnedMessages: [], parked: [],
  };
}

export const RELOAD_PASSAGE = 'The flush worker drains the queue before it rotates the log file.';

export function buildReloadSession(): ThreadsFixtureSession {
  const rows = simpleTurns('0199f7', [
    ['Explain when the log rotates.', `${filler(61, 180)}\n\n${RELOAD_PASSAGE} ${filler(62, 120)}`],
    ['What does the reader do after a rotation?', filler(63, 220)],
  ]);
  return {
    sessionId: RELOAD_SESSION, taskId: 'pw-task-threads-reload', title: 'Threads reload fixture session',
    rows, threadAnchors: [], threadMeta: [], pinnedMessages: [], parked: [],
  };
}

export const FAILED_PASSAGES = [
  'The retry loop doubles its wait after every failed flush.',
  'The ledger keeps one line per committed batch.',
] as const;
export const FAILED_ERROR_TEXT = 'API Error: 529 Overloaded. The service is busy, try again later.';
export const PARKED_FOLLOW_UP = 'Can you expand on the second half of that?';

export function buildFailedSession(nowMs: number): ThreadsFixtureSession {
  const P = '0199f3';
  const at = new Date(nowMs - 600_000).toISOString();
  const rootAnswer = `${filler(51, 160)}\n\n${FAILED_PASSAGES[0]} ${filler(52, 80)}\n\n${FAILED_PASSAGES[1]} ${filler(53, 80)}`;
  const rows: FixtureRow[] = [
    { role: 'user', uuid: fxUuid(P, 1, 'u'), text: 'Summarize the retry notes.' },
    { role: 'assistant', uuid: fxUuid(P, 1, 'a'), text: rootAnswer },
    { role: 'user', uuid: fxUuid(P, 2, 'u'), text: `> ${FAILED_PASSAGES[0]}\n\nWhy does the wait double?` },
    { role: 'assistant', uuid: fxUuid(P, 2, 'a'), text: FAILED_ERROR_TEXT, isApiError: true },
    { role: 'user', uuid: fxUuid(P, 3, 'u'), text: `> ${FAILED_PASSAGES[1]}\n\nWhat goes on each line?` },
    { role: 'assistant', uuid: fxUuid(P, 3, 'a'), text: filler(54, 120) },
  ];
  const parent = fxUuid(P, 1, 'a');
  const parkedUuid = fxUuid(P, 4, 'u');
  return {
    sessionId: FAILED_SESSION, taskId: 'pw-task-threads-failed', title: 'Threads failed fixture session',
    rows,
    threadAnchors: [
      { msgId: fxUuid(P, 2, 'u'), parent, quote: { exact: FAILED_PASSAGES[0] }, source: 'selection', at },
      { msgId: fxUuid(P, 3, 'u'), parent, quote: { exact: FAILED_PASSAGES[1] }, source: 'selection', at },
      { msgId: parkedUuid, parent, quote: { exact: FAILED_PASSAGES[1] }, source: 'sticky', at },
    ],
    threadMeta: [
      { headId: fxUuid(P, 2, 'u'), status: 'open', titleState: 'failed', question: 'Why does the wait double?', updatedAt: at },
      { headId: fxUuid(P, 3, 'u'), status: 'open', titleState: 'failed', question: 'What goes on each line?', updatedAt: at },
    ],
    pinnedMessages: [],
    parked: [{ id: 'pw-threads-failed-parked-1', message: PARKED_FOLLOW_UP, userUuid: parkedUuid }],
  };
}

export const REWRITTEN_LOST_PASSAGE = 'The original wording of this answer said the cache never expires.';

export function buildRewrittenSession(nowMs: number): ThreadsFixtureSession {
  const P = '0199f4';
  const at = new Date(nowMs - 600_000).toISOString();
  const rows = simpleTurns(P, [
    ['Describe the cache expiry rules.', filler(61, 220)],
    [`> ${REWRITTEN_LOST_PASSAGE}\n\nIs that still true?`, filler(62, 140)],
  ]);
  return {
    sessionId: REWRITTEN_SESSION, taskId: 'pw-task-threads-rewritten', title: 'Threads rewritten fixture session',
    rows,
    threadAnchors: [{ msgId: fxUuid(P, 2, 'u'), parent: fxUuid(P, 1, 'a'), quote: { exact: REWRITTEN_LOST_PASSAGE }, source: 'selection', at }],
    threadMeta: [{ headId: fxUuid(P, 2, 'u'), status: 'open', title: 'Cache expiry claim', titleSource: 'ai', titleState: 'done', question: 'Is that still true?', updatedAt: at }],
    pinnedMessages: [],
    parked: [],
  };
}

// ── Output shapes test-server.ts writes ──

export function allThreadsFixtures(nowMs: number): ThreadsFixtureSession[] {
  return [buildDenseSession(nowMs), buildAiSession(), buildFailedSession(nowMs), buildRewrittenSession(nowMs), buildReloadSession()];
}

/** The CLI transcript JSONL: one parentUuid chain, like a real transcript. */
export function fixtureJsonl(s: ThreadsFixtureSession, nowMs: number): string {
  const start = nowMs - 3_600_000;
  const lines = s.rows.map((r, i) => JSON.stringify({
    type: r.role,
    uuid: r.uuid,
    parentUuid: i === 0 ? null : s.rows[i - 1].uuid,
    sessionId: s.sessionId,
    timestamp: new Date(start + i * 2000).toISOString(),
    ...(r.isApiError ? { isApiErrorMessage: true } : {}),
    message: r.role === 'user'
      ? { role: 'user', content: r.text }
      : { role: 'assistant', content: [{ type: 'text', text: r.text }] },
  }));
  return `${lines.join('\n')}\n`;
}

export function fixtureTask(s: ThreadsFixtureSession, nowIso: string): Record<string, unknown> {
  return {
    id: s.taskId, title: s.title.replace(' session', ' task'), status: 'in_progress', phase: 'IN_PROGRESS',
    priority: 'none', project: 'Walnut', source: 'local', session_ids: [s.sessionId], active_session_ids: [],
    session_id: s.sessionId, session_status: { process_status: 'stopped', mode: 'bypass' },
    created_at: nowIso, updated_at: nowIso, description: '', summary: '', note: '', subtasks: [],
  };
}

export function fixtureRecord(s: ThreadsFixtureSession, nowMs: number, cwd: string): Record<string, unknown> {
  return {
    claudeSessionId: s.sessionId, taskId: s.taskId, project: 'Walnut', process_status: 'stopped', mode: 'bypass',
    last_status_change: new Date(nowMs).toISOString(), startedAt: new Date(nowMs - 3_600_000).toISOString(),
    lastActiveAt: new Date(nowMs).toISOString(), messageCount: s.rows.length, cwd, title: s.title,
    threadAnchors: s.threadAnchors, threadMeta: s.threadMeta, pinnedMessages: s.pinnedMessages,
  };
}

/** Parked rows for session-message-queue.json, keyed by session id. */
export function fixtureParkedQueues(sessions: ThreadsFixtureSession[], nowMs: number): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const s of sessions) {
    if (!s.parked.length) continue;
    out[s.sessionId] = s.parked.map((p, i) => ({
      id: p.id, sessionId: s.sessionId, message: p.message, status: 'parked', userUuid: p.userUuid,
      enqueuedAt: new Date(nowMs - 120_000 + i).toISOString(), parkedAt: new Date(nowMs - 60_000).toISOString(),
      parkedReason: 'Session stopped by user; retry explicitly to send',
    }));
  }
  return out;
}

/** The seeded (reset) state of one fixture session, for resetThreadsFixture. */
export function seededThreadState(sessionId: string, nowMs: number): Pick<ThreadsFixtureSession, 'threadAnchors' | 'threadMeta' | 'pinnedMessages'> | null {
  const s = allThreadsFixtures(nowMs).find((x) => x.sessionId === sessionId);
  return s ? { threadAnchors: s.threadAnchors, threadMeta: s.threadMeta, pinnedMessages: s.pinnedMessages } : null;
}

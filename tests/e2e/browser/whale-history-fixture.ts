/**
 * A transcript past the full read's byte ceiling, for whale-history.spec.ts.
 *
 * test-server.ts lowers DaemonFileReader's ceiling to WHALE_CEILING_BYTES, so this
 * ~17 MB file can never be read whole and is served as a 4 MB tail (`windowed`), the
 * way the reported 38 MB production session was. Two densities on purpose:
 *  · the OLD part is ordinary (a few KB per turn): paging back through it takes
 *    several bounded windows;
 *  · the NEWEST part is heavy tool output (tens of KB per turn), so the 4 MB tail
 *    holds fewer than 400 rows, the shape of the report (291 rows in its tail), and
 *    "Load earlier messages" is offered at once instead of after the lazy-tail hop.
 *
 * Every turn is `whale ask N` / `whale reply N` plus one tool call, so a spec can
 * check that paging back yields every turn exactly once, in order.
 *
 * whale-anchor-reach.spec.ts appends a 6 MB turn to its OWN copy of the transcript
 * (WHALE_ANCHOR_SESSION), so this session's tail stays the fixture's last turn. The
 * chromium and webkit projects share each session; run with --workers=1.
 */

export const WHALE_SESSION = 'pw-whale-history-session';
export const WHALE_TASK = 'pw-task-whale-history';
export const WHALE_TITLE = 'Whale history fixture';
/** A second copy of the same transcript, which whale-anchor-reach.spec.ts appends a heavy turn to. */
export const WHALE_ANCHOR_SESSION = 'pw-whale-anchor-session';
export const WHALE_ANCHOR_TASK = 'pw-task-whale-anchor';
export const WHALE_ANCHOR_TITLE = 'Whale anchor fixture';

export type WhaleKind = 'history' | 'anchor';
const KINDS: Record<WhaleKind, { session: string; task: string; title: string }> = {
  history: { session: WHALE_SESSION, task: WHALE_TASK, title: WHALE_TITLE },
  anchor: { session: WHALE_ANCHOR_SESSION, task: WHALE_ANCHOR_TASK, title: WHALE_ANCHOR_TITLE },
};
/** The fixture server's full-read ceiling (WALNUT_MAX_FILE_READ_BYTES). */
export const WHALE_CEILING_BYTES = 8 * 1024 * 1024;

/** Bytes of tool output per turn in the old part and in the heavy newest part. */
const OLD_RESULT_CHARS = 12_000;
const HEAVY_RESULT_CHARS = 60_000;
/** Turns in the old part, then in the heavy newest part (about 17 MB together). */
export const WHALE_OLD_TURNS = 820;
export const WHALE_HEAVY_TURNS = 120;
export const WHALE_TURNS = WHALE_OLD_TURNS + WHALE_HEAVY_TURNS;

const U = '0199e0';

/** The whole JSONL. Line timestamps rise 250 ms apiece, ending shortly before `nowMs`. */
export function whaleJsonl(nowMs: number, session: string = WHALE_SESSION): string {
  const total = WHALE_TURNS * 4;
  const start = nowMs - total * 250 - 60_000;
  let n = 0;
  const stamp = () => new Date(start + (n++) * 250).toISOString();
  const uuid = (kind: string, t: number) => `${U}${kind}-0000-4aaa-8bbb-${String(t).padStart(12, '0')}`;
  const lines: string[] = [];
  let parent: string | null = null;
  for (let t = 0; t < WHALE_TURNS; t++) {
    const chars = t < WHALE_OLD_TURNS ? OLD_RESULT_CHARS : HEAVY_RESULT_CHARS;
    const ask = uuid('01', t);
    const reply = uuid('02', t);
    const call = uuid('03', t);
    const result = uuid('04', t);
    lines.push(
      JSON.stringify({
        type: 'user', uuid: ask, parentUuid: parent, sessionId: session, timestamp: stamp(),
        message: { role: 'user', content: `whale ask ${t}` },
      }),
      JSON.stringify({
        type: 'assistant', uuid: reply, parentUuid: ask, sessionId: session, timestamp: stamp(),
        message: { id: `msg_whale_${t}_a`, role: 'assistant', content: [{ type: 'text', text: `whale reply ${t}` }] },
      }),
      JSON.stringify({
        type: 'assistant', uuid: call, parentUuid: reply, sessionId: session, timestamp: stamp(),
        message: {
          id: `msg_whale_${t}_b`, role: 'assistant',
          content: [{ type: 'tool_use', id: `tu-whale-${t}`, name: 'Bash', input: { command: `echo step ${t}` } }],
        },
      }),
      JSON.stringify({
        type: 'user', uuid: result, parentUuid: call, sessionId: session, timestamp: stamp(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-whale-${t}`, content: 'x'.repeat(chars) }] },
      }),
    );
    parent = result;
  }
  return lines.join('\n') + '\n';
}

export function whaleTask(nowIso: string, kind: WhaleKind = 'history'): Record<string, unknown> {
  const { session, task, title } = KINDS[kind];
  return {
    id: task,
    title,
    status: 'in_progress',
    phase: 'IN_PROGRESS',
    priority: 'none',
    project: 'Walnut',
    source: 'local',
    session_ids: [session],
    active_session_ids: [],
    session_id: session,
    session_status: { process_status: 'stopped', mode: 'bypass' },
    created_at: nowIso,
    updated_at: nowIso,
    description: '',
    summary: '',
    note: '',
    subtasks: [],
  };
}

export function whaleRecord(nowMs: number, cwd: string, kind: WhaleKind = 'history'): Record<string, unknown> {
  const { session, task, title } = KINDS[kind];
  return {
    claudeSessionId: session,
    taskId: task,
    project: 'Walnut',
    process_status: 'stopped',
    mode: 'bypass',
    last_status_change: new Date(nowMs).toISOString(),
    startedAt: new Date(nowMs - 3_600_000).toISOString(),
    lastActiveAt: new Date(nowMs).toISOString(),
    messageCount: WHALE_TURNS * 3,
    cwd,
    title,
  };
}

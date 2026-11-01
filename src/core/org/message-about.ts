/**
 * Which tasks a message in Main's, a VP's or a lead's chat is about (2026-10-31, the user decided
 * it, translated: "for the CEO, two: the VP and the task ... for each VP, at least the task; if it
 * is a leader, the leader too ... return an HTML tag at the end, hidden messages all use one ...
 * render it below"). The node's session ends its message with one line,
 * `<walnut-about tasks="<id>,<id>"/>`; Walnut takes the line off the text and draws the tasks under
 * the message as live pills. A message without the line falls back to what Walnut knows of its
 * turn: the task whose message started it (`from-task` of its envelope) and the tasks the turn
 * sent to (task_send, org_send). Pure, shared by the server's history parse and the web.
 *
 * The line counts only as a line of its own outside a code fence, among the message's last lines
 * (before or after the agent-ack line); a quote of it inside a sentence or a code block stays text.
 */

export const ABOUT_TAG_NAME = 'walnut-about';
const ABOUT_LINE = /^\s{0,3}<walnut-about\s+tasks="([^"]*)"\s*\/>\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
/** How many ids one message may name: more is a list, not what it is about. */
export const ABOUT_MAX = 6;

/** The ids a tag lists: comma or space separated, each a task id's characters, in order, once. */
export function aboutIds(list: string): string[] {
  const out: string[] = [];
  for (const raw of list.split(/[\s,]+/)) {
    const id = raw.trim();
    if (id && /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,80}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, ABOUT_MAX);
}

/** The lines outside any code fence (true), in order. */
function outsideFence(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (m) {
      const mark = m[1]!;
      if (open === null) open = mark;
      else if (mark[0] === open[0] && mark.length >= open.length && !m[2]!.trim()) open = null;
      out.push(false);
      continue;
    }
    out.push(open === null);
  }
  return out;
}

export interface AboutRead {
  /** The text without the tag line. */
  text: string;
  /** The ids it named (empty: no tag, or one naming none). */
  ids: string[];
  /** The message carried the tag. */
  tagged: boolean;
}

/** Read the tag off a message's text. Only within its last three non-blank lines. */
export function readAboutTag(text: string | undefined): AboutRead {
  const src = text ?? '';
  if (!src.includes(`<${ABOUT_TAG_NAME}`)) return { text: src, ids: [], tagged: false };
  const lines = src.split('\n');
  const outside = outsideFence(lines);
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < 3; i--) {
    if (!lines[i]!.trim()) continue;
    seen++;
    const m = outside[i] ? ABOUT_LINE.exec(lines[i]!) : null;
    if (!m) continue;
    const rest = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').replace(/\s+$/, '');
    return { text: rest, ids: aboutIds(m[1]!), tagged: true };
  }
  return { text: src, ids: [], tagged: false };
}

/**
 * The text as the screen shows it: never the tag line. While a message still streams, a last line
 * that is so far only the start of the tag is held back too, so it never flashes up.
 */
export function stripAboutTag(text: string, streaming = false): string {
  const read = readAboutTag(text);
  if (read.tagged) return read.text;
  if (!streaming) return text;
  const cut = text.lastIndexOf('\n');
  const tail = text.slice(cut + 1).trim();
  const head = `<${ABOUT_TAG_NAME}`;
  return tail.length >= 2 && (head.startsWith(tail) || tail.startsWith(head)) ? text.slice(0, Math.max(0, cut)) : text;
}

/** The shape the fallback reads (a history row). */
export interface AboutRow {
  role: 'user' | 'assistant' | 'system';
  text: string;
  injected?: boolean;
  tools?: { name: string; input?: Record<string, unknown>; result?: string }[];
}

/** The task a delivered message came from: its envelope's `from-task`. */
export function envelopeFromTask(text: string): string | null {
  const m = /<walnut-message\b[^>]*\bfrom-task="([^"]+)"/.exec(text);
  return m ? m[1]! : null;
}

const SENDS = /\b(task_send|org_send)\b/;
const CREATES = /\btask_create\b/;
/** A task id's shape (`mvm0n3bu-6910`, or a synced task's UUID): org_send's `to` is usually a project or VP name. */
const TASK_ID_SHAPE = /^(?:[0-9a-z]{6,12}-[0-9a-z]{3,8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The tasks a tool call sent to: a `walnut tools call task_send '{"task":"…"}'`, or org_send's `to` when it is a task id;
 *  and the task a `task_create` made, read off its answer (its first `"id"`). */
export function sentToTasks(tool: { name: string; input?: Record<string, unknown>; result?: string }): string[] {
  const input = tool.input ?? {};
  const command0 = typeof input.command === 'string' ? input.command : '';
  if (CREATES.test(tool.name) || CREATES.test(command0)) {
    const made = /"id"\s*:\s*"([^"]+)"/.exec(tool.result ?? '')?.[1];
    return made && TASK_ID_SHAPE.test(made) ? [made] : [];
  }
  const pick = (key: string, value: unknown): string[] => {
    if (typeof value !== 'string') return [];
    const v = value.trim();
    return key === 'to' && !TASK_ID_SHAPE.test(v) ? [] : [v];
  };
  // A direct op call (an MCP-style tool named for the op).
  if (SENDS.test(tool.name)) return aboutIds(['task', 'task_id', 'to'].flatMap((k) => pick(k, input[k])).join(','));
  const command = typeof input.command === 'string' ? input.command : '';
  if (!SENDS.test(command)) return [];
  const ids: string[] = [];
  for (const m of command.matchAll(/"(task|task_id|to)"\s*:\s*"([^"]+)"/g)) ids.push(...pick(m[1]!, m[2]));
  return aboutIds(ids.join(','));
}

/**
 * For each row, the tasks it is about: its tag's, else (an assistant row with words) its turn's
 * asker and the tasks the turn sent to. A row with nothing gets no entry. A turn starts at a
 * message sent in (a user row Walnut did not inject); a window that starts mid-turn reads only the
 * rows it has.
 */
export function messageAbout(rows: readonly AboutRow[]): Map<number, { ids: string[]; tagged: boolean }> {
  const out = new Map<number, { ids: string[]; tagged: boolean }>();
  let asker: string | null = null;
  let sent: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.role === 'user' && !r.injected) {
      asker = envelopeFromTask(r.text);
      sent = [];
      continue;
    }
    if (r.role !== 'assistant') continue;
    for (const t of r.tools ?? []) for (const id of sentToTasks(t)) if (!sent.includes(id)) sent.push(id);
    if (!r.text.trim()) continue;
    const tag = readAboutTag(r.text);
    if (tag.tagged) { if (tag.ids.length) out.set(i, { ids: tag.ids, tagged: true }); continue; }
    const ids = aboutIds([asker ?? '', ...sent].join(','));
    if (ids.length) out.set(i, { ids, tagged: false });
  }
  return out;
}

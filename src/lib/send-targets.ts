/**
 * Whom a session's send went to, read from the call itself.
 *
 * 2026-10-30, the user, of a lead's fold row "Sent 2" and its opened card "To
 * another session": which session? A send names its target in its arguments when
 * the model wrote them inline (`"to":"<task id>"`), but a model often builds the
 * arguments in a subshell (`task_send "$(python3 -c …)"`) or loops over several
 * targets (`for id in A B; do … "{\"to\":\"$id\"…}"`), and then only the server's
 * answer the call printed says where it went: JSON (`targetTaskId`, `target`) or
 * its outcome line ("Message delivered on this host to <id>", "Message queued for
 * <id>"), one per send, often cut short by the model's own `| cut`/`| tail`.
 *
 * Pure. The web resolves the refs against its task labels (a unique id prefix is
 * enough); the server resolves them for the phone's transcript (`sentTo`).
 */

/** A task id, a session id, or a prefix of one: never a shell variable or a name
 *  (an id carries a digit or a hyphen; "Walnut" in "queued for Walnut lead" does not). */
const ID_LIKE = /^(?=[^\s]*[\d-])[a-z0-9][a-z0-9-]{5,}$/i;

/** The `to` values a command line spells out, its quotes escaped or not
 *  (`'{"to":"x"}'`, `"{\"to\":\"x\"}"`, a Python dict inside `$(…)`, jq's bare
 *  `{to:"x"}`). */
export function commandTargetRefs(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:\\*["']to\\*["']|(?<![\w"'])to)\s*:\s*\\*["']([^"'\\\s]+)/g)) out.push(m[1]);
  return out.filter((r) => ID_LIKE.test(r));
}

const ANSWER_JSON = [
  /"targetTaskId"\s*:\s*"([^"]+)"/g,
  /"target"\s*:\s*\{[^{}]*?"taskId"\s*:\s*"([^"]+)"/g,
];
/** A delivery the target's own host made answers with the session alone. */
const ANSWER_SESSION = [/"targetSessionId"\s*:\s*"([^"]+)"/g];
const ANSWER_LINES = [
  /Message delivered on this host to ([A-Za-z0-9-]+)/g,
  /Message queued for ([A-Za-z0-9-]+)/g,
  /Reply delivered on this host to the asking session \(([A-Za-z0-9-]+)\)/g,
];

/** Every match of the patterns, in the order they were printed (a loop's answers
 *  come one per send). */
function inOrder(text: string, patterns: RegExp[]): string[] {
  const hits: { at: number; ref: string }[] = [];
  for (const p of patterns) for (const m of text.matchAll(p)) hits.push({ at: m.index ?? 0, ref: m[1] });
  hits.sort((a, b) => a.at - b.at);
  return hits.map((h) => h.ref).filter((r) => ID_LIKE.test(r));
}

/** The targets the server's answer names, in order: its JSON task ids when it
 *  printed them (one answer also carries an outcome line naming the same send by
 *  its session id, so the lines are read only when there is no JSON), else the
 *  session a same-host delivery names (a ref the reader maps to its task), else
 *  its outcome lines. */
export function resultTargetRefs(result: string | undefined): string[] {
  if (!result) return [];
  for (const tier of [ANSWER_JSON, ANSWER_SESSION, ANSWER_LINES]) {
    const refs = inOrder(result, tier);
    if (refs.length > 0) return refs;
  }
  return [];
}

/** A ref that is a prefix of another one already listed is the same target. */
function distinct(refs: string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const same = out.findIndex((o) => o.startsWith(ref) || ref.startsWith(o));
    if (same < 0) out.push(ref);
    else if (ref.length > out[same].length) out[same] = ref;
  }
  return out;
}

/**
 * Every target of one send call, distinct, in order. The answer says where the
 * server actually delivered, so when it names any target only its targets count:
 * the arguments may name the same task another way (a session id, a handle) and
 * would count one send twice. Without an answer, the arguments, then the command.
 */
export function sendTargetRefs(args: { to?: unknown } | undefined, command: string | undefined, result: string | undefined): string[] {
  const answered = resultTargetRefs(result);
  if (answered.length > 0) return distinct(answered);
  const named = typeof args?.to === 'string' && ID_LIKE.test(args.to) ? [args.to] : [];
  return distinct([...named, ...(command ? commandTargetRefs(command) : [])]);
}

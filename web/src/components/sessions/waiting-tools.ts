import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fetchPermissionDecisions } from '@/api/sessions';
import { useEvent } from '@/hooks/useWebSocket';

/**
 * The tool calls a pending prompt holds (their toolUseIds, from the prompt's own
 * event): until it is answered, such a call has no result yet, and its row must
 * read as waiting for approval, never as done.
 */
export const WaitingToolsContext = createContext<ReadonlySet<string>>(new Set());

export function useWaitingTools(): ReadonlySet<string> {
  return useContext(WaitingToolsContext);
}

/**
 * The person's answer to the prompt that gated a call ("Allowed for this session:
 * ...", "Denied with note "...": npm test"), by toolUseId. The transcript keeps only the
 * call, so without this a row could not say which choice let it run.
 */
export const ToolDecisionsContext = createContext<ReadonlyMap<string, string>>(new Map());

export function useToolDecisions(): ReadonlyMap<string, string> {
  return useContext(ToolDecisionsContext);
}

/** Inside a run of one call: opening the run opens that call too, one click to its command. */
export const SoleCallContext = createContext(false);

export function useSoleCall(): boolean {
  return useContext(SoleCallContext);
}

/** A noted deny on a run's line reads the command first, then the note (a long note never pushes the command out of sight). */
function runAnswerText(line: string): string {
  const noted = /^Denied with note (\u201C[\s\S]*\u201D): ([\s\S]+)$/.exec(line);
  return noted ? `Denied with note: ${noted[2]} \u00b7 ${noted[1]}` : line;
}

/** A later call a granted rule let run reads as that grant again: one line with a count, not the command twice. */
const RULE_OF_GRANT: Array<[RegExp, string]> = [
  [/^Allowed by session rule: /, 'Allowed for this session: '],
  [/^Allowed by project rule: /, 'Always allowed in this project: '],
];

/** A line that names a prefix rule, not the command it let run. */
const PREFIX_RULE_LINE = /^((?:Allowed for this session|Always allowed in this project|Always allowed|Allowed by (?:session|project|your) rule): )(Bash commands starting with [\s\S]+)$/;

/** A command as an answer line names it: its first line, cut to fit. */
function commandSubject(command: string): string {
  const trimmed = command.trim();
  const first = trimmed.split('\n')[0];
  const line = first === trimmed ? first : `${first} \u2026`;
  return line.length > 80 ? `${line.slice(0, 79)}\u2026` : line;
}

/**
 * A closed run's answer line: each answer once, in call order, with how many calls it
 * answered ("Allowed once: npm test (2 times)"), so two answers never read as one. A
 * call the new rule let through joins its grant's line as its own count
 * ("Allowed for this session: npm test · 1 more call by that rule"). A line naming a
 * prefix rule also names the command that ran (the rule alone hides which one it was),
 * when its calls all ran the same one.
 */
export function runAnswerLines(lines: ReadonlyArray<string>, commands?: ReadonlyArray<string | undefined>): string[] {
  const texts = lines.map(runAnswerText);
  const counts = new Map<string, number>();
  const byRule = new Map<string, number>();
  const ran = new Map<string, Set<string>>();
  texts.forEach((line, i) => {
    const grant = RULE_OF_GRANT.find(([rule]) => rule.test(line));
    const same = grant && line.replace(grant[0], () => grant[1]);
    if (same && texts.includes(same)) { byRule.set(same, (byRule.get(same) ?? 0) + 1); return; }
    counts.set(line, (counts.get(line) ?? 0) + 1);
    const command = commands?.[i]?.trim();
    ran.set(line, (ran.get(line) ?? new Set()).add(command ?? ''));
  });
  return [...counts].map(([line, n]) => {
    const rule = PREFIX_RULE_LINE.exec(line);
    const only = ran.get(line);
    const command = only?.size === 1 ? [...only][0] : '';
    // "Allowed for this session (commands starting with npm test): npm test --silent".
    const named = rule && command ? `${rule[1].slice(0, -2)} (${rule[2].replace(/^Bash c/, 'c')}): ${commandSubject(command)}` : line;
    const head = n > 1 ? `${named} (${n} times)` : named;
    const m = byRule.get(line);
    return m ? `${head} \u00b7 ${m} more ${m > 1 ? 'calls' : 'call'} by that rule` : head;
  });
}

/** The calls the person denied in this browser just now, before their result is in. */
export const DeniedNowContext = createContext<ReadonlySet<string>>(new Set());

export function useDeniedNow(): ReadonlySet<string> {
  return useContext(DeniedNowContext);
}

/** The server keeps an answer as it sends it: read again soon, and once more in case the write was slow. */
const REFETCH_AFTER_RESOLVE_MS = [250, 1500, 4000];
/** After a call's result: one read for a burst of them. */
const REFETCH_AFTER_RESULT_MS = 400;

/** One session's decisions, read on open and again after each answer to its prompts. */
export function useSessionToolDecisions(sessionId: string | undefined): ReadonlyMap<string, string> {
  const [decisions, setDecisions] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [nonce, setNonce] = useState(0);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    fetchPermissionDecisions(sessionId)
      .then((list) => { if (live) setDecisions(new Map(list.map((d) => [d.toolUseId, d.line]))); })
      .catch(() => { /* a label is a nicety: the rows read as before */ });
    return () => { live = false; };
  }, [sessionId, nonce]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEvent('session:permission-resolved', (data) => {
    if ((data as { sessionId?: string } | null)?.sessionId !== sessionId) return;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = REFETCH_AFTER_RESOLVE_MS.map((ms) => window.setTimeout(() => setNonce((n) => n + 1), ms));
  });
  // A call a remembered rule let run is noted without any prompt (noteAllowedByRule):
  // read again once a burst of results, or the turn, has settled.
  const later = useRef<number | null>(null);
  const readSoon = (data: unknown) => {
    if ((data as { sessionId?: string } | null)?.sessionId !== sessionId) return;
    if (later.current) window.clearTimeout(later.current);
    later.current = window.setTimeout(() => { later.current = null; setNonce((n) => n + 1); }, REFETCH_AFTER_RESULT_MS);
  };
  useEvent('session:tool-result', readSoon);
  useEvent('session:result', readSoon);
  useEffect(() => () => { if (later.current) window.clearTimeout(later.current); }, []);
  return decisions;
}

/** A decision line that said no: the call will not run, whatever its result says yet. */
export function isDenyDecision(line: string | undefined): boolean {
  return !!line && /^(Denied|Questions? dismissed|Dismissed by your message|Plan rejected)/.test(line);
}

/**
 * A call's row state from its prompt's answer, before the CLI sends its result: the
 * CLI may hold a denied call's result until the calls beside it finish, so a call
 * answered "no" reads as denied at once, and only an unanswered one as queued.
 */
export function answeredCallState(
  toolUseId: string | undefined, decision: string | undefined, deniedNow: ReadonlySet<string>,
): 'denied' | 'answered' | undefined {
  if (!toolUseId) return undefined;
  if (deniedNow.has(toolUseId) || isDenyDecision(decision)) return 'denied';
  return decision ? 'answered' : undefined;
}

/**
 * The answer as one call's own row shows it: that row already shows the command,
 * so a line that ends by naming it ("Allowed once: npm test") keeps only the choice.
 * A remembering line keeps its rule: the rule can be wider than the command.
 */
export function callDecisionLabel(line: string): string {
  const noted = /^Denied with note (\u201C[\s\S]*\u201D): /.exec(line)
    // Lines kept before the note led ("Denied: npm test (note: ...)").
    ?? /^Denied: [\s\S]*? \(note: (\u201C[\s\S]*\u201D)\)$/.exec(line);
  if (noted) return `Denied with note ${noted[1]}`;
  // A line naming a rule keeps it (which rule let the call run is the point of the row).
  const once = /^(Allowed once|Denied|Denied by your message): /.exec(line);
  return once ? once[1] : line;
}

/**
 * The whole answer under an opened call: its command is just above, so a line that
 * ends by naming that command says so instead of naming it twice.
 */
export function callAnswerText(line: string, command?: string): string {
  const label = callDecisionLabel(line);
  if (!command || label.startsWith('Denied with note')) return label;
  const named = /^([^:]+): ([\s\S]+)$/.exec(label);
  if (!named) return label;
  const tail = named[2];
  const cut = tail.endsWith('\u2026') ? tail.slice(0, -1).trimEnd() : '';
  const isCommand = tail === commandSubject(command) || (!!cut && command.trim().startsWith(cut));
  return isCommand ? `${named[1]} (this exact command)` : label;
}

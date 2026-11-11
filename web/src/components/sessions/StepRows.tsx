/**
 * Rows of an opened turn that are not tool calls or message cards, drawn as the one
 * step row every other step is (step-rows.css): the session's own words on the way
 * to its answer, one line until opened; a step that needs the person, lifted out
 * above the fold in red; and the live turn's current step under its closed line.
 */
import type { ReactNode } from 'react';
import { bashCommandSummary, toolDescription } from '@open-walnut/tool-header-text';
import { useTurnFold } from './TurnFolds';
import { StepIcon, toolDisplayName, toolStepIcon } from './StepIcon';
import { toolTarget } from './step-target';
import { isRuleDenied } from './tool-run-phrase';
import { thinkingFirstLine } from './SessionMessage';
import '@/styles/step-rows.css';

/** Words the session wrote before its answer: the first line, the whole text a click away. */
export function FoldedWordsRow({ text, foldKey, children }: { text: string; foldKey: string; children: ReactNode }) {
  // A fold key, not a local disclosure: a find or a jump to these words opens it (revealFolded).
  const [open, toggle] = useTurnFold(foldKey);
  const line = thinkingFirstLine(text);
  return (
    <div className="tool-run-row tool-run-row--step tool-run-row--words" data-testid="folded-words">
      <button type="button" className="tool-run-toggle" aria-expanded={open} onClick={toggle}>
        <StepIcon name="message" className="tool-run-icon" />
        {!open && <span className="tool-run-detail tool-run-detail--words" data-find-skip="">{line}</span>}
        {open && <span className="tool-run-label">Note</span>}
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
      </button>
      {open && <div className="tool-run-body">{children}</div>}
    </div>
  );
}

/** Whether a failed call stopped on the person: they or a permission rule refused it. */
export function needsPerson(result: string | undefined): boolean {
  // Only a rule's refusal: the person's own no (or an interrupt) they already know of.
  return isRuleDenied(result);
}

/** One line for a call: its name or command and what it touched. */
export function callLine(name: string, input: Record<string, unknown> | undefined): { label: string; mono: boolean } {
  const inp = input ?? {};
  if (name === 'Bash' && typeof inp.command === 'string') {
    const desc = toolDescription(inp);
    return desc ? { label: desc, mono: false } : { label: bashCommandSummary(inp.command), mono: true };
  }
  const desc = toolDescription(inp) || toolTarget(name, inp);
  return { label: desc ? `${toolDisplayName(name)} ${desc}` : toolDisplayName(name), mono: false };
}

/** A refused call, above the fold its turn folded into: what it was and why it stopped. */
export function LiftedStep({ name, input, result }: { name: string; input?: Record<string, unknown>; result?: string }) {
  const { label } = callLine(name, input);
  const why = (result ?? '').split('\n').find((l) => l.trim()) ?? '';
  return (
    <div className="step-lifted" data-testid="lifted-step">
      <div className="step-lifted-head"><StepIcon name="alert" /><span>{label}</span></div>
      {why && <div className="step-lifted-why">{why}</div>}
    </div>
  );
}

/** The live turn's current step, under its closed line: icon and words, shimmering. */
export function PeekRow({ icon, text, mono }: { icon: Parameters<typeof StepIcon>[0]['name']; text: string; mono?: boolean }) {
  return (
    <div className="step-peek-row">
      <StepIcon name={icon} />
      <span className={`step-peek-text${mono ? ' mono' : ''}`}>{text}</span>
    </div>
  );
}

/** A live run's members as the peek reads them. */
type PeekMember = { type: string; name?: string; input?: Record<string, unknown>; content?: string };

/**
 * What a live run or turn does now, under its closed line: the latest thought, then
 * the call it is on when the last member is a call (design 1, 2026-11-11: a running
 * turn shows one live line and the step it is on; nothing else grows).
 */
export function LivePeek({ members }: { members: readonly PeekMember[] }) {
  const last = members[members.length - 1];
  if (!last) return null;
  const thought = [...members].reverse().find((m) => m.type === 'thinking' && !!m.content?.trim());
  const call = last.type === 'tool_call' && last.name ? last : undefined;
  const line = call ? callLine(call.name!, call.input) : undefined;
  if (!thought && !line) return null;
  return (
    <>
      {thought && <PeekRow icon="thought" text={thinkingFirstLine(thought.content!)} />}
      {call && line && <PeekRow icon={toolStepIcon(call.name!)} text={line.label} mono={line.mono} />}
    </>
  );
}

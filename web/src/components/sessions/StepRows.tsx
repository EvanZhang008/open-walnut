/**
 * Rows of an opened turn that are not tool calls or message cards, drawn as the one
 * step row every other step is (step-rows.css): the session's own words on the way
 * to its answer, one line until opened; and a step that needs the person, lifted out
 * above the fold in red.
 */
import type { ReactNode } from 'react';
import { bashCommandSummary, toolDescription } from '@open-walnut/tool-header-text';
import { useTurnFold } from './TurnFolds';
import { StepIcon, toolDisplayName } from './StepIcon';
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


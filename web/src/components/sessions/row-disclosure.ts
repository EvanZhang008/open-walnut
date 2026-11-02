/**
 * Which disclosures in a session's rows the reader opened, kept by what they
 * show rather than by the element that showed them.
 *
 * A row is drawn again whenever its live block gives way to its saved row
 * (another component), a person's message sent mid-turn is saved, or a
 * subagent's lane turns from its live blocks into its transcript. A reader who
 * had opened a tool run, a tool card or the reasoning saw it fold shut at that
 * moment (2026-11-01, the user: streaming and finished must look exactly the
 * same, "no flash, no change of format"). Each disclosure that a live row and
 * its saved twin both draw names itself by an id both sides know (a tool's
 * toolUseId, a message's msgId) and keeps its state here, per session.
 *
 * Memory only, bounded: a reload starts every disclosure as it was designed to.
 * `tests/web/row-disclosure-ratchet.test.ts` fails on a new open/expanded state
 * in a row component that keeps it in the component alone.
 */
import { createContext, useCallback, useContext, useState, type SyntheticEvent } from 'react';

/** The session whose rows these are (SessionChatHistory, the lane viewers). */
export const RowDisclosureScope = createContext<string | null>(null);

const MAX_SCOPES = 40;
const MAX_PER_SCOPE = 2000;
const scopes = new Map<string, Map<string, boolean>>();

function scopeStore(scope: string): Map<string, boolean> {
  let store = scopes.get(scope);
  if (store) {
    // Least recently used goes first: a session still on screen is never dropped.
    scopes.delete(scope);
    scopes.set(scope, store);
  } else {
    store = new Map();
    scopes.set(scope, store);
    if (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
  }
  return store;
}

function remember(store: Map<string, boolean>, id: string, value: boolean): void {
  store.delete(id);
  store.set(id, value);
  if (store.size > MAX_PER_SCOPE) store.delete(store.keys().next().value!);
}

/**
 * `useState(initial)` for a disclosure, shared with every other element that
 * shows the same thing in this session. With no id or no scope it is plain
 * local state.
 */
export function useRowDisclosure(id: string | undefined, initial: boolean): [boolean, (next: boolean | ((open: boolean) => boolean)) => void] {
  const scope = useContext(RowDisclosureScope);
  const store = scope ? scopeStore(scope) : null;
  const [open, setOpen] = useState(() => (store && id ? store.get(id) : undefined) ?? initial);
  // The same element can come to show another thing (a reasoning row that a
  // tool joins takes the run's id): it picks up what that thing had, or hands
  // its own state to it. React's derived-state pattern: state, not a ref, so a
  // render React throws away leaves nothing half done.
  const [shownId, setShownId] = useState(id);
  let current = open;
  if (shownId !== id) {
    setShownId(id);
    const known = store && id ? store.get(id) : undefined;
    if (known !== undefined) {
      current = known;
      if (known !== open) setOpen(known);
    } else if (store && id) remember(store, id, open);
  }
  const set = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setOpen((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      if (store && id) remember(store, id, value);
      return value;
    });
  }, [store, id]);
  return [current, set];
}

/** A `<details>` kept the same way: spread onto the element. */
export function useDetailsDisclosure(id: string | undefined): { open: boolean; onToggle: (e: SyntheticEvent<HTMLDetailsElement>) => void } {
  const [open, setOpen] = useRowDisclosure(id, false);
  return {
    open,
    onToggle: (e) => {
      const now = e.currentTarget.open;
      if (now !== open) setOpen(now);
    },
  };
}

/** Ids both a live row and its saved twin know. */
export const disclosureIds = {
  /** A tool run or a reasoning stretch: its first member, as `runRowKey`. */
  run: (first: { toolUseId?: string; msgId?: string } | undefined): string | undefined =>
    first?.toolUseId ? `run-${first.toolUseId}` : first?.msgId ? `run-${first.msgId}` : undefined,
  thinking: (msgId: string | undefined): string | undefined => (msgId ? `think-${msgId}` : undefined),
  tool: (toolUseId: string | undefined): string | undefined => (toolUseId ? `tool-${toolUseId}` : undefined),
  diff: (toolUseId: string | undefined): string | undefined => (toolUseId ? `diff-${toolUseId}` : undefined),
  diffFull: (toolUseId: string | undefined): string | undefined => (toolUseId ? `difffull-${toolUseId}` : undefined),
  /** A person's message: what Walnut added to it. */
  added: (messageId: string | undefined): string | undefined => (messageId ? `added-${messageId}` : undefined),
  /** A row known by its words alone (a system notice, injected context). */
  content: (kind: string, text: string): string => `${kind}-${text.length}-${text.slice(0, 64)}-${text.slice(-64)}`,
  plan: (toolUseId: string | undefined): string | undefined => (toolUseId ? `plan-${toolUseId}` : undefined),
  prompt: (toolUseId: string | undefined): string | undefined => (toolUseId ? `prompt-${toolUseId}` : undefined),
};

/** Test hook: forget every scope. */
export function __resetRowDisclosuresForTests(): void {
  scopes.clear();
}

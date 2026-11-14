/**
 * The draft's "Isolated workspace" choice as plain data, and what the launch
 * sends for it. No React, no network: draft-workspace-store.ts keeps one of
 * these per open draft.
 */
import type { WorkspaceCandidate } from '@/api/workspaces';

export interface DraftWorkspaceChoice {
  enabled: boolean;
  /**
   * On because the folder is a code task's (isolated workspaces by default: the
   * experiment, or the project's setting), not by a click. Such a choice gives way
   * quietly: a folder nothing claims, a host that cannot say, or a top provider
   * that needs fields starts in the folder itself, as the server's own default does.
   */
  auto?: boolean;
  /** The person turned the option on or off for this draft: the default no longer moves it. */
  touched?: boolean;
  provider?: string;
  /** Raw field values as typed (an array field is the typed text). */
  values: Record<string, string | boolean>;
  /** The candidates the host answered for the folder they were asked about. */
  candidates?: WorkspaceCandidate[];
  candidatesFor?: string;
  loading?: boolean;
  degraded?: string;
  /** The host could not be asked. */
  error?: string;
  /** Why the last Start waited (a required field, no provider); cleared by the next edit. */
  startError?: string;
}

/** The candidate the draft would use: the picked one, else the best that claims the folder. */
export function selectedCandidate(choice: DraftWorkspaceChoice): WorkspaceCandidate | undefined {
  const list = choice.candidates ?? [];
  return list.find((c) => c.provider === choice.provider) ?? list.find((c) => c.claimed);
}

/**
 * Is the option on by default for a new draft? The project's setting ('on' | 'off')
 * wins over the global one. Mirrors isolationOn in src/core/workspaces/default-isolation.ts.
 */
export function defaultIsolationOn(globalOn: boolean, project: 'on' | 'off' | undefined): boolean {
  return project ? project === 'on' : globalOn;
}

/** A provider can be picked: git needs a repository; a plugin provider can always be chosen by hand. */
export function isPickable(c: WorkspaceCandidate): boolean {
  return c.claimed || !c.builtin;
}

/** A field's suggestion from the provider's detect step, as the draft's text field shows it. */
export function suggestedText(c: WorkspaceCandidate | undefined, key: string): string {
  const v = c?.inputs?.[key];
  return Array.isArray(v) ? v.map(String).join(' ') : typeof v === 'string' ? v : '';
}

/** Apply an edit; any change of the option, the provider or a field clears the last Start's complaint. */
/**
 * A default choice with nothing to make: nothing claims the folder, the host could
 * not say, or the claiming provider needs a field nobody filled. It shows nothing
 * and sends nothing (the Start runs in the folder).
 */
export function autoGivesWay(choice: DraftWorkspaceChoice): boolean {
  if (!choice.auto || choice.loading) return false;
  if (choice.error || choice.degraded) return true;
  const claimed = (choice.candidates ?? []).filter((c) => c.claimed);
  const c = claimed.find((x) => x.provider === choice.provider) ?? claimed[0];
  if (!c) return true;
  return (c.inputSchema?.required ?? []).some((key) => {
    const raw = choice.values[key] ?? c.inputs?.[key] ?? c.inputSchema?.properties?.[key]?.default;
    return raw === undefined || raw === '' || (Array.isArray(raw) && !raw.length);
  });
}

export function applyChoicePatch(cur: DraftWorkspaceChoice, patch: Partial<DraftWorkspaceChoice>): DraftWorkspaceChoice {
  const edit = 'values' in patch || 'provider' in patch || 'enabled' in patch;
  return { ...cur, ...(edit ? { startError: undefined } : {}), ...patch };
}

/**
 * What the launch sends: null when the option is off; `{ error }` when it is on
 * but not ready (still asking the host, no provider, a required field empty):
 * the Start then waits.
 */
export function workspaceRequestFor(choice: DraftWorkspaceChoice): { provider: string; inputs: Record<string, unknown> } | { auto: true } | { error: string } | null {
  if (!choice.enabled || autoGivesWay(choice)) return null;
  // The default, sent before the host answered: the server picks the claiming provider, or none.
  if (choice.loading && choice.auto) return { auto: true };
  if (choice.loading) return { error: 'Still checking which workspaces this folder supports' };
  const c = selectedCandidate(choice);
  if (!c || !isPickable(c)) return { error: 'Pick how to isolate this folder, or turn Isolated workspace off' };
  const inputs: Record<string, unknown> = {};
  const props = c.inputSchema?.properties ?? {};
  for (const [key, field] of Object.entries(props)) {
    // Typed, else what the provider's detect step suggested for this folder, else the field's default.
    const raw = choice.values[key] ?? c.inputs?.[key] ?? field.default;
    if (raw === undefined || raw === '') continue;
    if (field.type === 'array') {
      const list = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
      if (list.length) inputs[key] = list;
    } else if (field.type === 'boolean') {
      inputs[key] = raw === true;
    } else {
      inputs[key] = String(raw).trim();
    }
  }
  for (const key of c.inputSchema?.required ?? []) {
    if (inputs[key] === undefined) return { error: `${props[key]?.title ?? key} is required for ${c.displayName}` };
  }
  return { provider: c.provider, inputs };
}

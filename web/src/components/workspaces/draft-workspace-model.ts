/**
 * The draft's "Isolated workspace" choice as plain data, and what the launch
 * sends for it. No React, no network: draft-workspace-store.ts keeps one of
 * these per open draft.
 */
import type { WorkspaceCandidate } from '@/api/workspaces';

export interface DraftWorkspaceChoice {
  enabled: boolean;
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

/** A provider can be picked: git needs a repository; a plugin provider can always be chosen by hand. */
export function isPickable(c: WorkspaceCandidate): boolean {
  return c.claimed || !c.builtin;
}

/** Apply an edit; any change of the option, the provider or a field clears the last Start's complaint. */
export function applyChoicePatch(cur: DraftWorkspaceChoice, patch: Partial<DraftWorkspaceChoice>): DraftWorkspaceChoice {
  const edit = 'values' in patch || 'provider' in patch || 'enabled' in patch;
  return { ...cur, ...(edit ? { startError: undefined } : {}), ...patch };
}

/**
 * What the launch sends: null when the option is off; `{ error }` when it is on
 * but not ready (still asking the host, no provider, a required field empty):
 * the Start then waits.
 */
export function workspaceRequestFor(choice: DraftWorkspaceChoice): { provider: string; inputs: Record<string, unknown> } | { error: string } | null {
  if (!choice.enabled) return null;
  if (choice.loading) return { error: 'Still checking which workspaces this folder supports' };
  const c = selectedCandidate(choice);
  if (!c || !isPickable(c)) return { error: 'Pick how to isolate this folder, or turn Isolated workspace off' };
  const inputs: Record<string, unknown> = {};
  const props = c.inputSchema?.properties ?? {};
  for (const [key, field] of Object.entries(props)) {
    const raw = choice.values[key] ?? field.default;
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

/**
 * Install and Remove for a plugin that ships in Walnut's bundled store folder
 * (src/web/routes/plugin-bundled-routes.ts). No React: the section owns busy state and
 * feedback, this only speaks the two routes and turns an answer into one result shape.
 */

/** What the store tells the user about a bundled row before it is installed. */
export const BUNDLED_AVAILABLE_TITLE = 'Ships with Walnut; not loaded until installed.';

export type BundledActionResult =
  | { ok: true; state?: string }
  /** Other plugins run on this one: the answer is a question, like the switch's OFF. */
  | { ok: false; dependents: string[]; error: string }
  | { ok: false; dependents?: undefined; error: string };

async function post(pluginId: string, action: 'install' | 'remove'): Promise<BundledActionResult> {
  const res = await fetch(`/api/plugin-runtime/bundled/${encodeURIComponent(pluginId)}/${action}`, { method: 'POST' });
  const body = await res.json().catch(() => ({})) as {
    error?: string;
    code?: string;
    dependents?: string[];
    plugin?: { state?: string };
  };
  if (res.status === 409 && body.code === 'has-dependents') {
    return { ok: false, dependents: body.dependents ?? [], error: body.error ?? 'Other plugins depend on it.' };
  }
  if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
  return { ok: true, ...(body.plugin?.state ? { state: body.plugin.state } : {}) };
}

export const installBundledPlugin = (pluginId: string) => post(pluginId, 'install');
export const removeBundledPlugin = (pluginId: string) => post(pluginId, 'remove');

/** The section's own state setters, so one action reads like every other row's. */
export interface BundledActionHooks {
  busyKey: string;
  setBusy(key: string | null): void;
  setError(message: string | null): void;
  setNotice(message: string | null): void;
  nameOf(pluginId: string): string;
  /** Tell the rest of the console, then re-read the lists. */
  onChanged(): Promise<void>;
}

/**
 * One Install or Remove with the store's usual feedback: busy on the pressed control,
 * a notice on success, the page error line on failure (a refused Remove names the
 * plugins that run on it), and a list refresh only when something changed.
 */
export async function runBundledAction(
  row: { id: string; name: string },
  action: 'install' | 'remove',
  hooks: BundledActionHooks,
): Promise<void> {
  hooks.setBusy(hooks.busyKey);
  hooks.setError(null);
  hooks.setNotice(null);
  try {
    const result = action === 'install' ? await installBundledPlugin(row.id) : await removeBundledPlugin(row.id);
    if (!result.ok) {
      hooks.setError(result.dependents ? removeRefusedMessage(row.name, result.dependents, hooks.nameOf) : result.error);
      return;
    }
    hooks.setNotice(action === 'install' ? installedNotice(row.name, result.state) : `Removed ${row.name}; it is back under Available.`);
    await hooks.onChanged();
  } catch (err) {
    hooks.setError(err instanceof Error ? err.message : String(err));
  } finally {
    hooks.setBusy(null);
  }
}

/** The notice after an Install: honest about a plugin that loaded but is not running yet. */
export function installedNotice(name: string, state: string | undefined): string {
  if (!state || state === 'active' || state === 'activating') return `Installed ${name}.`;
  if (state === 'needs-config') return `Installed ${name}; use Configure on its row to finish setting it up.`;
  return `Installed ${name}; it is not running yet, its row says why.`;
}

/** The sentence for a Remove refused because other plugins run on this one. */
export function removeRefusedMessage(name: string, dependents: string[], nameOf: (id: string) => string): string {
  const names = dependents.map(nameOf).sort((a, b) => a.localeCompare(b));
  return `${name} can't be removed while ${names.join(', ')} ${names.length === 1 ? 'depends' : 'depend'} on it. Turn ${names.length === 1 ? 'it' : 'them'} off first.`;
}

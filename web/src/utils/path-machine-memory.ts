/**
 * The machine a person named for a path whose writer Walnut did not record, kept for this tab
 * only (sessionStorage), so the same old card does not ask again on every click. It is the
 * person's own choice and shows as such in the viewer, with a way to choose another machine.
 */
const KEY = 'walnut.pathMachine.v1';
const MAX_ENTRIES = 50;

function read(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(map: Record<string, string>): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage full or blocked: the choice is simply not remembered.
  }
}

/** The machine ('' = Local) the person named for `path` in this tab, else null. */
export function rememberedMachine(path: string): string | null {
  const host = read()[path];
  return typeof host === 'string' ? host : null;
}

export function rememberMachine(path: string, host: string): void {
  const map = read();
  delete map[path];
  map[path] = host;
  const keys = Object.keys(map);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[stale];
  write(map);
}

export function forgetMachine(path: string): void {
  const map = read();
  if (!(path in map)) return;
  delete map[path];
  write(map);
}

/**
 * Which account a Codex request was billed to, from the `model_provider` Codex writes into
 * every rollout. A provider that is a proxy (a local one, or one named "bp" or "...proxy")
 * hands the call on to an account of its own; any other provider (the Bedrock provider,
 * OpenAI) bills the account Codex is signed in to, so that usage is flagged `direct` and the
 * page shows it first.
 */
export interface CodexAccount { key: string; label: string; direct: boolean }

export const NO_ACCOUNT_KEY = 'unknown';

const PROXY = /proxy|^bp$/i;
const KNOWN_LABEL: Record<string, string> = {
  'amazon-bedrock': 'Bedrock account',
  'local-proxy': 'Local proxy',
  openai: 'OpenAI account',
};

export function codexAccount(provider: string | undefined | null): CodexAccount {
  const key = (provider ?? '').trim();
  if (!key) return { key: NO_ACCOUNT_KEY, label: 'Not recorded', direct: false };
  const proxy = PROXY.test(key);
  return { key, label: KNOWN_LABEL[key] ?? (proxy ? `Proxy: ${key}` : key), direct: !proxy };
}

/** `…/open-walnut/tasks/<id>/…` is a Walnut task's working directory: the run belongs to that task. */
export function taskIdOfCwd(cwd: string): string | undefined {
  return /\/open-walnut\/tasks\/([A-Za-z0-9][A-Za-z0-9-]{5,63})(?:\/|$)/.exec(cwd.replace(/\\/g, '/'))?.[1];
}

/** The folder a run is grouped under when it has no task: its last two path parts. */
export function directoryLabel(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts.slice(-2).join('/') : 'Unknown folder';
}

/** Labels for a set of folders: the last two path parts, with more parts added to the ones that would read the same as another folder. */
export function uniqueDirectoryLabels(cwds: Iterable<string>): (cwd: string) => string {
  const parts = new Map<string, string[]>();
  for (const cwd of cwds) parts.set(cwd, cwd.replace(/\\/g, '/').split('/').filter(Boolean));
  const depth = new Map<string, number>([...parts.keys()].map(cwd => [cwd, 2]));
  const label = (cwd: string) => { const p = parts.get(cwd) ?? []; return p.length ? p.slice(-(depth.get(cwd) ?? 2)).join('/') : 'Unknown folder'; };
  for (let round = 0; round < 12; round++) {
    const byLabel = new Map<string, string[]>();
    for (const cwd of parts.keys()) byLabel.set(label(cwd), [...(byLabel.get(label(cwd)) ?? []), cwd]);
    let grew = false;
    for (const same of byLabel.values()) if (same.length > 1) for (const cwd of same) {
      if ((depth.get(cwd) ?? 2) < (parts.get(cwd)?.length ?? 0)) { depth.set(cwd, (depth.get(cwd) ?? 2) + 1); grew = true; }
    }
    if (!grew) break;
  }
  return (cwd: string) => parts.has(cwd) ? label(cwd) : directoryLabel(cwd);
}

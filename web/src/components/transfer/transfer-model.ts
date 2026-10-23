/**
 * The Transfer dialog's rules, kept apart from its markup: what each choice
 * means, which pairs are blocked, when nothing would change, and the request
 * body the choices make.
 */
import { LOCAL_HOST, type TransferBody, type TransferMode, type TransferOptions, type TransferSource } from '@/api/transfer';

export type DirChoice = 'auto' | 'same' | 'custom';

export interface TransferForm {
  engine: string;
  host: string;
  /** null = follow the host: "Let Walnut choose" on a new host, else "Same directory". */
  dir: DirChoice | null;
  customPath: string;
  mode: TransferMode;
  /** The new session's model; undefined = the engine's default. */
  model?: string;
  /** Claude Code reasoning effort; undefined = the CLI's default. */
  effort?: string;
  /** Permission mode the new session starts in; undefined = the launch default. */
  permissionMode?: string;
  keepSource: boolean;
  message: string;
}

const KIND_LABELS: Record<string, string> = {
  laptop: 'Laptop',
  'public-cloud-vm': 'Cloud VM (public)',
  'private-cloud-vm': 'Cloud VM (private)',
  'dev-box': 'Dev box',
  unknown: 'Unknown',
};

export const HOST_KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));

export function hostKindLabel(kind: string | undefined | null): string {
  return KIND_LABELS[kind ?? 'unknown'] ?? 'Unknown';
}

/** The host's name: the label the server sent (the cloud box is "Cloud"), else its alias. */
export function hostLabel(host: string, hosts?: readonly { alias: string; label?: string }[]): string {
  if (host === LOCAL_HOST) return 'This Mac';
  return hosts?.find((h) => h.alias === host)?.label ?? host;
}

/** What a new session on `engine` starts with by default: the source's own model
 *  and effort on the same engine, the engine's defaults on another one. */
export function launchDefaults(source: TransferSource, engine: string): Pick<TransferForm, 'model' | 'effort'> {
  if (engine !== source.engine) return { model: undefined, effort: undefined };
  // 'default' is the CLI's own default, which the picker calls Auto.
  const model = source.model && source.model !== 'default' ? source.model : undefined;
  return { model, effort: source.effort ?? undefined };
}

export function initialForm(source: TransferSource): TransferForm {
  return {
    engine: source.engine, host: source.host, dir: null, customPath: '', mode: 'carry',
    ...launchDefaults(source, source.engine),
    permissionMode: source.permissionMode ?? undefined,
    keepSource: false, message: '',
  };
}

/** Another engine: its own model list, so the model (and effort) go back to its defaults. */
export function withEngine(form: TransferForm, source: TransferSource, engine: string): Partial<TransferForm> {
  return engine === form.engine ? {} : { engine, ...launchDefaults(source, engine) };
}

export function effectiveDir(form: TransferForm, source: TransferSource): DirChoice {
  return form.dir ?? (form.host !== source.host ? 'auto' : 'same');
}

/** Why this engine cannot run on this host, or null. */
export function blockedReason(opts: TransferOptions, engine: string, host: string): string | null {
  return opts.options.find((o) => o.engine === engine && o.host === host)?.blockedReason ?? null;
}

export function engineName(opts: TransferOptions, id: string): string {
  return opts.engines.find((e) => e.id === id)?.displayName ?? id;
}

/** Why the Transfer button is off, or null when it can go. */
export function submitBlocker(opts: TransferOptions, form: TransferForm): string | null {
  const source = opts.source;
  if (!source) return 'This task has no conversation to move.';
  const blocked = blockedReason(opts, form.engine, form.host);
  if (blocked) return blocked;
  const dir = effectiveDir(form, source);
  const custom = form.customPath.trim();
  if (dir === 'custom' && !custom) return 'Enter a directory.';
  if (dir === 'custom' && !custom.startsWith('/') && !custom.startsWith('~')) return 'Use an absolute path.';
  const sameDir = dir === 'same' || (dir === 'custom' && custom === source.cwd);
  const sameModel = (form.model ?? '') === (launchDefaults(source, form.engine).model ?? '');
  if (form.engine === source.engine && form.host === source.host && sameDir && sameModel) {
    return 'Nothing would change. Pick another harness, model, host or directory.';
  }
  return null;
}

export function buildTransferBody(source: TransferSource, form: TransferForm): TransferBody {
  const dir = effectiveDir(form, source);
  const cwd = dir === 'auto' ? 'auto' : dir === 'custom' ? form.customPath.trim() : source.cwd ?? undefined;
  const message = form.message.trim();
  // Only what differs from the server's own default (launchDefaults is the same rule),
  // so an untouched dialog sends no launch fields at all.
  const defaults = launchDefaults(source, form.engine);
  return {
    engine: form.engine,
    host: form.host,
    ...(cwd ? { cwd } : {}),
    mode: form.mode,
    // 'default' says "the engine's default", which is not the same as saying nothing
    // when the default would have been the source session's model.
    ...((form.model ?? '') !== (defaults.model ?? '') ? { model: form.model || 'default' } : {}),
    ...(form.effort && form.effort !== defaults.effort ? { effort: form.effort } : {}),
    ...(form.permissionMode && form.permissionMode !== (source.permissionMode ?? undefined) ? { permission_mode: form.permissionMode } : {}),
    keep_source: form.keepSource,
    ...(message ? { message } : {}),
  };
}

/** One short line naming where the work runs now. */
export function sourceLine(opts: TransferOptions): string {
  const s = opts.source;
  if (!s) return '';
  return `Now: ${engineName(opts, s.engine)} on ${hostLabel(s.host, opts.hosts)}`;
}

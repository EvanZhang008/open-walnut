/**
 * The read-back through a trial server: the one check the leader switch's trial
 * (src/core/leader/switch/self-check.ts) and the restore drill's trial boot
 * (src/core/backup/restore-drill-boot.ts) share. A server started on a home in the boot
 * policy's trial column answers a task and a note through its API exactly as they are in the
 * home's files: the databases opened, their migrations ran, the notes folder resolves.
 */

/** One GET to the trial server. */
export type TrialApi = (method: 'GET', urlPath: string) => Promise<{ status: number; json: unknown }>;

export interface ReadBackNote {
  /** Home-relative path of the note file. */
  rel: string;
  /** Its path under the notes route (/api/notes-v2/content/<apiPath>). */
  apiPath: string;
}

/** The marker of a home whose notes moved into the one tree (src/core/artifacts/unify/migrate-unified.ts UNIFIED_FILE). */
const UNIFIED_MARKER = 'artifacts/.unified.json';

/**
 * A note to read back, from a home's file list (home-relative, '/'-separated): the first
 * Markdown file under the vault root, which is `artifacts/` once the notes moved into the one
 * tree (the marker is in the list) and `notes/` before.
 */
export function pickReadBackNote(files: readonly string[]): ReadBackNote | null {
  const root = files.includes(UNIFIED_MARKER) ? 'artifacts/' : 'notes/';
  const rel = files
    .filter((p) => p.startsWith(root) && p.endsWith('.md') && !p.split('/').some((s) => s.startsWith('.')))
    .sort()[0];
  return rel ? { rel, apiPath: rel.slice(root.length) } : null;
}

export interface ReadBackWant {
  task: { id: string; title: string } | null;
  note: (ReadBackNote & { content: string }) | null;
}

/** Read the task and the note back through the server; what did not come back as wanted, one line each. */
export async function readBackThroughServer(api: TrialApi, want: ReadBackWant): Promise<{ problems: string[]; read: string[] }> {
  const problems: string[] = [];
  const read: string[] = [];
  const get = (p: string) => api('GET', p).catch((err: unknown) => ({ status: 0, json: { error: String(err) } }));
  if (want.task) {
    const t = await get(`/api/tasks/${encodeURIComponent(want.task.id)}`);
    const body = t.json as { task?: { title?: string }; title?: string } | null;
    const got = body?.task?.title ?? body?.title;
    if (t.status !== 200 || got !== want.task.title) problems.push(`task ${want.task.id} did not read back (status ${t.status}, title ${JSON.stringify(got)})`);
    else read.push(`task "${want.task.title}" (${want.task.id})`);
  }
  if (want.note) {
    const n = await get(`/api/notes-v2/content/${want.note.apiPath.split('/').map(encodeURIComponent).join('/')}`);
    const content = (n.json as { content?: string } | null)?.content;
    if (n.status !== 200 || content !== want.note.content) problems.push(`note ${want.note.rel} did not read back as it is in the files (status ${n.status}${n.status === 200 ? ', other content' : ''})`);
    else read.push(`note ${want.note.rel}`);
  }
  return { problems, read };
}

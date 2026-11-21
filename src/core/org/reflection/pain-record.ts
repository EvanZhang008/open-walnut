/**
 * A finding with his words goes to the node's pain registry (pains.ts): to the pain the judge
 * matched, or as a new one, unowned until a rule and a guard test are written into it. The
 * pictures his message carried are copied next to the registry, named by their content, so a
 * screenshot outlives the temp folder it was saved in and two pictures never share one name.
 * Only pictures in Walnut's own places are copied (its images folder, a task directory, the node's
 * folder); any other path is kept as given.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Task } from '../../types.js';
import { IMAGES_DIR } from '../../../constants.js';
import { nodeArtifactsDir } from '../../artifacts/paths.js';
import { taskDirRoot } from '../../../lib/task-dir.js';
import type { Finding } from './judge.js';
import type { Candidate } from './candidates.js';
import type { DayRule } from './records.js';
import { parseCardAnswer } from './signals.js';
import { addComplaint, normalizePain, PAIN_IMAGES_REL, type PainEntry, type PainQuote } from './pains.js';
import { readPains, updatePains } from './pains-store.js';

/** A picture larger than this stays where it is (its path is kept). */
const IMAGE_COPY_MAX = 8 * 1024 * 1024;
/** Pictures one complaint, or one import, copies at most. */
const IMAGES_PER_QUOTE_MAX = 4;
const IMAGES_PER_IMPORT_MAX = 120;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic)$/i;

/** Where the registry says a rule is written, from what the finding became (relative to the node folder). Pure. */
export function ruleWhere(rule: DayRule): { where: string; text: string } | undefined {
  // A guidance line is named by its words: its number moves when an earlier line is deleted.
  if (rule.kind === 'guidance' || rule.kind === 'existing') return rule.text ? { where: 'guidance.md', text: rule.text } : undefined;
  if (rule.kind === 'skill' && rule.name) return { where: `org skill ${rule.name}`, text: rule.text };
  return undefined;
}

const inside = (p: string, root: string) => { const r = path.relative(root, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

/** The places a picture is copied from: Walnut's images folder, the task directories, the node's own folder. */
function copyRoots(nodeId: string): string[] {
  return [IMAGES_DIR, taskDirRoot(process.env, os.homedir()), nodeArtifactsDir(nodeId)];
}

/** One picture copied next to the registry by its content: its path there (relative), or the path it came with. */
async function keepImage(nodeId: string, src: string, budget: { left: number }): Promise<string> {
  if (!path.isAbsolute(src) || !IMAGE_EXT_RE.test(src)) return src;
  try {
    const real = await fsp.realpath(src);
    const roots = await Promise.all(copyRoots(nodeId).map((r) => fsp.realpath(r).catch(() => path.resolve(r))));
    if (!roots.some((r) => inside(real, r)) || budget.left <= 0) return src;
    const st = await fsp.stat(real);
    if (!st.isFile() || st.size > IMAGE_COPY_MAX) return src;
    const bytes = await fsp.readFile(real);
    const rel = path.join(PAIN_IMAGES_REL, `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${path.extname(real).toLowerCase()}`);
    const dest = path.join(nodeArtifactsDir(nodeId), rel);
    budget.left--;
    if (!(await fsp.stat(dest).then(() => true, () => false))) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, bytes);
    }
    return rel;
  } catch {
    return src;
  }
}

async function keepImages(nodeId: string, images: readonly string[] | undefined, budget: { left: number }): Promise<string[]> {
  const out: string[] = [];
  for (const src of (images ?? []).slice(0, IMAGES_PER_QUOTE_MAX)) out.push(await keepImage(nodeId, src, budget));
  return out;
}

/** File one finding's complaint. Only a finding the judge named a pain for: no pain, no complaint. */
export async function recordPain(node: Task, nodeName: string, c: Candidate, f: Finding, rule: DayRule, nowMs: number): Promise<{ id: string; title: string; isNew: boolean } | undefined> {
  const pain = f.pain;
  const m = c.messages[c.messages.length - 1];
  if (!pain || !m) return undefined;
  const images = await keepImages(node.id, c.messages.flatMap((x) => x.images ?? []), { left: IMAGES_PER_QUOTE_MAX });
  const quote: PainQuote = {
    at: m.at, text: parseCardAnswer(m.text)?.words ?? m.text, taskId: c.task.id, ...(c.thread ? { threadId: c.thread.id } : {}),
    ...(images.length ? { images } : {}),
  };
  let out = { id: '', title: pain.title, isNew: false };
  await updatePains(node.id, nodeName, (entries) => {
    const r = addComplaint(entries, {
      sameAs: pain.same_as, title: pain.title, scope: pain.scope, kind: f.kind, quote,
      rootCause: f.what_went_wrong, rule: ruleWhere(rule), owner: { taskId: c.task.id, title: c.task.title },
    });
    const e = r.entries.find((x) => x.id === r.id)!;
    out = { id: r.id, title: e.title, isNew: r.isNew };
    return r.entries;
  }, nowMs);
  return out;
}

/**
 * Pains written elsewhere (a first registry built from his past words) added to the node's: an id
 * already there is kept as it is, never overwritten, and its pictures are not copied again.
 */
export async function importPains(nodeId: string, nodeName: string, raw: readonly unknown[], nowMs: number): Promise<{ added: string[]; kept: string[]; refused: number }> {
  const read = raw.slice(0, 500).map(normalizePain);
  const have = new Set((await readPains(nodeId)).map((e) => e.id));
  const budget = { left: IMAGES_PER_IMPORT_MAX };
  const incoming: PainEntry[] = [];
  for (const e of read) {
    if (!e) continue;
    if (have.has(e.id)) { incoming.push(e); continue; }
    const quotes: PainQuote[] = [];
    for (const q of e.quotes) quotes.push({ ...q, ...(q.images?.length ? { images: await keepImages(nodeId, q.images, budget) } : {}) });
    incoming.push({ ...e, quotes });
  }
  const added: string[] = [];
  const kept: string[] = [];
  await updatePains(nodeId, nodeName, (entries) => {
    const out = [...entries];
    for (const e of incoming) {
      if (out.some((x) => x.id === e.id)) { kept.push(e.id); continue; }
      out.push(e);
      added.push(e.id);
    }
    return out;
  }, nowMs);
  return { added, kept, refused: read.filter((e) => !e).length };
}

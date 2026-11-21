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
import { addComplaint, normalizePain, PAIN_IMAGES_REL, type PainEntry, type PainQuote, type PainReport } from './pains.js';
import { readPainsFile, updatePains } from './pains-store.js';

/** Complaints found while the registry could not be read, one JSON line each: filed once it can be. */
export const painsPendingOf = (nodeId: string): string => path.join(nodeArtifactsDir(nodeId), 'pains-pending.jsonl');
const PENDING_MAX = 500;

/** How many complaints wait to be filed (the nightly note says it). */
export async function pendingCount(nodeId: string): Promise<number> {
  const text = await fsp.readFile(painsPendingOf(nodeId), 'utf-8').catch(() => '');
  return text.split('\n').filter((l) => l.trim()).length;
}

/** The waiting complaints, claimed (the file is renamed first, so none is filed twice), their pictures copied now. */
async function claimPending(nodeId: string): Promise<{ reports: PainReport[]; done: () => Promise<void>; undo: () => Promise<void> }> {
  const file = painsPendingOf(nodeId);
  const claimed = `${file}.${crypto.randomBytes(6).toString('hex')}.claimed`;
  const none = { reports: [], done: async () => {}, undo: async () => {} };
  if (!(await fsp.rename(file, claimed).then(() => true, () => false))) return none;
  const reports: PainReport[] = [];
  for (const line of (await fsp.readFile(claimed, 'utf-8').catch(() => '')).split('\n')) {
    try {
      const r = JSON.parse(line) as PainReport;
      if (r?.quote?.at && r.quote.text && r.title) reports.push({ ...r, quote: { ...r.quote, ...(r.quote.images?.length ? { images: await keepImages(nodeId, r.quote.images, { left: IMAGES_PER_QUOTE_MAX }) } : {}) } });
    } catch { /* a line that does not parse is no complaint */ }
  }
  return {
    reports,
    done: () => fsp.rm(claimed, { force: true }),
    // Not filed after all: back where they wait, ahead of any that came meanwhile.
    undo: async () => {
      const later = await fsp.readFile(file, 'utf-8').catch(() => '');
      await fsp.writeFile(file, (await fsp.readFile(claimed, 'utf-8').catch(() => '')) + later);
      await fsp.rm(claimed, { force: true });
    },
  };
}

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
export async function recordPain(node: Task, nodeName: string, c: Candidate, f: Finding, rule: DayRule, nowMs: number): Promise<{ id: string; title: string; isNew: boolean } | { pending: true; title: string } | undefined> {
  const pain = f.pain;
  const m = c.messages[c.messages.length - 1];
  if (!pain || !m) return undefined;
  const report = (quote: PainQuote): PainReport => ({
    sameAs: pain.same_as, title: pain.title, scope: pain.scope, kind: f.kind, quote,
    rootCause: f.what_went_wrong, rule: ruleWhere(rule), owner: { taskId: c.task.id, title: c.task.title },
  });
  const quote: PainQuote = {
    at: m.at, text: parseCardAnswer(m.text)?.words ?? m.text, taskId: c.task.id, ...(c.thread ? { threadId: c.thread.id } : {}),
  };
  const images = c.messages.flatMap((x) => x.images ?? []);
  // A registry that cannot be read is never written over: the complaint waits (its pictures as they
  // were sent) and is filed by the first write that can.
  if ((await readPainsFile(node.id)).state === 'bad') {
    await fsp.mkdir(path.dirname(painsPendingOf(node.id)), { recursive: true });
    if ((await pendingCount(node.id)) < PENDING_MAX) await fsp.appendFile(painsPendingOf(node.id), `${JSON.stringify(report({ ...quote, ...(images.length ? { images: images.slice(0, IMAGES_PER_QUOTE_MAX) } : {}) }))}\n`);
    return { pending: true, title: pain.title };
  }
  const kept = await keepImages(node.id, images, { left: IMAGES_PER_QUOTE_MAX });
  const pending = await claimPending(node.id);
  let out = { id: '', title: pain.title, isNew: false };
  try {
    await updatePains(node.id, nodeName, (entries) => {
      let all = entries;
      for (const r of pending.reports) all = addComplaint(all, { ...r, sameAs: r.sameAs && all.some((e) => e.id === r.sameAs) ? r.sameAs : '' }).entries;
      const r = addComplaint(all, report({ ...quote, ...(kept.length ? { images: kept } : {}) }));
      const e = r.entries.find((x) => x.id === r.id)!;
      out = { id: r.id, title: e.title, isNew: r.isNew };
      return r.entries;
    }, nowMs);
  } catch (err) {
    await pending.undo();
    throw err;
  }
  await pending.done();
  return out;
}

/**
 * Pains written elsewhere (a first registry built from his past words) added to the node's: an id
 * already there is kept as it is, never overwritten, and its pictures are not copied again.
 */
export async function importPains(nodeId: string, nodeName: string, raw: readonly unknown[], nowMs: number): Promise<{ added: string[]; kept: string[]; refused: number }> {
  const read = raw.slice(0, 500).map(normalizePain);
  const file = await readPainsFile(nodeId);
  // Refused before any picture is copied: a registry that cannot be read is never written over.
  if (file.state === 'bad') await updatePains(nodeId, nodeName, (e) => e, nowMs);
  const have = new Set((file.state === 'ok' ? file.entries : []).map((e) => e.id));
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

/**
 * A finding with his words goes to the node's pain registry (pains.ts): to the pain the judge
 * matched, or as a new one, unowned until a rule and a guard test are written into it. The
 * pictures his message carried are copied next to the registry, so a screenshot outlives the temp
 * folder it was saved in.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../../types.js';
import { nodeArtifactsDir } from '../../artifacts/paths.js';
import type { Finding } from './judge.js';
import type { Candidate } from './candidates.js';
import type { DayRule } from './records.js';
import { parseCardAnswer } from './signals.js';
import { addComplaint, normalizePain, updatePains, type PainEntry, type PainQuote } from './pains.js';

/** A picture larger than this stays where it is (its path is kept). */
const IMAGE_COPY_MAX = 8 * 1024 * 1024;
const IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|gif|webp|heic)$/i;

export const painImagesDirOf = (nodeId: string): string => path.join(nodeArtifactsDir(nodeId), 'pains-images');

/** Where the registry says a rule is written, from what the finding became. Pure. */
export function ruleWhere(nodeId: string, rule: DayRule): { where: string; text: string } | undefined {
  if (rule.kind === 'guidance' || rule.kind === 'existing') return rule.line ? { where: `${path.join(nodeArtifactsDir(nodeId), 'guidance.md')} line ${rule.line}`, text: rule.text } : undefined;
  if (rule.kind === 'skill' && rule.name) return { where: `org skill ${rule.name}`, text: rule.text };
  return undefined;
}

/** Each picture copied next to the registry (its new path), or its own path when it cannot be. */
async function keepImages(nodeId: string, images: readonly string[] | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const src of (images ?? []).slice(0, 4)) {
    const name = path.basename(src);
    const dest = path.join(painImagesDirOf(nodeId), name);
    try {
      if (!IMAGE_NAME_RE.test(name) || !path.isAbsolute(src)) throw new Error('not a picture path');
      const st = await fsp.stat(src);
      if (!st.isFile() || st.size > IMAGE_COPY_MAX) throw new Error('not copied');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      out.push(dest);
    } catch {
      // Already copied by an earlier complaint, or gone: the copy if it is there, else the path he sent.
      out.push(await fsp.stat(dest).then(() => dest, () => src));
    }
  }
  return out;
}

export async function recordPain(node: Task, nodeName: string, c: Candidate, f: Finding, rule: DayRule, nowMs: number): Promise<{ id: string; title: string; isNew: boolean }> {
  const m = c.messages[c.messages.length - 1];
  const images = await keepImages(node.id, c.messages.flatMap((x) => x.images ?? []));
  const quote: PainQuote = {
    at: m.at, text: parseCardAnswer(m.text)?.words ?? m.text, taskId: c.task.id, ...(c.thread ? { threadId: c.thread.id } : {}),
    ...(images.length ? { images } : {}),
  };
  const title = f.pain?.title || f.what_went_wrong.split(/(?<=[.!?。])\s*/)[0].slice(0, 120);
  let out = { id: '', title, isNew: false };
  await updatePains(node.id, nodeName, (entries) => {
    const r = addComplaint(entries, {
      sameAs: f.pain?.same_as ?? '', title, scope: f.pain?.scope ?? 'all_users', kind: f.kind, quote,
      rootCause: f.what_went_wrong, rule: ruleWhere(node.id, rule), owner: { taskId: c.task.id, title: c.task.title },
    });
    const e = r.entries.find((x) => x.id === r.id)!;
    out = { id: r.id, title: e.title, isNew: r.isNew };
    return r.entries;
  }, nowMs);
  return out;
}

/**
 * Pains written elsewhere (a first registry built from his past words) added to the node's: an id
 * already there is kept as it is, never overwritten; each picture is copied next to the registry.
 */
export async function importPains(nodeId: string, nodeName: string, raw: readonly unknown[], nowMs: number): Promise<{ added: string[]; kept: string[]; refused: number }> {
  const read = raw.slice(0, 500).map(normalizePain);
  const incoming: PainEntry[] = [];
  for (const e of read) {
    if (!e) continue;
    const quotes = [];
    for (const q of e.quotes) quotes.push({ ...q, ...(q.images?.length ? { images: await keepImages(nodeId, q.images) } : {}) });
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
